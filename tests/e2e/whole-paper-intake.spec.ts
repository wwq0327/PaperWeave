import { test, expect, _electron as electron, type Page } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database } from "../../src/main/database";
import { ExamStore } from "../../src/main/exams";
import { Intake } from "../../src/main/intake";
import { QuestionBank } from "../../src/main/question-bank";
import { note } from "../unit/fixtures/questions";

const entry = path.resolve(".vite/build/main.cjs");
const fixture = path.resolve("tests/fixtures/two-pages.pdf");

async function closeApp(app: Awaited<ReturnType<typeof electron.launch>>) {
  await app.evaluate(({ app: electronApp }) => { electronApp.exit(0); }).catch(() => undefined);
  await app.close().catch(() => undefined);
}

async function importExam(page: Page, app: Awaited<ReturnType<typeof electron.launch>>) {
  await page.getByRole("button", { name: "考试原卷" }).click();
  await page.getByLabel("考试标题").fill("九年级数学单元卷");
  await page.getByLabel("学科", { exact: true }).fill("语文");
  await page.getByLabel("学年").fill("2026");
  await page.getByLabel("来源").fill("自制样题");
  await app.evaluate(({ dialog }, target) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] });
  }, fixture);
  await page.getByRole("button", { name: "选择原卷并导入" }).click();
  await expect(page.getByText(/已导入「九年级数学单元卷」。|该原卷已登记为「九年级数学单元卷」，未重复导入。/)).toBeVisible();
  await page.locator(".paper-card").filter({ hasText: "九年级数学单元卷" }).getByRole("button", { name: "进入录题" }).click();
  await expect(page.getByRole("region", { name: "原卷预览" })).toBeVisible();
  await expect(page.getByAltText("原卷第 1 页")).toBeVisible({ timeout: 15000 });
}

/** 在整卷任务面板准备、发送并等到固定响应批次处理完成。 */
async function prepareAndRun(page: Page) {
  const panel = page.getByRole("region", { name: "整卷任务", exact: true });
  await panel.getByRole("button", { name: "准备整卷文字任务" }).click();
  await expect(panel.getByRole("region", { name: "整卷任务详情" })).toBeVisible();
  await panel.getByRole("button", { name: "发送或重试整卷任务" }).click();
  await panel.getByRole("region", { name: "确认整卷发送" }).getByRole("button", { name: "确认发送整卷文字" }).click();
  await expect(panel).toContainText("已处理");
  return panel;
}

/** 在建档区填写整卷分类并确认批量建档。 */
async function intake(page: Page) {
  const section = page.getByRole("region", { name: "整卷批量建档" });
  await expect(section).toBeVisible();
  await section.getByLabel("学科", { exact: true }).fill("语文");
  await section.getByLabel("年级", { exact: true }).fill("九年级");
  await section.getByRole("button", { name: "批量建档" }).click();
  const confirmation = section.getByRole("region", { name: "确认批量建档" });
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole("button", { name: "确认建档" }).click();
}

/** 已有一道同卷分部、原题号「1」的已审核题，用来触发重复候选。 */
function seedApprovedDuplicate(dir: string) {
  const db = new Database(path.join(dir, "paperweave.sqlite"));
  const exams = new ExamStore(db, dir);
  const imported = exams.importPaper({
    title: "九年级数学单元卷", stage: "初中", subject: "语文", grade: "九年级",
    region: "", examType: "单元测", year: "2026", sourceName: "自制样题",
  }, fixture);
  const sectionId = exams.getExam(imported.exam.id).sections[0].id;
  const bank = new QuestionBank(db);
  const saved = new Intake(exams, bank).save({
    examId: imported.exam.id,
    sectionId,
    content: { ...note(), source: { ...note().source, originalNumber: "1" } },
    classification: {
      stage: "初中", subject: "语文", grade: "九年级", examType: "单元测",
      year: "2026", sourceName: "自制样题", questionType: "选择题", knowledgePoints: [],
    },
    submit: true,
  });
  if (!saved.saved) throw new Error("预置题目保存失败");
  bank.setContentStatus(saved.versionId, "approved");
  bank.setAnswerStatus(saved.versionId, "approved");
  db.close();
}

test("一键自动录题：单次确认后自动建档并通过覆盖干净的题", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "paperweave-whole-auto-"));
  const app = await electron.launch({ args: [entry, `--user-data-dir=${dir}`], env: { ...process.env, PAPERWEAVE_AI_FAKE: "clean" } });
  try {
    const page = await app.firstWindow();
    await importExam(page, app);
    const panel = page.getByRole("region", { name: "整卷任务", exact: true });
    await panel.getByRole("button", { name: "自动录题并建档" }).click();
    const confirmation = panel.getByRole("region", { name: "确认整卷发送" });
    await expect(confirmation).toContainText("执行后自动建档");
    await confirmation.getByRole("button", { name: "确认发送并自动建档" }).click();
    await expect(page.getByRole("status").filter({ hasText: "自动通过 2 题" })).toBeVisible({ timeout: 30000 });
    await expect(page.getByRole("status").filter({ hasText: "已建档 2 题" })).toBeVisible();

    const review = page.getByRole("region", { name: "整卷审核" });
    await expect(review).toContainText("第 1 批 · 原卷第 1 页 · 题 1");
    await expect(review).toContainText("第 1 批 · 原卷第 2 页 · 题 2");
    await expect(review).toContainText("内容已通过");

    const coverage = panel.getByRole("region", { name: "原卷覆盖" });
    await expect(coverage).toContainText("覆盖率 100%");
    await expect(coverage).toContainText("未归属片段：0");
    await expect(coverage).toContainText("重叠：0");
    await expect(coverage).toContainText("重号：0");
    await expect(coverage).toContainText("缺锚点：0");
  } finally {
    await closeApp(app);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("整卷建档：分类继承、材料门槛与整卷审核批量通过", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "paperweave-whole-intake-"));
  const app = await electron.launch({ args: [entry, `--user-data-dir=${dir}`], env: { ...process.env, PAPERWEAVE_AI_FAKE: "ok" } });
  try {
    const page = await app.firstWindow();
    await importExam(page, app);
    await prepareAndRun(page);
    await intake(page);
    await expect(page.getByRole("status").filter({ hasText: "已建档 2 题" })).toBeVisible();

    const review = page.getByRole("region", { name: "整卷审核" });
    await expect(review).toContainText("第 1 批 · 原卷第 1 页 · 题 1");
    await expect(review).toContainText("固定响应：下列句子中加点词语使用正确的一项是");
    await expect(review).toContainText("材料草稿待审核：固定响应材料");
    const firstCheckbox = review.getByRole("checkbox", { name: "选择第 1 批第 1 题" });
    const secondCheckbox = review.getByRole("checkbox", { name: "选择第 1 批第 2 题" });
    await expect(firstCheckbox).toBeDisabled();
    await expect(secondCheckbox).toBeDisabled();

    // 材料在整卷审核区集中审核；通过后材料类异常自动消除，其余异常仍需教师逐题处理。
    const materials = review.getByRole("region", { name: "整卷材料审核" });
    await expect(materials).toContainText("固定响应材料");
    await materials.getByRole("button", { name: "材料全部确认通过" }).click();
    await expect(page.getByRole("status").filter({ hasText: "已确认 1 份材料通过" })).toBeVisible();
    await expect(firstCheckbox).toBeDisabled();
    await expect(review).not.toContainText("材料草稿待审核：固定响应材料");

    const firstRow = review.locator("li.intake-review-row").filter({ hasText: "· 题 1" });
    const secondRow = review.locator("li.intake-review-row").filter({ hasText: "· 题 2" });
    await firstRow.getByRole("button", { name: "标记已处理" }).click();
    await expect(page.getByRole("status").filter({ hasText: "已标记该题异常处理完成" })).toBeVisible();
    await secondRow.getByRole("button", { name: "标记已处理" }).click();
    await expect(page.getByRole("status").filter({ hasText: "已标记该题异常处理完成" })).toBeVisible();
    await expect(firstCheckbox).toBeEnabled();
    await expect(secondCheckbox).toBeEnabled();

    await review.getByRole("button", { name: /确认全部自动通过项/ }).click();
    await expect(page.getByRole("status").filter({ hasText: "已确认通过 2 题" })).toBeVisible();
    await expect(review).toContainText("内容已通过");
    await review.getByRole("button", { name: "已通过" }).click();
    await expect(review.locator("li.intake-review-row")).toHaveCount(2);
  } finally {
    await closeApp(app);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("重复建档幂等：再次确认建档不产生重复题目", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "paperweave-whole-intake-idempotent-"));
  const app = await electron.launch({ args: [entry, `--user-data-dir=${dir}`], env: { ...process.env, PAPERWEAVE_AI_FAKE: "ok" } });
  try {
    const page = await app.firstWindow();
    await importExam(page, app);
    await prepareAndRun(page);
    await intake(page);
    await expect(page.getByRole("status").filter({ hasText: "已建档 2 题" })).toBeVisible();
    await intake(page);
    await expect(page.getByRole("status").filter({ hasText: "已有 2 题" })).toBeVisible();
    const count = await page.evaluate(async () => {
      const bridge = (window as unknown as { paperweave: {
        listExams(): Promise<{ id: string; title: string }[]>;
        listExamQuestions(examId: string): Promise<{ questionId: string }[]>;
      } }).paperweave;
      const exam = (await bridge.listExams()).find((item) => item.title === "九年级数学单元卷");
      if (!exam) throw new Error("考试不存在");
      return (await bridge.listExamQuestions(exam.id)).length;
    });
    expect(count).toBe(2);
  } finally {
    await closeApp(app);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("重复候选：同卷同号记录候选，建修订版追加版本且不产生第三题", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "paperweave-whole-intake-duplicate-"));
  seedApprovedDuplicate(dir);
  const app = await electron.launch({ args: [entry, `--user-data-dir=${dir}`], env: { ...process.env, PAPERWEAVE_AI_FAKE: "ok" } });
  try {
    const page = await app.firstWindow();
    await importExam(page, app);
    await prepareAndRun(page);
    await intake(page);
    await expect(page.getByRole("status").filter({ hasText: /已建档 1 题.*重复候选 1 题/ })).toBeVisible();
    const review = page.getByRole("region", { name: "整卷审核" });
    await expect(review).toContainText("原题号「1」已存在");
    await review.getByRole("button", { name: "建修订版" }).click();
    await expect(page.getByRole("status").filter({ hasText: "已创建修订版" })).toBeVisible();
    await expect(review).toContainText("内容待核");
    const result = await page.evaluate(async () => {
      const bridge = (window as unknown as { paperweave: {
        listExams(): Promise<{ id: string; title: string }[]>;
        listExamQuestions(examId: string): Promise<{ questionId: string }[]>;
      } }).paperweave;
      const exam = (await bridge.listExams()).find((item) => item.title === "九年级数学单元卷");
      if (!exam) throw new Error("考试不存在");
      return (await bridge.listExamQuestions(exam.id)).length;
    });
    expect(result).toBe(2);
  } finally {
    await closeApp(app);
    rmSync(dir, { recursive: true, force: true });
  }
});
