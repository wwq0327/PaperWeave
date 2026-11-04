import { test, expect, _electron as electron, type Page } from "@playwright/test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
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

test("同卷同号再次保存提示重复，可继续编辑已有题或建立修订版", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "paperweave-intake-duplicate-"));
  let app = await electron.launch({ args: [entry, `--user-data-dir=${dir}`] });
  try {
    const page = await app.firstWindow();
    await importExam(page, app);

    async function fill(number: string, stem: string) {
      await page.getByLabel("原题号").fill(number);
      await page.getByLabel("题干 文字 1", { exact: true }).fill(stem);
      await page.getByLabel("小问 1 题干 文字 1", { exact: true }).fill("求值。");
    }

    await fill("1", "合成题：重复检查。");
    await page.getByRole("button", { name: "保存草稿" }).click();
    await expect(page.getByText("草稿已保存（版本 1）。", { exact: true })).toBeVisible();
    await expect(page.locator("section[aria-label='本卷题目']")).toContainText("草稿");

    await page.getByRole("button", { name: "新建题目" }).click();
    await fill("1", "合成题：第二次输入。");
    await page.getByRole("button", { name: "保存草稿" }).click();
    const prompt = page.getByRole("alertdialog", { name: "重复题提示" });
    await expect(prompt).toBeVisible();
    await expect(prompt).toContainText("原题号「1」");
    await expect(prompt).toContainText("合成题：重复检查。");

    await prompt.getByRole("button", { name: "继续编辑已有题" }).click();
    await expect(page.getByText("已打开题目（版本 1）。", { exact: true })).toBeVisible();
    await expect(page.getByLabel("题干 文字 1", { exact: true })).toHaveValue("合成题：重复检查。");
    await expect(page.locator("section[aria-label='本卷题目'] h2")).toHaveText("本卷题目（1）");

    await page.getByRole("button", { name: "新建题目" }).click();
    await fill("1", "合成题：修订输入。");
    await page.getByRole("button", { name: "提交待核" }).click();
    await page.getByRole("alertdialog", { name: "重复题提示" }).getByRole("button", { name: "建立修订版" }).click();
    await expect(page.getByText("已提交待核（版本 2）。", { exact: true })).toBeVisible();
    const list = page.locator("section[aria-label='本卷题目']");
    await expect(list.locator("h2")).toHaveText("本卷题目（1）");
    await expect(list).toContainText("合成题：修订输入。");
    await expect(list).toContainText("待核");
  } finally {
    await closeApp(app);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("导入原卷、裁图录题、保存草稿并在重开后继续编辑与定位原页", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "paperweave-intake-"));
  let app = await electron.launch({ args: [entry, `--user-data-dir=${dir}`] });
  try {
    let page = await app.firstWindow();
    await importExam(page, app);

    await page.getByLabel("原卷页码", { exact: true }).fill("2");
    await page.getByLabel("原题号").fill("1");
    await page.getByLabel("知识点（逗号分隔）").fill("一元二次方程");
    await page.getByLabel("题干 文字 1", { exact: true }).fill("合成题：观察下图。");
    await page.getByLabel("小问 1 题干 文字 1", { exact: true }).fill("求 $x$ 的值。");
    await page.getByLabel("小问号").fill("(1)");
    await page.getByLabel("原分值").fill("4");

    const answerGroup = page.getByRole("group", { name: "小问 1 答案" });
    await answerGroup.getByRole("button", { name: "添加文字" }).click();
    await page.getByLabel("小问 1 答案 文字 1", { exact: true }).fill("4");

    const scoringGroup = page.getByRole("group", { name: "小问 1 评分点" });
    await scoringGroup.getByRole("button", { name: "添加评分点" }).click();
    await scoringGroup.getByLabel("说明").fill("答案正确");
    await scoringGroup.getByLabel("分值").fill("4");

    const slotGroup = page.getByRole("group", { name: "小问 1 作答位置" });
    await slotGroup.getByRole("button", { name: "添加空位" }).click();
    await page.getByLabel("空位 1 标签").fill("作答一");
    await slotGroup.getByRole("button", { name: "添加空位" }).click();
    await page.getByLabel("空位 2 标签").fill("作答二");
    await page.getByLabel("空位 1 与空位 2 互换").check();
    const firstSlotAnswer = page.getByRole("group", { name: "小问 1 空位 1 答案" });
    await firstSlotAnswer.getByRole("button", { name: "添加文字" }).click();
    await page.getByLabel("小问 1 空位 1 答案 文字 1", { exact: true }).fill("甲");
    await scoringGroup.getByLabel("评分点 1 关联空位 1").check();

    const promptGroup = page.getByRole("group", { name: "小问 1 题干" });
    await promptGroup.getByRole("button", { name: "插入裁图" }).click();
    await expect(page.getByText("拖动页面选区，裁图将插入：", { exact: false })).toBeVisible();
    await dragOnPage(page);
    await expect(page.getByText("裁图已插入当前编辑目标。", { exact: true })).toBeVisible();
    await expect(promptGroup.locator("img")).toBeVisible();
    expect(readdirSync(path.join(dir, "attachments"))).toHaveLength(1);

    await page.getByRole("button", { name: "保存草稿" }).click();
    await expect(page.getByText("草稿已保存（版本 1）。", { exact: true })).toBeVisible();
    await expect(page.locator("section[aria-label='本卷题目']")).toContainText("合成题：观察下图。");

    await closeApp(app);
    app = await electron.launch({ args: [entry, `--user-data-dir=${dir}`] });
    page = await app.firstWindow();
    await page.getByRole("button", { name: "考试原卷" }).click();
    await page.getByRole("button", { name: "进入录题" }).click();
    await expect(page.getByRole("region", { name: "原卷预览" })).toBeVisible();
    await page.locator("section[aria-label='本卷题目']").getByRole("button", { name: "编辑" }).click();
    await expect(page.getByText("已打开题目（版本 1）。", { exact: true })).toBeVisible();

    await expect(page.getByLabel("小问 1 题干 文字 1", { exact: true })).toHaveValue("求 $x$ 的值。");
    await expect(page.getByLabel("小问 1 答案 文字 1", { exact: true })).toHaveValue("4");
    await expect(page.getByLabel("原卷页码", { exact: true })).toHaveValue("2");
    await expect(page.getByLabel("原卷页码跳转")).toHaveValue("2");
    await expect(page.getByAltText("原卷第 2 页")).toBeVisible({ timeout: 15000 });
    await page.getByRole("button", { name: "上一页" }).click();
    await expect(page.getByLabel("原卷页码跳转")).toHaveValue("1");
    await page.locator("section[aria-label='本卷题目']").getByRole("button", { name: "定位原页" }).click();
    await expect(page.getByLabel("原卷页码跳转")).toHaveValue("2");
    const reopenedGroup = page.getByRole("group", { name: "小问 1 题干" });
    await expect(reopenedGroup.locator("img")).toBeVisible();
    await expect(page.getByRole("group", { name: "小问 1 评分点" }).getByLabel("说明")).toHaveValue("答案正确");
    await expect(page.getByRole("group", { name: "小问 1 评分点" }).getByLabel("分值")).toHaveValue("4");
    await expect(page.getByLabel("空位 1 标签")).toHaveValue("作答一");
    await expect(page.getByLabel("空位 2 标签")).toHaveValue("作答二");
    await expect(page.getByLabel("空位 1 与空位 2 互换")).toBeChecked();
    await expect(page.getByLabel("小问 1 空位 1 答案 文字 1", { exact: true })).toHaveValue("甲");
    await expect(page.getByRole("group", { name: "小问 1 评分点" }).getByLabel("评分点 1 关联空位 1")).toBeChecked();
  } finally {
    await closeApp(app);
    rmSync(dir, { recursive: true, force: true });
  }
});
