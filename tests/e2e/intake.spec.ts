import { test, expect, _electron as electron, type Page } from "@playwright/test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import "pdfjs-dist/legacy/build/pdf.worker.mjs";

const entry = path.resolve(".vite/build/main.cjs");
const fixture = path.resolve("tests/fixtures/two-pages.pdf");

async function pdfTextItems(data: Uint8Array) {
  const loading = getDocument({ data, useSystemFonts: true, disableFontFace: true });
  const document = await loading.promise;
  const items: { text: string; fontSize: number; y: number }[] = [];
  try {
    for (let page = 1; page <= document.numPages; page++) {
      const content = await (await document.getPage(page)).getTextContent();
      for (const item of content.items) {
        if (!("str" in item) || !item.str.trim()) continue;
        items.push({ text: item.str, fontSize: item.height, y: item.transform[5] });
      }
    }
  } finally {
    await loading.destroy().catch(() => undefined);
  }
  return items;
}

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

test("粗体与上下标题干保存重开后保留样式，组卷 PDF 仍按样式渲染", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "paperweave-style-"));
  const outDir = mkdtempSync(path.join(tmpdir(), "paperweave-style-out-"));
  let app = await electron.launch({ args: [entry, `--user-data-dir=${dir}`] });
  try {
    let page = await app.firstWindow();
    await importExam(page, app);
    await app.evaluate(({ dialog, shell }, target) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] });
      shell.openPath = async () => "";
    }, outDir);

    await page.getByLabel("原卷页码", { exact: true }).fill("1");
    await page.getByLabel("原题号").fill("3");
    await page.getByLabel("知识点（逗号分隔）").fill("数与代数");
    const stemGroup = page.getByRole("group", { name: "题干", exact: true });
    await page.getByLabel("题干 文字 1", { exact: true }).fill("合成题：粗体");
    await stemGroup.getByLabel("题干 文字样式 1", { exact: true }).selectOption("粗体");
    await stemGroup.getByRole("button", { name: "添加文字" }).click();
    await stemGroup.getByLabel("题干 文字 2", { exact: true }).fill("x");
    await stemGroup.getByLabel("题干 文字样式 2", { exact: true }).selectOption("上标");
    await stemGroup.getByLabel("题干 接续上一段 2", { exact: true }).check();
    await stemGroup.getByRole("button", { name: "添加文字" }).click();
    await stemGroup.getByLabel("题干 文字 3", { exact: true }).fill(" 与 y");
    await stemGroup.getByLabel("题干 文字样式 3", { exact: true }).selectOption("下标");
    await stemGroup.getByLabel("题干 接续上一段 3", { exact: true }).check();

    await page.getByLabel("小问 1 题干 文字 1", { exact: true }).fill("求值。");
    await page.getByLabel("选项（每行一个）").fill("选项甲\n选项乙");
    await page.getByLabel("小问 1 选项样式 1", { exact: true }).selectOption("下划线");
    await page.getByRole("group", { name: "小问 1 答案" }).getByRole("button", { name: "添加文字" }).click();
    await page.getByLabel("小问 1 答案 文字 1", { exact: true }).fill("答案一");
    await page.getByRole("button", { name: "提交待核" }).click();
    await expect(page.getByText("已提交待核（版本 1）。", { exact: true })).toBeVisible();

    // 重开应用：样式、接续关系与选项样式按原样回填。
    await closeApp(app);
    app = await electron.launch({ args: [entry, `--user-data-dir=${dir}`] });
    page = await app.firstWindow();
    await app.evaluate(({ dialog, shell }, target) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] });
      shell.openPath = async () => "";
    }, outDir);
    await page.getByRole("button", { name: "考试原卷" }).click();
    await page.getByRole("button", { name: "进入录题" }).click();
    await page.locator("section[aria-label='本卷题目']").getByRole("button", { name: "编辑" }).click();
    await expect(page.getByText("已打开题目（版本 1）。", { exact: true })).toBeVisible();
    await expect(page.getByLabel("题干 文字样式 1", { exact: true })).toHaveValue("粗体");
    await expect(page.getByLabel("题干 文字样式 2", { exact: true })).toHaveValue("上标");
    await expect(page.getByLabel("题干 接续上一段 2", { exact: true })).toBeChecked();
    await expect(page.getByLabel("题干 文字样式 3", { exact: true })).toHaveValue("下标");
    await expect(page.getByLabel("题干 接续上一段 3", { exact: true })).toBeChecked();
    await expect(page.getByLabel("题干 文字 3", { exact: true })).toHaveValue(" 与 y");
    await expect(page.getByLabel("小问 1 选项样式 1", { exact: true })).toHaveValue("下划线");

    await page.getByRole("button", { name: "返回考试原卷" }).click();
    await page.getByRole("button", { name: "返回录题草稿" }).click();
    await page.getByRole("button", { name: "题目审核" }).click();
    const card = page.locator(".paper-card", { hasText: "合成题：粗体" });
    await card.getByRole("button", { name: "查看并审核" }).click();
    const detail = page.getByRole("region", { name: "题目审核详情" });
    await detail.getByRole("button", { name: "通过内容审核" }).click();
    await detail.getByRole("button", { name: "通过答案审核" }).click();

    await page.getByRole("button", { name: "去题库与组卷" }).click();
    const result = page.locator(".paper-card", { hasText: "合成题：粗体" });
    await result.getByRole("button", { name: "整题入篮" }).click();
    await page.getByLabel("标题", { exact: true }).fill("样式保留卷");
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
    const items = await pdfTextItems(new Uint8Array(student));
    const normal = items.find((item) => item.text.includes("合成题：粗体"));
    const superscript = items.find((item) => item.text.trim() === "x");
    const subscript = items.find((item) => item.text.trim() === "y");
    expect(normal).toBeDefined();
    expect(superscript).toBeDefined();
    expect(subscript).toBeDefined();
    // 上下标以更小字号、抬升/下沉基线渲染；粗体与正文使用不同字体。
    expect(superscript!.fontSize).toBeLessThan(normal!.fontSize * 0.9);
    expect(subscript!.fontSize).toBeLessThan(normal!.fontSize * 0.9);
    expect(superscript!.y).toBeGreaterThan(normal!.y);
    expect(subscript!.y).toBeLessThan(normal!.y);
  } finally {
    await closeApp(app);
    rmSync(dir, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("同一题内小问号重复时拒绝保存并指出重复项", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "paperweave-intake-labels-"));
  const app = await electron.launch({ args: [entry, `--user-data-dir=${dir}`] });
  try {
    const page = await app.firstWindow();
    await importExam(page, app);
    await page.getByLabel("原题号").fill("4");
    await page.getByLabel("题干 文字 1", { exact: true }).fill("合成题：小问号查重。");
    await page.getByLabel("小问 1 题干 文字 1", { exact: true }).fill("第一问。");
    await page.getByRole("button", { name: "添加小问" }).click();
    const second = page.getByRole("group", { name: "小问 2", exact: true });
    await second.getByLabel("小问号").fill("（1）");
    await second.getByLabel("小问 2 题干 文字 1", { exact: true }).fill("第二问。");
    await page.getByRole("button", { name: "提交待核" }).click();
    await expect(page.getByRole("alert")).toContainText("小问号重复：(1)");
  } finally {
    await closeApp(app);
    rmSync(dir, { recursive: true, force: true });
  }
});
