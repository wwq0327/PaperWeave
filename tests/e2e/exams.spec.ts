import { test, expect, _electron as electron } from "@playwright/test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const entry = path.resolve(".vite/build/main.cjs");
const pdf = (text: string) => Buffer.from(`%PDF-1.4\n${text}\n%%EOF`);

async function closeApp(app: Awaited<ReturnType<typeof electron.launch>>) {
  await app.evaluate(({ app: electronApp }) => { electronApp.exit(0); }).catch(() => undefined);
  await app.close().catch(() => undefined);
}

test("导入原卷、指纹去重、挂接答案并在重开后保留", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "paperweave-exams-"));
  const source = mkdtempSync(path.join(tmpdir(), "paperweave-exams-src-"));
  const paperPath = path.join(source, "九年级数学单元卷.pdf");
  const answerPath = path.join(source, "参考答案.pdf");
  const badPath = path.join(source, "坏卷.pdf");
  const paperBytes = pdf("自制原卷内容");
  writeFileSync(paperPath, paperBytes);
  writeFileSync(answerPath, pdf("自制答案内容"));
  writeFileSync(badPath, "普通文本");
  const sha = createHash("sha256").update(paperBytes).digest("hex");

  let app = await electron.launch({ args: [entry, `--user-data-dir=${dir}`] });
  try {
    let page = await app.firstWindow();
    await page.getByRole("button", { name: "考试原卷" }).click();
    await expect(page.getByRole("heading", { name: "考试原卷" })).toBeVisible();

    await page.getByLabel("考试标题").fill("九年级数学单元卷");
    await page.getByLabel("学科", { exact: true }).fill("数学");
    await page.getByLabel("年级", { exact: true }).fill("九年级");
    await page.getByLabel("地区").fill("四川南充");
    await page.getByLabel("题型").fill("单元测");
    await page.getByLabel("年份").fill("2026");
    await page.getByLabel("来源").fill("自制样题");

    await app.evaluate(({ dialog }, target) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] });
    }, badPath);
    await page.getByRole("button", { name: "选择 PDF 并导入" }).click();
    await expect(page.getByRole("alert")).toContainText("原卷必须是 PDF 文件");

    await app.evaluate(({ dialog }, target) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] });
    }, paperPath);
    await page.getByRole("button", { name: "选择 PDF 并导入" }).click();
    await expect(page.getByText("已导入「九年级数学单元卷」。", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "九年级数学单元卷" })).toBeVisible();
    expect(existsSync(path.join(dir, "originals", `${sha}.pdf`))).toBe(true);
    expect(readdirSync(path.join(dir, "originals"))).toEqual([`${sha}.pdf`]);

    await page.getByRole("button", { name: "选择 PDF 并导入" }).click();
    await expect(page.getByText("该原卷已登记为「九年级数学单元卷」，未重复导入。", { exact: true })).toBeVisible();
    await expect(page.locator("section[aria-label='考试列表'] .paper-card")).toHaveCount(1);

    await page.getByLabel("分部标题").fill("数学部分");
    await page.getByLabel("分部学科").fill("数学");
    await page.getByRole("button", { name: "添加分部" }).click();
    await expect(page.getByText("分部已添加。", { exact: true })).toBeVisible();
    await expect(page.locator("section[aria-label='考试详情'] ol li")).toHaveText(["全卷（数学）", "数学部分（数学）"]);

    await app.evaluate(({ dialog }, target) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] });
    }, answerPath);
    await page.getByRole("button", { name: "挂接答案 PDF" }).click();
    await expect(page.getByText("答案文件已挂接。", { exact: true })).toBeVisible();
    await expect(page.getByText("参考答案.pdf", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "挂接答案 PDF" }).click();
    await expect(page.getByText("该答案文件已挂接。", { exact: true })).toBeVisible();
    await expect(page.locator("section[aria-label='考试详情'] .paper-list .paper-card")).toHaveCount(2);

    await closeApp(app);
    app = await electron.launch({ args: [entry, `--user-data-dir=${dir}`] });
    page = await app.firstWindow();
    await page.getByRole("button", { name: "考试原卷" }).click();
    await expect(page.getByText("九年级数学单元卷", { exact: true }).first()).toBeVisible();
    await expect(page.getByRole("heading", { name: "九年级数学单元卷" })).toBeVisible();
    await expect(page.getByText("参考答案.pdf", { exact: true })).toBeVisible();
    await expect(page.getByText("数学部分（数学）", { exact: false })).toBeVisible();
  } finally {
    await closeApp(app);
    rmSync(dir, { recursive: true, force: true });
    rmSync(source, { recursive: true, force: true });
  }
});
