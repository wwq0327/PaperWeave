import { test, expect, _electron as electron, type Page } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const entry = path.resolve(".vite/build/main.cjs");
const fixture = (name: string) => path.resolve("tests/fixtures", name);

function launch(dir: string, fake: string) {
  return electron.launch({
    args: [entry, `--user-data-dir=${dir}`],
    env: { ...process.env, PAPERWEAVE_AI_FAKE: fake } as Record<string, string>,
  });
}
function tempDir() { return mkdtempSync(path.join(tmpdir(), "paperweave-ai-image-")); }

async function closeApp(app: Awaited<ReturnType<typeof electron.launch>>) {
  const process = app.process();
  const exited = new Promise<void>((resolve) => process.once("exit", () => resolve()));
  await app.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => undefined);
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3000))]);
}

async function mockPdf(app: Awaited<ReturnType<typeof electron.launch>>, file: string) {
  await app.evaluate(({ dialog }, filename) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filename] });
  }, file);
}

async function dragRegion(window: Page) {
  const view = window.locator(".ai-page-view");
  await view.scrollIntoViewIfNeeded();
  const box = await view.boundingBox();
  if (!box) throw new Error("页面未显示");
  const startX = box.x + box.width * 0.12;
  const startY = box.y + Math.min(80, box.height * 0.15);
  await window.mouse.move(startX, startY);
  await window.mouse.down();
  await window.mouse.move(box.x + box.width * 0.88, startY + Math.min(180, box.height * 0.35), { steps: 6 });
  await window.mouse.up();
}

test("扫描页拖选跨页多区域，按顺序确认发送并采纳", async () => {
  const dir = tempDir();
  const app = await launch(dir, "ok");
  try {
    const window = await app.firstWindow();
    await window.getByText("模型服务与密钥设置").click();
    await window.getByLabel("图像模型（裁图输入用）").fill("vision-model-test");
    await window.getByRole("button", { name: "保存模型设置" }).click();
    await expect(window.getByText("模型服务设置已保存。")).toBeVisible();

    await window.getByRole("tab", { name: "裁图输入" }).click();
    await mockPdf(app, fixture("two-pages.pdf"));
    await window.getByRole("button", { name: "选择 PDF 并选取裁图" }).click();
    await expect(window.getByRole("img", { name: "原卷第 1 页" })).toBeVisible();
    await expect(window.getByText(/选区请包含题干/)).toBeVisible();

    await dragRegion(window);
    await expect(window.locator(".ai-selection-list li")).toHaveCount(1);
    await expect(window.locator(".ai-selection-list li").first()).toContainText("第 1 页");
    await expect(window.getByRole("img", { name: "第 1 页选区 1" })).toBeVisible();

    await window.getByRole("button", { name: "下一页" }).click();
    await expect(window.getByRole("img", { name: "原卷第 2 页" })).toBeVisible();
    await dragRegion(window);
    await expect(window.locator(".ai-selection-list li")).toHaveCount(2);
    await expect(window.locator(".ai-selection-list li").nth(1)).toContainText("第 2 页");

    await window.locator(".ai-selection-list li").nth(1).getByRole("button", { name: "上移" }).click();
    await expect(window.locator(".ai-selection-list li").first()).toContainText("第 2 页");
    await window.getByLabel(/补充说明/).fill("本组包含跨页材料，请保留设问顺序。");

    await window.getByRole("button", { name: "生成 AI 草稿…" }).click();
    const confirm = window.getByRole("region", { name: "发送前确认" });
    await expect(confirm).toContainText("vision-model-test");
    await expect(confirm).toContainText("裁图：2 张（第 2、1 页）");
    await expect(confirm).toContainText("本次只发送下方裁图");
    await expect(confirm.getByRole("img")).toHaveCount(2);
    await expect(confirm).toContainText("本组包含跨页材料");
    await confirm.getByRole("button", { name: "确认发送并生成草稿" }).click();

    await expect(window.getByRole("heading", { name: "待核草稿（2 题）" })).toBeVisible();
    await expect(window.getByRole("article", { name: "AI 草稿第 1 题" })).toContainText("原卷第 2 页");
    await window.getByRole("button", { name: "全部采纳" }).click();
    await expect(window.getByLabel("教师参考答案（仅供教师卷样张使用）")).toHaveValue("固定响应答案：B");
    await expect(window.getByLabel("文本 1").nth(1)).toHaveValue("固定响应：下列句子中加点词语使用正确的一项是");
  } finally {
    await closeApp(app);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("无选区时阻止发送；扫描件提示按裁图处理；主进程拒绝非 data URL 裁图", async () => {
  const dir = tempDir();
  const app = await launch(dir, "ok");
  try {
    const window = await app.firstWindow();
    await window.getByRole("tab", { name: "裁图输入" }).click();
    await mockPdf(app, fixture("blank.pdf"));
    await window.getByRole("button", { name: "选择 PDF 并选取裁图" }).click();
    await expect(window.getByRole("img", { name: "原卷第 1 页" })).toBeVisible();
    await expect(window.getByRole("alert")).toContainText("没有可提取的文字");

    await window.getByRole("button", { name: "生成 AI 草稿…" }).click();
    await expect(window.getByRole("alert")).toContainText("请至少选择一张裁图");
    await expect(window.getByRole("region", { name: "发送前确认" })).toHaveCount(0);

    const rejected = await window.evaluate(async () => {
      const bridge = (globalThis as unknown as { paperweave: { generateAiDraft: (id: string, input: unknown) => Promise<unknown> } }).paperweave;
      return bridge.generateAiDraft("image-invalid-1234", { mode: "images", images: [{ dataUrl: "https://example.com/a.png", page: 1 }] })
        .then(() => "resolved", (error: unknown) => String(error));
    });
    expect(rejected).toContain("裁图格式无效");
  } finally {
    await closeApp(app);
    rmSync(dir, { recursive: true, force: true });
  }
});
