import { test, expect, _electron as electron, type Page } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const entry = path.resolve(".vite/build/main.cjs");
const fixture = path.resolve("tests/fixtures/sample.docx");

async function closeApp(app: Awaited<ReturnType<typeof electron.launch>>) {
  await app.evaluate(({ app: electronApp }) => { electronApp.exit(0); }).catch(() => undefined);
  await app.close().catch(() => undefined);
}

async function importDocxExam(page: Page, app: Awaited<ReturnType<typeof electron.launch>>) {
  await page.getByRole("button", { name: "考试原卷" }).click();
  await page.getByLabel("考试标题").fill("九年级数学单元卷");
  await page.getByLabel("学科", { exact: true }).fill("语文");
  await page.getByLabel("学年").fill("2026");
  await page.getByLabel("来源").fill("自制样题");
  await app.evaluate(({ dialog }, target) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] });
  }, fixture);
  await page.getByRole("button", { name: "选择原卷并导入" }).click();
  await expect(page.getByText("已导入「九年级数学单元卷」。", { exact: true })).toBeVisible();
  await expect(page.getByText("支持 PDF 或 DOCX 原卷；附件（答案/评分细则/答题卡）仍为 PDF。", { exact: false })).toBeVisible();
  await page.locator(".paper-card").filter({ hasText: "九年级数学单元卷" }).getByRole("button", { name: "进入录题" }).click();
  await expect(page.getByRole("complementary", { name: "DOCX 原卷文字" })).toBeVisible({ timeout: 15000 });
}

test("DOCX 一键自动录题：内嵌图绑定、公式待核与覆盖对账", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "paperweave-docx-auto-"));
  const app = await electron.launch({ args: [entry, `--user-data-dir=${dir}`], env: { ...process.env, PAPERWEAVE_AI_FAKE: "clean" } });
  try {
    const page = await app.firstWindow();
    await importDocxExam(page, app);
    const whole = page.getByRole("region", { name: "整卷任务", exact: true });
    await whole.getByRole("button", { name: "自动录题并建档" }).click();
    await whole.getByRole("region", { name: "确认整卷发送" }).getByRole("button", { name: "确认发送并自动建档" }).click();
    await expect(page.getByRole("status").filter({ hasText: "已建档 4 题" })).toBeVisible({ timeout: 30000 });
    await expect(page.getByRole("status").filter({ hasText: "自动通过 3 题" })).toBeVisible();

    const review = whole.getByRole("region", { name: "整卷审核" });
    await expect(review).toContainText("第 2 段含 OMML 公式");
    const imageRow = review.locator("li.intake-review-row").filter({ hasText: "第 3 段" });
    await expect(imageRow).toContainText("image1.png");
    await expect(imageRow).toContainText("自动通过");

    const coverage = whole.getByRole("region", { name: "原卷覆盖" });
    await expect(coverage).toContainText("覆盖率 100%");
    await expect(coverage).toContainText("缺锚点：0");
  } finally {
    await closeApp(app);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("DOCX 原卷：段落文字视图、按段准备整卷任务并批量建档", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "paperweave-docx-source-"));
  const app = await electron.launch({ args: [entry, `--user-data-dir=${dir}`], env: { ...process.env, PAPERWEAVE_AI_FAKE: "ok" } });
  try {
    const page = await app.firstWindow();
    await importDocxExam(page, app);

    // 左栏是 DOCX 段落文字视图，不是 PDF 页图。
    const docxPanel = page.getByRole("complementary", { name: "DOCX 原卷文字" });
    await expect(docxPanel).toBeVisible();
    await expect(docxPanel).toContainText("DOCX 原卷 · 第 1 段");
    await expect(docxPanel).toContainText("计算：3 + 5");
    await expect(docxPanel).toContainText("已知 f(x) = [公式]");
    await expect(docxPanel).toContainText("[图片：image1.png]");
    await expect(docxPanel).toContainText("（空段落）");
    await expect(docxPanel).toContainText("苹果 | 3");

    // 文字输入读取 DOCX 段落，提示按「段」而不是「页」。
    await page.getByRole("button", { name: "展开" }).click();
    await page.getByRole("tab", { name: "文字输入" }).click();
    await page.getByRole("button", { name: "读取本卷文字" }).click();
    await expect(page.getByText("已读取本卷 4 段文字，可修改或勾选页码后确认发送。", { exact: true })).toBeVisible();

    // 准备整卷任务：空段落不进入批次页码，来源显示为段。
    const whole = page.getByRole("region", { name: "整卷任务", exact: true });
    await whole.getByRole("button", { name: "准备整卷任务" }).click();
    const detail = whole.getByRole("region", { name: "整卷任务详情" });
    await expect(detail).toContainText("原卷第 1、2、3、5 段");
    await expect(detail).toContainText("第 4 段没有文字");

    // 确认发送后按固定响应返回第 1、2 段题目。
    await whole.getByRole("button", { name: "发送或重试整卷任务" }).click();
    const sendConfirm = whole.getByRole("region", { name: "确认整卷发送" });
    await expect(sendConfirm).toContainText("原卷第 1、2、3、5 段的提取文字");
    await sendConfirm.getByRole("button", { name: "确认发送整卷任务" }).click();
    await expect(whole).toContainText("已处理");
    const results = whole.getByRole("region", { name: "第 1 批识别结果" });
    await expect(results).toContainText("原卷第 1 段");
    await expect(results).toContainText("原卷第 2 段");

    // 批量建档并进入整卷审核，来源文案仍按段。
    await whole.getByLabel("学科", { exact: true }).fill("语文");
    await whole.getByLabel("年级", { exact: true }).fill("九年级");
    await whole.getByRole("button", { name: "批量建档" }).click();
    await whole.getByRole("region", { name: "确认批量建档" }).getByRole("button", { name: "确认建档" }).click();
    await expect(page.getByRole("status").filter({ hasText: "已建档 2 题" })).toBeVisible();
    const review = whole.getByRole("region", { name: "整卷审核" });
    await expect(review).toContainText("第 1 批 · 原卷第 1 段 · 题 1");
    await expect(review).toContainText("原卷第 2 段 · 题 2");
  } finally {
    await closeApp(app);
    rmSync(dir, { recursive: true, force: true });
  }
});
