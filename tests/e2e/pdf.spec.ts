import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

test("从实际编辑内容生成并打开同一份 A4 PDF；错误公式不生成", async ({}, testInfo) => {
  const dir = mkdtempSync(path.join(tmpdir(), "paperweave-pdf-"));
  const output = testInfo.outputPath("草稿样张.pdf");
  const app = await electron.launch({ args: [path.resolve(".vite/build/main.cjs"), `--user-data-dir=${dir}`] });
  try {
    await app.evaluate(({ dialog, shell }, target) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: target });
      shell.openPath = async (file) => { (globalThis as typeof globalThis & { openedPdf?: string }).openedPdf = file; return ""; };
    }, output);
    const page = await app.firstWindow();
    const image = path.join(dir, "自制样图.png");
    const imageData = await page.evaluate(() => { const c = document.createElement("canvas"); c.width = 300; c.height = 120; const g = c.getContext("2d")!; g.fillStyle = "#226644"; g.fillRect(0, 0, 300, 120); g.fillStyle = "white"; g.font = "28px sans-serif"; g.fillText("EXAMPLE 3", 40, 70); return c.toDataURL("image/png").split(",")[1]; });
    writeFileSync(image, Buffer.from(imageData, "base64"));
    await app.evaluate(({ dialog }, filename) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filename] }); }, image);
    await page.getByLabel("文本 1").fill("测试样卷：小明有 3 个苹果。\n请认真作答。");
    await page.getByRole("button", { name: "添加独立公式" }).click();
    await page.getByLabel("LaTeX 公式").fill("\\badcommand");
    await page.getByRole("button", { name: "生成并预览草稿 PDF" }).click();
    await expect(page.getByText(/存在空白或无法渲染的公式/)).toBeVisible();
    await page.getByLabel("LaTeX 公式").fill("x^2+1=5");
    await page.getByRole("button", { name: "添加图片" }).click();
    await expect(page.getByRole("img", { name: "题图" }).first()).toBeVisible();
    await page.getByRole("button", { name: "添加表格" }).click();
    await page.getByLabel("第 1 行第 1 列").fill("名称");
    await page.getByLabel("第 1 行第 2 列").fill("数量");
    await page.getByLabel("第 2 行第 1 列").fill("苹果");
    await page.getByLabel("第 2 行第 2 列").fill("3");
    await page.getByRole("button", { name: "生成并预览草稿 PDF" }).click();
    await expect(page.getByText(/PDF 已保存并打开/)).toBeVisible();
    expect(readFileSync(output).subarray(0, 5).toString()).toBe("%PDF-");
    expect(await app.evaluate(() => (globalThis as typeof globalThis & { openedPdf?: string }).openedPdf)).toBe(output);
    const oversized = path.join(dir, "大图.png");
    const bigData = await page.evaluate(() => { const c = document.createElement("canvas"); c.width = 800; c.height = 100; return c.toDataURL("image/png").split(",")[1]; });
    writeFileSync(oversized, Buffer.from(bigData, "base64"));
    await app.evaluate(({ dialog }, filename) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filename] }); }, oversized);
    await page.getByRole("button", { name: "添加图片" }).click();
    await expect(page.getByRole("img", { name: "题图" })).toHaveCount(4);
    await page.getByRole("region", { name: "内容 5" }).getByRole("button", { name: "上移" }).click();
    await page.getByRole("region", { name: "内容 4" }).getByRole("button", { name: "上移" }).click();
    const previewImages = page.getByRole("region", { name: "内容预览" }).getByRole("img");
    await expect(previewImages.nth(0)).toHaveAttribute("src", `data:image/png;base64,${bigData}`);
    await expect(previewImages.nth(1)).toHaveAttribute("src", `data:image/png;base64,${imageData}`);
    await page.getByRole("button", { name: "生成并预览草稿 PDF" }).click();
    await expect(page.getByText(/图片超过 A4 可打印区域/)).toBeVisible();
  } finally { await app.evaluate(({ app: electronApp }) => { electronApp.exit(0); }).catch(() => undefined); await app.close().catch(() => undefined); rmSync(dir, { recursive: true, force: true }); }
});

test("长文和表格生成多页样张", async ({}, testInfo) => {
  const dir = mkdtempSync(path.join(tmpdir(), "paperweave-pages-"));
  const output = testInfo.outputPath("多页样张.pdf");
  const app = await electron.launch({ args: [path.resolve(".vite/build/main.cjs"), `--user-data-dir=${dir}`] });
  try {
    await app.evaluate(({ dialog, shell }, target) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: target });
      shell.openPath = async () => "";
    }, output);
    const page = await app.firstWindow();
    const longText = Array.from({ length: 80 }, (_, i) => `第 ${i + 1} 行：这是用于检查长文分页的自制内容。`).join("\n");
    await page.getByLabel("文本 1").fill(longText);
    await page.getByRole("button", { name: "添加表格" }).click();
    for (let i = 0; i < 28; i++) await page.getByRole("button", { name: "添加行", exact: true }).click();
    for (let i = 1; i <= 30; i++) await page.getByLabel(`第 ${i} 行第 1 列`).fill(`表格第 ${i} 行`);
    await page.getByRole("button", { name: "生成并预览草稿 PDF" }).click();
    await expect(page.getByText(/PDF 已保存并打开/)).toBeVisible();
    const pdf = readFileSync(output);
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect((pdf.toString("latin1").match(/\/Type\s*\/Page\b/g) || []).length).toBeGreaterThan(1);
  } finally { await app.evaluate(({ app: electronApp }) => { electronApp.exit(0); }).catch(() => undefined); await app.close().catch(() => undefined); rmSync(dir, { recursive: true, force: true }); }
});
