import { test, expect, _electron as electron, type Page } from "@playwright/test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database } from "../../src/main/database";
import { extractPdfText } from "../../src/main/pdf-text";
import { QuestionBank } from "../../src/main/question-bank";
import type { QuestionContent } from "../../src/shared/question";
import { paragraph } from "../unit/fixtures/questions";

const entry = path.resolve(".vite/build/main.cjs");
const fixture = path.resolve("tests/fixtures/two-pages.pdf");

async function closeApp(app: Awaited<ReturnType<typeof electron.launch>>) {
  await app.evaluate(({ app: electronApp }) => { electronApp.exit(0); }).catch(() => undefined);
  await app.close().catch(() => undefined);
}

async function dragOnPage(page: Page) {
  const view = page.locator(".intake-page-view");
  await view.scrollIntoViewIfNeeded();
  const box = await view.boundingBox();
  if (!box) throw new Error("原卷页面未显示");
  const startX = box.x + box.width * 0.35;
  const startY = box.y + Math.min(90, box.height * 0.18);
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.64, startY + Math.min(120, box.height * 0.24), { steps: 6 });
  await page.mouse.up();
}

async function importExam(page: Page, app: Awaited<ReturnType<typeof electron.launch>>) {
  await page.getByRole("button", { name: "考试原卷" }).click();
  await page.getByLabel("考试标题").fill("九年级数学单元卷");
  await page.getByLabel("学年").fill("2026");
  await page.getByLabel("来源").fill("自制样题");
  await app.evaluate(({ dialog }, target) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] });
  }, fixture);
  await page.getByRole("button", { name: "选择原卷并导入" }).click();
  await expect(page.getByText("已导入「九年级数学单元卷」。", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "进入录题" }).click();
  await expect(page.getByRole("region", { name: "原卷预览" })).toBeVisible();
  await expect(page.getByAltText("原卷第 1 页")).toBeVisible({ timeout: 15000 });
}

function sharedMaterialContent(materialId: string, versionId: string, stem: string, originalNumber: string): QuestionContent {
  return {
    stem: [paragraph(stem)],
    subQuestions: [{
      id: "sub-1",
      originalLabel: "(1)",
      prompt: [paragraph("结合材料作答。")],
      explanation: [],
      options: [],
      slots: [{ id: "slot-1", label: "答案", kind: "text", required: true, interchangeableWith: [] }],
      answers: [{ slotId: "slot-1", blocks: [paragraph("参考答案")], variants: [] }],
      scoring: [{ id: "score-1", description: "回答正确", score: 4, slotIds: ["slot-1"] }],
      originalScore: 4,
      materialIds: [materialId],
      dependsOn: [],
    }],
    materials: [{ materialId, versionId }],
    selection: { mode: "all" },
    source: { section: "语文·阅读", pdfPage: 3, originalNumber },
  };
}

/** 丙题为三小问链式依赖：第 (1) 问直接引用材料，第 (2)(3) 问沿前问间接受影响。 */
function chainedMaterialContent(materialId: string, versionId: string): QuestionContent {
  const content = sharedMaterialContent(materialId, versionId, "丙题题干", "3");
  const base = content.subQuestions[0];
  const sub = (id: string, label: string, dependsOn: string[], materialIds: string[]) => ({
    ...structuredClone(base),
    id,
    originalLabel: label,
    dependsOn,
    materialIds,
  });
  content.subQuestions = [
    sub("sub-1", "(1)", [], [materialId]),
    sub("sub-2", "(2)", ["sub-1"], []),
    sub("sub-3", "(3)", ["sub-2"], []),
  ];
  return content;
}

/** 一份已审核材料被三道题引用；甲题待核，乙、丙题已审核。 */
function seedSharedMaterial(dir: string): void {
  const db = new Database(path.join(dir, "paperweave.sqlite"));
  const bank = new QuestionBank(db);
  const material = bank.createMaterial({ title: "共享材料", content: [paragraph("材料原文")], source: "自制样题" });
  bank.setMaterialStatus(material.id, "pending");
  bank.setMaterialStatus(material.id, "approved");
  const versions = ["甲题题干", "乙题题干", "丙题题干"].map((stem, index) => {
    const content = index === 2
      ? chainedMaterialContent(material.materialId, material.id)
      : sharedMaterialContent(material.materialId, material.id, stem, String(index + 1));
    const version = bank.createQuestion(content);
    bank.setClassification(version.questionId, {
      stage: "初中",
      subject: "语文",
      grade: "九年级",
      examType: "单元测",
      year: "2026",
      sourceName: "自制样题",
      questionType: "阅读题",
      knowledgePoints: ["材料阅读"],
    });
    bank.setContentStatus(version.id, "pending");
    if (index > 0) bank.setContentStatus(version.id, "approved");
    bank.setAnswerStatus(version.id, "pending");
    bank.setAnswerStatus(version.id, "approved");
    return version;
  });
  expect(versions).toHaveLength(3);
  db.close();
}

test("材料改版列出受影响题并逐题采用新版", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "paperweave-material-"));
  seedSharedMaterial(dir);
  const app = await electron.launch({ args: [entry, `--user-data-dir=${dir}`] });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "题目审核" }).click();
    const card = page.locator(".paper-card", { hasText: "甲题题干" });
    await expect(card).toBeVisible();
    await card.getByRole("button", { name: "查看并审核" }).click();
    const detail = page.getByRole("region", { name: "题目审核详情" });
    await expect(detail).toBeVisible();

    await detail.getByRole("button", { name: "编辑材料" }).click();
    await page.getByLabel("材料正文").fill("材料修订版");
    await detail.getByRole("button", { name: "保存为新版本" }).click();
    await expect(page.getByText(/材料第 2 版已保存/)).toBeVisible();
    const affected = detail.locator(".review-affected");
    await expect(affected.locator("li")).toHaveCount(3);
    await expect(affected).toContainText("原卷第 3 页 题 2 · 题目第 1 版 · 材料第 1 版");
    const chained = affected.locator("li", { hasText: "题 3 ·" });
    await expect(chained).toContainText("直接受影响：(1)");
    await expect(chained).toContainText("间接受影响：(2)（经由 (1)）；(3)（经由 (2)）");

    await affected.locator("li", { hasText: "题 2 ·" }).getByRole("button", { name: /采用新版/ }).click();
    await expect(page.getByText(/已采用材料第 2 版；题目第 2 版回到待核。/)).toBeVisible();
    await expect(affected.locator("li")).toHaveCount(2);
    await expect(affected.locator("li", { hasText: "题 3 ·" })).toContainText("题目第 1 版");
    await expect(page.locator(".paper-card", { hasText: "乙题题干" })).toBeVisible();
  } finally {
    await closeApp(app);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("录入小问与图引用，组卷后按卷内编号解析且学生卷无答案", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "paperweave-reference-"));
  const outDir = mkdtempSync(path.join(tmpdir(), "paperweave-reference-out-"));
  const app = await electron.launch({ args: [entry, `--user-data-dir=${dir}`] });
  try {
    const page = await app.firstWindow();
    await importExam(page, app);
    await app.evaluate(({ dialog, shell }, target) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] });
      shell.openPath = async () => "";
    }, outDir);

    await page.getByLabel("原卷页码", { exact: true }).fill("2");
    await page.getByLabel("原题号").fill("2");
    await page.getByLabel("知识点（逗号分隔）").fill("阅读理解");
    await page.getByLabel("题干 文字 1", { exact: true }).fill("合成题：引用检查。");
    const firstPrompt = page.getByRole("group", { name: "小问 1 题干" });
    await firstPrompt.getByLabel("小问 1 题干 文字 1", { exact: true }).fill("观察图形。");
    await firstPrompt.getByRole("button", { name: "插入裁图" }).click();
    await dragOnPage(page);
    await expect(page.getByText("裁图已插入当前编辑目标。", { exact: true })).toBeVisible();
    await firstPrompt.getByLabel("小问 1 题干 图标识 2").fill("fig-a");
    await page.getByRole("group", { name: "小问 1 答案" }).getByRole("button", { name: "添加文字" }).click();
    await page.getByLabel("小问 1 答案 文字 1", { exact: true }).fill("答案一");

    await page.getByRole("button", { name: "添加小问" }).click();
    const secondSub = page.getByRole("group", { name: "小问 2", exact: true });
    await secondSub.getByLabel("小问号").fill("(2)");
    await secondSub.getByLabel("原分值").fill("6");
    await secondSub.getByRole("group", { name: "小问 2 答案" }).getByRole("button", { name: "添加文字" }).click();
    await page.getByLabel("小问 2 答案 文字 1", { exact: true }).fill("答案二");

    const secondPrompt = page.getByRole("group", { name: "小问 2 题干" });
    await secondPrompt.getByLabel("小问 2 题干 文字 1", { exact: true }).fill("结合");
    await secondPrompt.getByLabel("小问 2 题干 引用目标").selectOption({ label: "小问：(1)" });
    await secondPrompt.getByRole("button", { name: "插入引用" }).click();
    await secondPrompt.getByLabel("小问 2 题干 引用回退 2").fill("旧小问号");
    await secondPrompt.getByLabel("小问 2 题干 引用目标").selectOption({ value: "figure:fig-a" });
    await secondPrompt.getByRole("button", { name: "插入引用" }).click();
    await secondPrompt.getByLabel("小问 2 题干 引用回退 3").fill("旧图号");
    await secondPrompt.getByRole("button", { name: "添加文字" }).click();
    await secondPrompt.getByLabel("小问 2 题干 文字 4", { exact: true }).fill("作答。");

    await page.getByRole("button", { name: "提交待核" }).click();
    await expect(page.getByText("已提交待核（版本 1）。", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "返回考试原卷" }).click();
    await page.getByRole("button", { name: "返回录题草稿" }).click();
    await page.getByRole("button", { name: "题目审核" }).click();
    const card = page.locator(".paper-card", { hasText: "合成题：引用检查。" });
    await card.getByRole("button", { name: "查看并审核" }).click();
    const detail = page.getByRole("region", { name: "题目审核详情" });
    await detail.getByRole("button", { name: "通过内容审核" }).click();
    await expect(page.getByText("内容已通过审核。", { exact: true })).toBeVisible();
    await detail.getByRole("button", { name: "通过答案审核" }).click();
    await expect(page.getByText("答案与评分已通过审核。", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "去题库与组卷" }).click();
    const result = page.locator(".paper-card", { hasText: "合成题：引用检查。" });
    await result.getByRole("button", { name: "整题入篮" }).click();
    await page.getByLabel("标题", { exact: true }).fill("引用解析卷");
    await page.getByRole("button", { name: "创建试卷" }).click();
    await page.getByRole("button", { name: "添加小节" }).click();
    await page.getByRole("region", { name: "题篮" }).getByRole("button", { name: "加入试卷" }).click();
    await page.getByRole("button", { name: "检查定稿" }).click();
    await expect(page.getByText("定稿检查通过。", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "生成学生卷与教师答案卷" }).click();
    const confirm = page.getByRole("dialog", { name: "确认定稿" });
    await expect(confirm).toBeVisible({ timeout: 30000 });
    await confirm.getByRole("button", { name: "确认保存为定稿" }).click();
    await expect(page.getByText(/双卷已保存为定稿/)).toBeVisible({ timeout: 30000 });

    const directories = readdirSync(outDir).filter((name) => name.startsWith("拾题成卷-样张-"));
    expect(directories).toHaveLength(1);
    const student = readFileSync(path.join(outDir, directories[0], "学生卷.pdf"));
    const teacher = readFileSync(path.join(outDir, directories[0], "教师答案卷.pdf"));
    const studentText = (await extractPdfText(new Uint8Array(student))).pages.map((entry) => entry.text).join("\n").normalize("NFKC");
    const teacherText = (await extractPdfText(new Uint8Array(teacher))).pages.map((entry) => entry.text).join("\n").normalize("NFKC");

    expect(studentText).toContain("结合");
    expect(studentText).toContain("图 1");
    expect(studentText).not.toContain("旧小问号");
    expect(studentText).not.toContain("旧图号");
    expect(studentText).not.toContain("答案一");
    expect(studentText).not.toContain("答案二");
    expect(teacherText).toContain("答案一");
    expect(teacherText).toContain("答案二");
    expect(teacherText).not.toContain("旧小问号");
    expect(teacherText).not.toContain("旧图号");
  } finally {
    await closeApp(app);
    rmSync(dir, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("录题提交待核后完整审核公式、题图与标签，再进入新卷", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "paperweave-review-"));
  const outDir = mkdtempSync(path.join(tmpdir(), "paperweave-review-out-"));
  const app = await electron.launch({ args: [entry, `--user-data-dir=${dir}`] });
  try {
    const page = await app.firstWindow();
    await importExam(page, app);
    await app.evaluate(({ dialog, shell }, target) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] });
      shell.openPath = async () => "";
    }, outDir);

    await page.getByLabel("原卷页码", { exact: true }).fill("2");
    await page.getByLabel("原题号").fill("1");
    await page.getByLabel("知识点（逗号分隔）").fill("一元二次方程");
    await page.getByLabel("题干 文字 1", { exact: true }).fill("合成题：观察下图。");
    await page.getByLabel("小问 1 题干 文字 1", { exact: true }).fill("求 $x^2$ 的值。");
    await page.getByLabel("小问号").fill("(1)");
    await page.getByLabel("原分值").fill("4");
    const slotGroup = page.getByRole("group", { name: "小问 1 作答位置" });
    await slotGroup.getByRole("button", { name: "添加空位" }).click();
    await slotGroup.getByRole("button", { name: "添加空位" }).click();
    await page.getByLabel("空位 1 标签").fill("方程空");
    await page.getByLabel("空位 2 标签").fill("结果空");
    await page.getByLabel("空位 1 与空位 2 互换").check();
    const firstSlotAnswer = page.getByRole("group", { name: "小问 1 空位 1 答案" });
    await firstSlotAnswer.getByRole("button", { name: "添加文字" }).click();
    await page.getByLabel("小问 1 空位 1 答案 文字 1", { exact: true }).fill("答案甲内容");
    const secondSlotAnswer = page.getByRole("group", { name: "小问 1 空位 2 答案" });
    await secondSlotAnswer.getByRole("button", { name: "添加文字" }).click();
    await page.getByLabel("小问 1 空位 2 答案 文字 1", { exact: true }).fill("答案乙内容");
    const answerGroup = page.getByRole("group", { name: "小问 1 答案" });
    await answerGroup.getByRole("button", { name: "添加文字" }).click();
    await page.getByLabel("小问 1 答案 文字 1", { exact: true }).fill("4");
    const scoringGroup = page.getByRole("group", { name: "小问 1 评分点" });
    await scoringGroup.getByRole("button", { name: "添加评分点" }).click();
    await scoringGroup.getByLabel("说明").fill("答案正确");
    await scoringGroup.getByLabel("分值").fill("4");
    await scoringGroup.getByLabel("评分点 1 关联空位 1").check();
    await scoringGroup.getByLabel("评分点 1 关联空位 2").check();
    const promptGroup = page.getByRole("group", { name: "小问 1 题干" });
    await promptGroup.getByRole("button", { name: "插入裁图" }).click();
    await dragOnPage(page);
    await expect(page.getByText("裁图已插入当前编辑目标。", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "提交待核" }).click();
    await expect(page.getByText("已提交待核（版本 1）。", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "返回考试原卷" }).click();
    await page.getByRole("button", { name: "返回录题草稿" }).click();
    await page.getByRole("button", { name: "题目审核" }).click();
    await expect(page.getByRole("heading", { name: "题目审核" })).toBeVisible();
    const card = page.locator(".paper-card", { hasText: "合成题：观察下图。" });
    await expect(card).toContainText("内容待核");
    await expect(card).toContainText("答案待核");
    await card.getByRole("button", { name: "查看并审核" }).click();
    const detail = page.getByRole("region", { name: "题目审核详情" });
    await expect(detail).toBeVisible();
    await expect(detail.locator(".katex").first()).toBeVisible();
    await expect(detail.locator(".review-blocks img")).toBeVisible();
    await expect(detail).toContainText("原卷第 2 页 · 题 1");
    await expect(detail).toContainText("一元二次方程");

    await page.getByLabel("审核知识点").fill("一元二次方程，判别式");
    await page.getByRole("button", { name: "保存分类标签" }).click();
    await expect(page.getByText("分类标签已保存。", { exact: true })).toBeVisible();
    await expect(detail).toContainText("判别式");

    await detail.getByRole("button", { name: "通过内容审核" }).click();
    await expect(page.getByText("内容已通过审核。", { exact: true })).toBeVisible();
    await expect(detail).toContainText("内容已审核");
    await detail.getByRole("button", { name: "通过答案审核" }).click();
    await expect(page.getByText("答案与评分已通过审核。", { exact: true })).toBeVisible();
    await expect(detail).toContainText("答案已审核");

    await page.getByRole("button", { name: "去题库与组卷" }).click();
    const result = page.locator(".paper-card", { hasText: "合成题：观察下图。" });
    await expect(result).toBeVisible();
    await result.getByRole("button", { name: "整题入篮" }).click();
    await expect(page.getByText("已加入题篮。", { exact: true })).toBeVisible();
    await page.getByLabel("标题", { exact: true }).fill("审核集成卷");
    await page.getByRole("button", { name: "创建试卷" }).click();
    await page.getByRole("button", { name: "添加小节" }).click();
    await page.getByRole("region", { name: "题篮" }).getByRole("button", { name: "加入试卷" }).click();
    await expect(page.getByText("总分 4 分")).toBeVisible();
    await page.locator("article.paper-item-edit").locator(".paper-conflict", { hasText: "文字引用「下图」" }).getByRole("button", { name: "确认已核对" }).click();
    await expect(page.getByText("待核项已确认。")).toBeVisible();
    await page.getByRole("button", { name: "检查定稿" }).click();
    await expect(page.getByText("定稿检查通过。", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "生成学生卷与教师答案卷" }).click();
    const confirm = page.getByRole("dialog", { name: "确认定稿" });
    await expect(confirm).toBeVisible({ timeout: 30000 });
    await confirm.getByRole("button", { name: "确认保存为定稿" }).click();
    await expect(page.getByText(/双卷已保存为定稿/)).toBeVisible({ timeout: 30000 });

    const directories = readdirSync(outDir).filter((name) => name.startsWith("拾题成卷-样张-"));
    expect(directories).toHaveLength(1);
    const student = readFileSync(path.join(outDir, directories[0], "学生卷.pdf"));
    const teacher = readFileSync(path.join(outDir, directories[0], "教师答案卷.pdf"));
    const studentText = (await extractPdfText(new Uint8Array(student))).pages.map((entry) => entry.text).join("\n").normalize("NFKC");
    const teacherText = (await extractPdfText(new Uint8Array(teacher))).pages.map((entry) => entry.text).join("\n").normalize("NFKC");
    expect(studentText).toContain("作答位置");
    expect(studentText).toContain("方程空");
    expect(studentText).toContain("结果空");
    expect(studentText).not.toContain("答案甲内容");
    expect(studentText).not.toContain("答案乙内容");
    expect(teacherText).toContain("方程空");
    expect(teacherText).toContain("答案甲内容");
    expect(teacherText).toContain("答案乙内容");
  } finally {
    await closeApp(app);
    rmSync(dir, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});
