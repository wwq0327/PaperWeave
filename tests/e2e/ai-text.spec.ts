import { test, expect, _electron as electron, type Page } from "@playwright/test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
function tempDir() { return mkdtempSync(path.join(tmpdir(), "paperweave-ai-")); }

async function closeApp(app: Awaited<ReturnType<typeof electron.launch>>) {
  const process = app.process();
  const exited = new Promise<void>((resolve) => process.once("exit", () => resolve()));
  await app.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => undefined);
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3000))]);
}

async function send(window: Page, text: string, page = "3") {
  await window.getByLabel(/待处理文字/).fill(text);
  await window.getByLabel(/原卷页码/).fill(page);
  await window.getByRole("button", { name: "生成 AI 草稿…" }).click();
  const confirm = window.getByRole("region", { name: "发送前确认" });
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: "确认发送并生成草稿" }).click();
}

test("文字草稿经确认发送，待核标记保留，采纳后进入编辑区并可保存重开", async () => {
  const dir = tempDir();
  let app = await launch(dir, "ok");
  try {
    let window = await app.firstWindow();
    await expect(window.getByRole("heading", { name: "编辑草稿" })).toBeVisible();
    const text = "第 3 页：下列句子中加点词语使用正确的一项是。\n第 4 页：阅读下文，完成练习。";
    await window.getByLabel(/待处理文字/).fill(text);
    await window.getByLabel(/原卷页码/).fill("3");
    await window.getByRole("button", { name: "生成 AI 草稿…" }).click();
    const confirm = window.getByRole("region", { name: "发送前确认" });
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText("api.anthropic.com");
    await expect(confirm).toContainText("claude-sonnet-5-5");
    await expect(confirm.locator("pre")).toHaveText(text);
    await confirm.getByRole("button", { name: "确认发送并生成草稿" }).click();

    await expect(window.getByRole("heading", { name: "待核草稿（2 题）" })).toBeVisible();
    const first = window.getByRole("article", { name: "AI 草稿第 1 题" });
    await expect(first).toContainText("原卷第 3 页");
    await expect(first).toContainText("待核：固定响应待核点");
    await expect(first).toContainText("参考答案（采纳后写入教师卷）");
    await expect(window.getByRole("article", { name: "AI 草稿第 2 题" })).toContainText("原卷第 4 页");

    await window.getByRole("button", { name: "全部采纳" }).click();
    await expect(window.getByRole("status").first()).toContainText("已采纳 2 题");
    const adoptedStem = window.getByLabel("文本 1").nth(1);
    await expect(adoptedStem).toHaveValue("固定响应：下列句子中加点词语使用正确的一项是");
    await adoptedStem.fill("教师修改后的题干");
    await expect(window.getByLabel("教师参考答案（仅供教师卷样张使用）")).toHaveValue("固定响应答案：B");
    await expect(window.getByRole("region", { name: "内容预览" })).not.toContainText("固定响应答案");

    await window.getByRole("button", { name: "保存草稿" }).click();
    await expect(window.getByText("草稿已保存到本机。", { exact: false })).toBeVisible();
    await closeApp(app);

    app = await launch(dir, "ok");
    window = await app.firstWindow();
    await expect(window.getByLabel("文本 1").nth(1)).toHaveValue("教师修改后的题干");
    await expect(window.getByLabel("教师参考答案（仅供教师卷样张使用）")).toHaveValue("固定响应答案：B");
  } finally {
    await closeApp(app);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("从 PDF 提取文字并填充；扫描件无文字时引导裁图或手录", async () => {
  const dir = tempDir();
  const app = await launch(dir, "ok");
  try {
    const window = await app.firstWindow();
    await app.evaluate(({ dialog }, filename) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filename] });
    }, fixture("text.pdf"));
    await window.getByRole("button", { name: "选择 PDF 并提取文字" }).click();
    await expect(window.getByText("text.pdf", { exact: true })).toBeVisible();
    await expect(window.getByRole("checkbox", { name: /第 1 页/ })).toBeVisible();
    await expect(window.getByLabel(/待处理文字/)).toHaveValue(/Question 1: What is 2 \+ 2\?/);

    await window.getByRole("button", { name: "生成 AI 草稿…" }).click();
    await expect(window.getByRole("region", { name: "发送前确认" })).toContainText("页码：1");
    await window.getByRole("button", { name: "返回修改" }).click();

    await app.evaluate(({ dialog }, filename) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filename] });
    }, fixture("blank.pdf"));
    await window.getByRole("button", { name: "选择 PDF 并提取文字" }).click();
    await expect(window.getByRole("alert")).toContainText("未从这份 PDF 提取到文字");
    await expect(window.getByLabel(/待处理文字/)).toHaveValue("");
    await expect(window.getByRole("button", { name: "载入所选页文字" })).toBeDisabled();
  } finally {
    await closeApp(app);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("模型返回脚本或远程图片标记只按纯文字显示，不执行、不发起请求", async () => {
  const dir = tempDir();
  const app = await launch(dir, "malicious");
  try {
    const window = await app.firstWindow();
    const requests: string[] = [];
    window.on("request", (request) => requests.push(request.url()));
    await send(window, "恶意内容渲染测试");
    await expect(window.getByRole("heading", { name: "待核草稿（2 题）" })).toBeVisible();
    const first = window.getByRole("article", { name: "AI 草稿第 1 题" });
    await expect(first).toContainText("<script>window.__paperweavePwned = true</script>");
    await expect(first.locator("script, img")).toHaveCount(0);
    await expect(window.getByText("固定响应说明", { exact: false })).toContainText("<img src=");
    await window.waitForTimeout(300);
    expect(await window.evaluate(() => (globalThis as unknown as { __paperweavePwned?: boolean }).__paperweavePwned)).toBeUndefined();
    expect(requests.filter((url) => url.includes("127.0.0.1:9"))).toEqual([]);
  } finally {
    await closeApp(app);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("超时、格式错误、取消与重复提交都保留人工输入", async () => {
  for (const scenario of ["timeout", "invalid"] as const) {
    const dir = tempDir();
    const app = await launch(dir, scenario);
    try {
      const window = await app.firstWindow();
      await send(window, `异常路径 ${scenario} 的原始文字`);
      await expect(window.getByRole("alert")).toContainText(scenario === "timeout" ? "超时" : "格式无法解析");
      await expect(window.getByLabel(/待处理文字/)).toHaveValue(`异常路径 ${scenario} 的原始文字`);
    } finally {
      await closeApp(app);
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const dir = tempDir();
  const app = await launch(dir, "late");
  try {
    const window = await app.firstWindow();
    await window.getByLabel(/待处理文字/).fill("取消后仍保留的人工文字");
    await window.getByRole("button", { name: "生成 AI 草稿…" }).click();
    await window.getByRole("button", { name: "确认发送并生成草稿" }).click();
    await window.getByRole("button", { name: "取消请求" }).click();
    await expect(window.getByRole("status").first()).toContainText("已取消");
    await expect(window.getByLabel(/待处理文字/)).toHaveValue("取消后仍保留的人工文字");

    const duplicate = await window.evaluate(async () => {
      const bridge = (globalThis as unknown as { paperweave: { generateAiDraft: (id: string, input: unknown) => Promise<unknown>; cancelAiDraft: (id: string) => Promise<boolean> } }).paperweave;
      const input = { mode: "text", text: "重复提交测试", pages: [1] };
      const id = "duplicate-test-1234";
      const first = bridge.generateAiDraft(id, input);
      await new Promise((resolve) => setTimeout(resolve, 100));
      const second = await bridge.generateAiDraft(id, input).then(() => "resolved", (error: unknown) => String(error));
      await bridge.cancelAiDraft(id);
      await first.catch(() => undefined);
      return second;
    });
    expect(duplicate).toContain("重复");
  } finally {
    await closeApp(app);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("密钥只进入本机加密文件，不回显，也不进入题库", async () => {
  const dir = tempDir();
  let app = await launch(dir, "ok");
  const secret = "sk-e2e-secret-1234567890";
  try {
    let window = await app.firstWindow();
    await window.getByText("模型服务与密钥设置").click();
    const keyInput = window.getByLabel(/模型密钥/);
    await keyInput.fill(secret);
    await window.getByRole("button", { name: "加密保存密钥" }).click();
    await expect(window.getByText("密钥已加密保存在本机", { exact: false })).toBeVisible();
    await expect(keyInput).toHaveValue("");
    await expect(window.getByText("本机已有密钥")).toBeVisible();

    const db = readFileSync(path.join(dir, "paperweave.sqlite"));
    expect(db.includes(Buffer.from(secret))).toBe(false);
    const keyFile = path.join(dir, "ai-key.bin");
    expect(existsSync(keyFile)).toBe(true);
    expect(readFileSync(keyFile).includes(Buffer.from(secret))).toBe(false);

    await closeApp(app);
    app = await launch(dir, "ok");
    window = await app.firstWindow();
    await window.getByText("模型服务与密钥设置").click();
    await expect(window.getByText("本机已有密钥")).toBeVisible();
    await expect(window.getByLabel(/模型密钥/)).toHaveValue("");
  } finally {
    await closeApp(app);
    rmSync(dir, { recursive: true, force: true });
  }
});
