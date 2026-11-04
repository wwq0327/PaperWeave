import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const entry = path.resolve(".vite/build/main.cjs");
const fixture = path.resolve("tests/fixtures/tiku-mini");

async function closeApp(app: Awaited<ReturnType<typeof electron.launch>>) {
  await app.evaluate(({ app: electronApp }) => { electronApp.exit(0); }).catch(() => undefined);
  await app.close().catch(() => undefined);
}

async function stubDirectory(app: Awaited<ReturnType<typeof electron.launch>>, directory: string) {
  await app.evaluate(({ dialog }, target) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] });
  }, directory);
}

test("扫描 Tiku 预览、导入自制题目，再次扫描全部跳过重复", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "paperweave-import-"));
  const app = await electron.launch({ args: [entry, `--user-data-dir=${dir}`] });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "旧库迁入" }).click();
    await stubDirectory(app, fixture);
    await page.getByRole("button", { name: "扫描 Tiku 根目录" }).click();
    const preview = page.getByRole("region", { name: "迁入预览" });
    await expect(preview).toBeVisible();
    await expect(page.getByText(/可导入 2 · 完全重复 0/)).toBeVisible();
    await expect(preview).toContainText("Q2024-TEST-002");
    await expect(preview).toContainText("阅读下面的合成材料");
    await expect(preview).toContainText("合成选择题");
    await expect(preview).toContainText("页码待补（按第 1 页）");

    await page.getByRole("button", { name: "执行导入" }).click();
    await expect(page.getByText("导入完成：新增 2，修订 0，保留 0。", { exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "迁入批次" })).toContainText("Tiku · tiku-mini");
    await expect(page.getByRole("region", { name: "迁入批次" })).toContainText("新增 2");

    await page.getByRole("button", { name: "返回录题草稿" }).click();
    await page.getByRole("button", { name: "题库与组卷" }).click();
    const searchRegion = page.getByRole("region", { name: "题库检索" });
    await searchRegion.getByLabel("学科").fill("语文");
    await searchRegion.getByLabel("关键词").fill("合成第一问");
    await searchRegion.getByRole("button", { name: "检索" }).click();
    await expect(searchRegion).toContainText("合成第一问");

    await page.getByRole("button", { name: "返回录题草稿" }).click();
    await page.getByRole("button", { name: "旧库迁入" }).click();
    await stubDirectory(app, fixture);
    await page.getByRole("button", { name: "扫描 Tiku 根目录" }).click();
    await expect(page.getByText(/可导入 0 · 完全重复 2/)).toBeVisible();
    await expect(page.getByRole("region", { name: "迁入预览" })).toContainText("完全重复");
  } finally {
    await closeApp(app);
    rmSync(dir, { recursive: true, force: true });
  }
});
