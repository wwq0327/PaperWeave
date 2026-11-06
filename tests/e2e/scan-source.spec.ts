import { test, expect, _electron as electron, type Page } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const entry = path.resolve(".vite/build/main.cjs");
const paper = path.resolve("tests/fixtures/blank.pdf");
const answer = path.resolve("tests/fixtures/text.pdf");

async function closeApp(app: Awaited<ReturnType<typeof electron.launch>>) {
  await app.evaluate(({ app: electronApp }) => { electronApp.exit(0); }).catch(() => undefined);
  await app.close().catch(() => undefined);
}

async function importScanExam(page: Page, app: Awaited<ReturnType<typeof electron.launch>>) {
  await page.getByRole("button", { name: "考试原卷" }).click();
  await page.getByLabel("考试标题").fill("九年级数学扫描卷");
  await page.getByLabel("学科", { exact: true }).fill("语文");
  await page.getByLabel("学年").fill("2026");
  await page.getByLabel("来源").fill("自制样题");
  await app.evaluate(({ dialog }, target) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] });
  }, paper);
  await page.getByRole("button", { name: "选择原卷并导入" }).click();
  await expect(page.getByText(/已导入「九年级数学扫描卷」。|该原卷已登记为「九年级数学扫描卷」，未重复导入。/)).toBeVisible();
  await expect(page.getByRole("heading", { name: "九年级数学扫描卷" })).toBeVisible();
}

test("扫描原卷与答案文件：一次确认、本机裁图与答案关联", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "paperweave-scan-source-"));
  const app = await electron.launch({ args: [entry, `--user-data-dir=${dir}`], env: { ...process.env, PAPERWEAVE_AI_FAKE: "clean" } });
  try {
    const page = await app.firstWindow();
    await importScanExam(page, app);
    await app.evaluate(({ dialog }, target) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] });
    }, answer);
    await page.getByRole("button", { name: "挂接答案 PDF" }).click();
    await expect(page.getByText("答案文件已挂接。", { exact: true })).toBeVisible();
    await page.locator(".paper-card").filter({ hasText: "九年级数学扫描卷" }).getByRole("button", { name: "进入录题" }).click();
    await expect(page.getByRole("region", { name: "原卷预览" })).toBeVisible();
    await expect(page.getByAltText("原卷第 1 页")).toBeVisible({ timeout: 15000 });

    const panel = page.getByRole("region", { name: "整卷任务", exact: true });
    await panel.getByRole("button", { name: "自动录题并建档" }).click();
    const confirmation = panel.getByRole("region", { name: "确认整卷发送" });
    await expect(confirmation).toContainText("扫描页 1 批");
    await expect(confirmation).toContainText("答案文字 1 批");
    await expect(confirmation).toContainText("图像模型");
    await confirmation.getByRole("button", { name: "确认发送并自动建档" }).click();
    await expect(page.getByRole("status").filter({ hasText: "自动通过 1 题" })).toBeVisible({ timeout: 30000 });
    await expect(page.getByRole("status").filter({ hasText: "已建档 1 题" })).toBeVisible();

    const coverage = panel.getByRole("region", { name: "原卷覆盖" });
    await expect(coverage).toContainText("扫描页覆盖 100%（1/1）");
    await expect(coverage).toContainText("缺锚点：0");
    await expect(coverage).toContainText("答案匹配 1 / 1");

    const content = await page.evaluate(async () => {
      const bridge = (window as unknown as { paperweave: {
        listExams(): Promise<{ id: string; title: string }[]>;
        listExamQuestions(examId: string): Promise<{ versionId: string }[]>;
        getQuestionDetail(versionId: string): Promise<{ content: unknown }>;
      } }).paperweave;
      const exam = (await bridge.listExams()).find((item) => item.title === "九年级数学扫描卷");
      if (!exam) throw new Error("考试不存在");
      const questions = await bridge.listExamQuestions(exam.id);
      if (questions.length !== 1) throw new Error(`题目数量异常：${questions.length}`);
      return bridge.getQuestionDetail(questions[0].versionId);
    });
    expect(JSON.stringify(content.content)).toContain('"type":"image"');
    expect(JSON.stringify(content.content)).toContain("扫描裁图 第 1 页");
  } finally {
    await closeApp(app);
    rmSync(dir, { recursive: true, force: true });
  }
});
