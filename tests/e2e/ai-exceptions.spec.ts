import { test, expect, _electron as electron, type Page } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const entry = path.resolve(".vite/build/main.cjs");

function launch(dir: string, fake: string) {
  return electron.launch({
    args: [entry, `--user-data-dir=${dir}`],
    env: { ...process.env, PAPERWEAVE_AI_FAKE: fake } as Record<string, string>,
  });
}
function tempDir() { return mkdtempSync(path.join(tmpdir(), "paperweave-ai-exception-")); }

async function closeApp(app: Awaited<ReturnType<typeof electron.launch>>) {
  const process = app.process();
  const exited = new Promise<void>((resolve) => process.once("exit", () => resolve()));
  await app.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => undefined);
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3000))]);
}

async function confirmSend(window: Page, text: string) {
  await window.getByLabel(/待处理文字/).fill(text);
  await window.getByLabel(/原卷页码/).fill("3");
  await window.getByRole("button", { name: "生成 AI 草稿…" }).click();
  const confirm = window.getByRole("region", { name: "发送前确认" });
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: "确认发送并生成草稿" }).click();
}

test("取消后编辑区人工修改与待处理文字保留，迟到的成功响应被丢弃", async () => {
  const dir = tempDir();
  const app = await launch(dir, "late-success");
  try {
    const window = await app.firstWindow();
    await expect(window.getByRole("heading", { name: "编辑草稿" })).toBeVisible();
    const editorText = window.getByLabel("文本 1").first();
    await editorText.fill("教师手改的题干");
    await confirmSend(window, "取消后仍应保留的待处理文字");
    await window.getByRole("button", { name: "取消请求" }).click();
    await expect(window.getByRole("status").first()).toContainText("已取消");

    await window.waitForTimeout(2200);
    await expect(window.getByRole("heading", { name: /待核草稿/ })).toHaveCount(0);
    await expect(window.getByRole("article", { name: /AI 草稿第/ })).toHaveCount(0);
    await expect(window.getByRole("button", { name: "全部采纳" })).toHaveCount(0);
    await expect(window.getByLabel(/待处理文字/)).toHaveValue("取消后仍应保留的待处理文字");
    await expect(editorText).toHaveValue("教师手改的题干");
    await expect(window.getByText("有未保存的修改", { exact: false })).toBeVisible();
  } finally {
    await closeApp(app);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("格式错误给出可读提示和重试入口，重试仍先确认再发送", async () => {
  const dir = tempDir();
  const app = await launch(dir, "invalid");
  try {
    const window = await app.firstWindow();
    await confirmSend(window, "格式异常时保留的原始文字");
    const alert = window.getByRole("alert").filter({ hasText: "格式无法解析" });
    await expect(alert).toBeVisible();
    await expect(window.getByLabel(/待处理文字/)).toHaveValue("格式异常时保留的原始文字");

    await alert.getByRole("button", { name: "重试生成" }).click();
    const confirm = window.getByRole("region", { name: "发送前确认" });
    await expect(confirm).toBeVisible();
    await expect(confirm.locator("pre")).toHaveText("格式异常时保留的原始文字");
    await confirm.getByRole("button", { name: "确认发送并生成草稿" }).click();
    await expect(window.getByRole("alert").filter({ hasText: "格式无法解析" })).toBeVisible();
    await expect(window.getByRole("heading", { name: /待核草稿/ })).toHaveCount(0);
  } finally {
    await closeApp(app);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("文字与裁图超限在提交前阻止，并给出拆分或压缩办法", async () => {
  const dir = tempDir();
  const app = await launch(dir, "ok");
  try {
    const window = await app.firstWindow();
    const tooLong = "字".repeat(8001);
    await window.getByLabel(/待处理文字/).fill(tooLong);
    await window.getByLabel(/原卷页码/).fill("3");
    await window.getByRole("button", { name: "生成 AI 草稿…" }).click();
    const alert = window.getByRole("alert").filter({ hasText: "请按题或按页分批提交" });
    await expect(alert).toContainText("超过 8000");
    await expect(alert).toContainText("分批");
    await expect(window.getByRole("region", { name: "发送前确认" })).toHaveCount(0);
    await expect(window.getByLabel(/待处理文字/)).toHaveValue(tooLong);

    const rejected = await window.evaluate(async () => {
      const bridge = (globalThis as unknown as { paperweave: { generateAiDraft: (id: string, input: unknown) => Promise<unknown> } }).paperweave;
      const png = "data:image/png;base64," + btoa("tiny");
      const images = Array.from({ length: 5 }, () => ({ dataUrl: png, page: 1 }));
      return bridge.generateAiDraft("overlimit-test-1234", { mode: "images", images })
        .then(() => "resolved", (error: unknown) => String(error));
    });
    expect(rejected).toContain("最多提交 4 张裁图");
    expect(rejected).toContain("分批");
  } finally {
    await closeApp(app);
    rmSync(dir, { recursive: true, force: true });
  }
});
