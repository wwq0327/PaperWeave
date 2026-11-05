import { test, expect, _electron as electron, type Page } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database } from "../../src/main/database";
import { QuestionBank } from "../../src/main/question-bank";
import { note } from "../unit/fixtures/questions";

const entry = path.resolve(".vite/build/main.cjs");
const fixture = path.resolve("tests/fixtures/two-pages.pdf");

/** 预置本科目已有标签，AI 固定响应中的同名词应直接并入知识点。 */
function seedTagCandidates(dir: string) {
  const db = new Database(path.join(dir, "paperweave.sqlite"));
  const bank = new QuestionBank(db);
  const created = bank.createQuestion(note());
  bank.setClassification(created.questionId, {
    stage: "初中",
    subject: "语文",
    grade: "九年级",
    examType: "单元测",
    year: "2026",
    sourceName: "自制样题",
    questionType: "选择题",
    knowledgePoints: ["词语运用", "阅读理解"],
  });
  db.close();
}

async function closeApp(app: Awaited<ReturnType<typeof electron.launch>>) {
  await app.evaluate(({ app: electronApp }) => { electronApp.exit(0); }).catch(() => undefined);
  await app.close().catch(() => undefined);
}

async function dragOnPage(page: Page) {
  const view = page.locator(".intake-page-view");
  await view.scrollIntoViewIfNeeded();
  const box = await view.boundingBox();
  if (!box) throw new Error("原卷页面未显示");
  const startX = box.x + box.width * 0.12;
  const startY = box.y + Math.min(90, box.height * 0.18);
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.88, startY + Math.min(170, box.height * 0.32), { steps: 6 });
  await page.mouse.up();
}

async function importExam(page: Page, app: Awaited<ReturnType<typeof electron.launch>>) {
  await page.getByRole("button", { name: "考试原卷" }).click();
  await page.getByLabel("考试标题").fill("九年级数学单元卷");
  await page.getByLabel("学科").fill("语文");
  await page.getByLabel("学年").fill("2026");
  await page.getByLabel("来源").fill("自制样题");
  await app.evaluate(({ dialog }, target) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] });
  }, fixture);
  await page.getByRole("button", { name: "选择 PDF 并导入" }).click();
  await expect(page.getByText("已导入「九年级数学单元卷」。", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "进入录题" }).click();
  await expect(page.getByRole("region", { name: "原卷预览" })).toBeVisible();
  await expect(page.getByAltText("原卷第 1 页")).toBeVisible({ timeout: 15000 });
}

test("录题页读取本卷文字生成结构化 AI 草稿，待核确认后采纳并保存", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "paperweave-intake-ai-text-"));
  seedTagCandidates(dir);
  const app = await electron.launch({ args: [entry, `--user-data-dir=${dir}`], env: { ...process.env, PAPERWEAVE_AI_FAKE: "ok" } });
  try {
    const page = await app.firstWindow();
    await importExam(page, app);
    await page.getByRole("button", { name: "展开" }).click();
    await page.getByRole("tab", { name: "文字输入" }).click();
    await page.getByRole("button", { name: "读取本卷文字" }).click();
    await expect(page.getByText("已读取本卷 2 页文字，可修改或勾选页码后确认发送。", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "确认发送" }).click();
    const confirmation = page.getByRole("region", { name: "确认发送" });
    await expect(confirmation).toContainText("第 1、2 页文字");
    await confirmation.getByRole("button", { name: "确认发送给模型" }).click();
    await expect(page.getByText("AI 草稿已生成，请逐题对照原卷核对后采纳。", { exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "AI 草稿结果" })).toContainText("固定响应：下列句子中加点词语使用正确的一项是");

    const first = page.locator(".ai-question").first();
    await expect(first).toContainText("AI 第 1 题 · 原卷第 1 页 · 题 1");
    await expect(first).toContainText("待核：固定响应待核点：原卷加点字无法确认");
    await first.getByRole("button", { name: "采纳到当前表单" }).click();
    await expect(page.getByText("已采纳 AI 第 1 题到表单，请核对并处理待核项后保存。", { exact: true })).toBeVisible();
    await expect(page.getByLabel("小问 1 题干 文字 1", { exact: true })).toHaveValue("固定响应小问：选择正确项。");
    await expect(page.getByLabel("小问号")).toHaveValue("(1)");
    await expect(page.getByLabel("原分值")).toHaveValue("3");
    await expect(page.getByLabel("知识点（逗号分隔）")).toHaveValue("词语运用");
    await expect(page.getByLabel("原题号")).toHaveValue("1");

    await expect(page.getByRole("region", { name: "AI 待核项" })).toContainText("固定响应待核点：原卷加点字无法确认");
    await expect(page.getByRole("region", { name: "AI 待核项" })).toContainText("作答位置需手工录入");

    // 候选标签直接并入；候选外的「初中语文」需教师确认后才写入。
    const newTags = page.getByRole("region", { name: "AI 建议新标签" });
    await expect(newTags).toContainText("初中语文");
    await newTags.getByRole("button", { name: "采用标签" }).click();
    await expect(page.getByLabel("知识点（逗号分隔）")).toHaveValue("词语运用，初中语文");
    const saveSection = page.getByRole("region", { name: "保存" });
    await saveSection.getByRole("button", { name: "提交待核" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "AI 待核项尚未确认" })).toBeVisible();
    await page.getByLabel("我已核对 AI 待核项").check();

    const materialSuggestion = page.getByRole("region", { name: "AI 建议材料" });
    await expect(materialSuggestion).toContainText("固定响应材料");
    await materialSuggestion.getByRole("button", { name: "建立材料草稿并关联" }).click();
    await expect(page.getByText("材料「固定响应材料」已建立草稿并关联到本题，请在材料区审核。", { exact: true })).toBeVisible();

    await saveSection.getByRole("button", { name: "提交待核" }).click();
    await expect(page.getByText("已提交待核（版本 1）。", { exact: true })).toBeVisible();
    await expect(page.locator("section[aria-label='本卷题目']")).toContainText("固定响应：下列句子中加点词语使用正确的一项是");
  } finally {
    await closeApp(app);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("裁图输入生成 AI 草稿；采纳覆盖当前表单前需确认", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "paperweave-intake-ai-image-"));
  const app = await electron.launch({ args: [entry, `--user-data-dir=${dir}`], env: { ...process.env, PAPERWEAVE_AI_FAKE: "ok" } });
  try {
    const page = await app.firstWindow();
    await importExam(page, app);
    await page.getByLabel("题干 文字 1", { exact: true }).fill("手工内容不能被静默覆盖。");
    await page.getByRole("button", { name: "展开" }).click();
    await page.getByRole("button", { name: "添加选区" }).click();
    await dragOnPage(page);
    await expect(page.getByText("已添加第 1 页 AI 选区，共 1 张。", { exact: true })).toBeVisible();
    await expect(page.getByAltText("AI 裁图 1")).toBeVisible();
    await page.getByRole("button", { name: "确认发送" }).click();
    const confirmation = page.getByRole("region", { name: "确认发送" });
    await expect(confirmation).toContainText("1 张裁图，页码 1");
    await confirmation.getByRole("button", { name: "确认发送给模型" }).click();
    await expect(page.getByText("AI 草稿已生成，请逐题对照原卷核对后采纳。", { exact: true })).toBeVisible();

    const first = page.locator(".ai-question").first();
    await first.getByRole("button", { name: "采纳到当前表单" }).click();
    const overwrite = page.getByRole("alertdialog", { name: "覆盖当前表单" });
    await expect(overwrite).toBeVisible();
    await overwrite.getByRole("button", { name: "取消" }).click();
    await expect(page.getByLabel("题干 文字 1", { exact: true })).toHaveValue("手工内容不能被静默覆盖。");

    await first.getByRole("button", { name: "采纳到当前表单" }).click();
    await overwrite.getByRole("button", { name: "覆盖并采纳" }).click();
    await expect(page.getByLabel("题干 文字 1", { exact: true })).toHaveValue("固定响应：下列句子中加点词语使用正确的一项是");
    await expect(page.getByRole("region", { name: "AI 待核项" })).toContainText("固定响应待核点：原卷加点字无法确认");
  } finally {
    await closeApp(app);
    rmSync(dir, { recursive: true, force: true });
  }
});
