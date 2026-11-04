import { test, expect, _electron as electron } from "@playwright/test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

test("缺图题目在应用内补图后导入；来源变化显示字段差异并建立修订版", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "paperweave-import-fix-"));
  const source = path.join(dir, "tiku-broken");
  cpSync(path.resolve("tests/fixtures/tiku-broken"), source, { recursive: true });
  const image = path.resolve("tests/fixtures/tiku-mini/wiki/images/figure.png");
  const app = await electron.launch({ args: [entry, `--user-data-dir=${path.join(dir, "data")}`] });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "旧库迁入" }).click();
    await app.evaluate(({ dialog }, targets) => {
      dialog.showOpenDialog = (async (_window: unknown, options?: { properties?: string[] }) => {
        const pickDirectory = options?.properties?.includes("openDirectory") === true;
        return { canceled: false, filePaths: [pickDirectory ? targets.directory : targets.image] };
      }) as typeof dialog.showOpenDialog;
    }, { directory: source, image });
    await page.getByRole("button", { name: "扫描 Tiku 根目录" }).click();
    const preview = page.getByRole("region", { name: "迁入预览" });
    await expect(preview).toBeVisible();
    await expect(page.getByText(/可导入 0 · 完全重复 0/)).toBeVisible();
    await expect(page.getByText(/阻断 1/)).toBeVisible();
    await expect(preview).toContainText("缺图：../../images/missing.png");

    await preview.getByRole("button", { name: "选择图片补入" }).click();
    await expect(page.getByText("已处理「缺图：../../images/missing.png」，该条已重新校验为可导入。", { exact: true })).toBeVisible();
    await expect(page.getByText(/可导入 1 · 完全重复 0/)).toBeVisible();
    await expect(page.getByText(/阻断 0/)).toBeVisible();
    await page.getByRole("button", { name: "执行导入" }).click();
    await expect(page.getByText("导入完成：新增 1，修订 0，保留 0。", { exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "迁入批次" })).toContainText("tiku-broken");

    const questionFile = path.join(source, "wiki/by-type/01-积累与运用/Q2025-TEST-003.md");
    const updated = readFileSync(questionFile, "utf8")
      .replace("合成缺图题", "修改后的缺图题")
      .replace(/!\[合成缺图\]\(\.\.\/\.\.\/images\/missing\.png\)\n\n/, "");
    writeFileSync(questionFile, updated);
    await page.getByRole("button", { name: "扫描 Tiku 根目录" }).click();
    await expect(page.getByText(/可导入 0 · 完全重复 0/)).toBeVisible();
    await expect(page.getByText(/来源变化 1/)).toBeVisible();
    await expect(preview).toContainText("题干（修改）");
    await expect(preview).toContainText("修改后的缺图题");
    await expect(preview).toContainText("图片（删除）");
    await page.getByLabel("建立修订版").check();
    await page.getByRole("button", { name: "执行导入" }).click();
    await expect(page.getByText("导入完成：新增 0，修订 1，保留 0。", { exact: true })).toBeVisible();
  } finally {
    await closeApp(app);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mathVault 迁入：第 25 题待校勘需确认，确认后导入并跳过重复", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "paperweave-mathvault-"));
  const app = await electron.launch({ args: [entry, `--user-data-dir=${dir}`] });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "旧库迁入" }).click();
    await stubDirectory(app, path.resolve("tests/fixtures/mathvault-mini"));
    await page.getByRole("button", { name: "扫描 mathVault 根目录" }).click();
    const preview = page.getByRole("region", { name: "迁入预览" });
    await expect(preview).toBeVisible();
    await expect(page.getByText(/可导入 2 · 完全重复 0/)).toBeVisible();
    await expect(preview).toContainText("M2023-NCZK-025");
    await expect(preview).toContainText("待校勘");
    await expect(preview).toContainText("M2024-TEST-019");

    await page.getByRole("button", { name: "执行导入" }).click();
    await expect(page.getByText(/该来源待校勘，请先确认校勘说明/)).toBeVisible();
    await page.getByLabel("我已核对校勘说明").check();
    await page.getByRole("button", { name: "执行导入" }).click();
    await expect(page.getByText("导入完成：新增 2，修订 0，保留 0。", { exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "迁入批次" })).toContainText("mathvault-mini");

    await page.getByRole("button", { name: "返回录题草稿" }).click();
    await page.getByRole("button", { name: "旧库迁入" }).click();
    await stubDirectory(app, path.resolve("tests/fixtures/mathvault-mini"));
    await page.getByRole("button", { name: "扫描 mathVault 根目录" }).click();
    await expect(page.getByText(/可导入 0 · 完全重复 2/)).toBeVisible();
  } finally {
    await closeApp(app);
    rmSync(dir, { recursive: true, force: true });
  }
});
