import { test, expect, _electron as electron, type Page } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

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
  await page.getByLabel("年份").fill("2026");
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

test("录题提交待核后完整审核公式、题图与标签，再进入新卷", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "paperweave-review-"));
  const app = await electron.launch({ args: [entry, `--user-data-dir=${dir}`] });
  try {
    const page = await app.firstWindow();
    await importExam(page, app);

    await page.getByLabel("原卷页码", { exact: true }).fill("2");
    await page.getByLabel("原题号").fill("1");
    await page.getByLabel("知识点（逗号分隔）").fill("一元二次方程");
    await page.getByLabel("题干 文字 1", { exact: true }).fill("合成题：观察下图。");
    await page.getByLabel("小问 1 题干 文字 1", { exact: true }).fill("求 $x^2$ 的值。");
    await page.getByLabel("小问号").fill("(1)");
    await page.getByLabel("原分值").fill("4");
    const answerGroup = page.getByRole("group", { name: "小问 1 答案" });
    await answerGroup.getByRole("button", { name: "添加文字" }).click();
    await page.getByLabel("小问 1 答案 文字 1", { exact: true }).fill("4");
    const scoringGroup = page.getByRole("group", { name: "小问 1 评分点" });
    await scoringGroup.getByRole("button", { name: "添加评分点" }).click();
    await scoringGroup.getByLabel("说明").fill("答案正确");
    await scoringGroup.getByLabel("分值").fill("4");
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
    await page.getByRole("button", { name: "检查定稿" }).click();
    await expect(page.getByText("定稿检查通过。", { exact: true })).toBeVisible();
  } finally {
    await closeApp(app);
    rmSync(dir, { recursive: true, force: true });
  }
});
