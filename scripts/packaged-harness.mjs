// 打包应用自动化底座：通过 Node inspector 操作主进程，通过 CDP 驱动渲染进程。
// Playwright 无法向打包后的 Mach-O 注入 bridge，但 Electron 仍开放 --inspect 与
// --remote-debugging-port；两者合起来等价于开发态的 app.evaluate + page。
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "@playwright/test";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function connectInspector(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let id = 0;
    const pending = new Map();
    const send = (method, params = {}) => new Promise((done, fail) => {
      const messageId = ++id;
      pending.set(messageId, { done, fail });
      ws.send(JSON.stringify({ id: messageId, method, params }));
    });
    ws.onopen = () => resolve({
      evaluate: (expression) => send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, includeCommandLineAPI: true })
        .then((message) => {
          if (message.result?.exceptionDetails) throw new Error(`主进程求值失败：${JSON.stringify(message.result.exceptionDetails).slice(0, 300)}`);
          return message.result?.result?.value;
        }),
      send,
      close: () => ws.close(),
    });
    ws.onerror = reject;
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (!message.id || !pending.has(message.id)) return;
      const { done, fail } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) fail(new Error(message.error.message ?? "inspector 调用失败"));
      else done(message);
    };
  });
}

async function waitForTarget(port, type, deadline) {
  while (Date.now() < deadline) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const target = targets.find((entry) => entry.type === type);
      if (target) return target;
    } catch { /* inspector 未就绪 */ }
    await wait(200);
  }
  return undefined;
}

/**
 * 启动打包应用。userData 可含中文；env 会叠加到应用进程。
 * 返回 page（Playwright）、main（主进程 eval）、child 与关闭方法。
 */
export async function launchPackaged({ appPath, userData, env = {} }) {
  mkdirSync(userData, { recursive: true });
  const nodePort = 9400 + Math.floor(Math.random() * 400);
  const pagePort = 9900 + Math.floor(Math.random() * 400);
  const child = spawn(appPath, [
    `--inspect=${nodePort}`,
    `--remote-debugging-port=${pagePort}`,
    `--user-data-dir=${userData}`,
  ], {
    stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, PAPERWEAVE_TEST: "1", ...env },
  });
  let stderr = "";
  child.stderr.on("data", (data) => { stderr += data.toString(); });

  const deadline = Date.now() + 20_000;
  const nodeTarget = await waitForTarget(nodePort, "node", deadline);
  if (!nodeTarget) throw new Error(`主进程 inspector 未就绪：${stderr.slice(0, 500)}`);
  const main = await connectInspector(nodeTarget.webSocketDebuggerUrl);

  let browser;
  while (Date.now() < deadline && !browser) {
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${pagePort}`); }
    catch { await wait(300); }
  }
  if (!browser) throw new Error(`渲染进程 CDP 未就绪：${stderr.slice(0, 500)}`);

  let page;
  while (Date.now() < deadline && !page) {
    const context = browser.contexts()[0];
    page = context?.pages().find((entry) => entry.url().startsWith("file://"));
    if (!page) await wait(200);
  }
  if (!page) throw new Error("未找到应用页面");
  await page.waitForSelector("h1", { timeout: 30_000 });

  const harness = {
    page,
    child,
    stderr: () => stderr,
    mainEval: (expression) => main.evaluate(expression),
    setOpenPath: (target) => main.evaluate(`globalThis.__pwOpenPath = ${JSON.stringify(target)}; true`),
    openedFiles: () => main.evaluate("globalThis.__pwOpened ?? []"),
    networkAttempts: () => main.evaluate("globalThis.__pwNetwork ?? []"),
    async close() {
      try { await main.evaluate("require('electron').app.exit(0)"); } catch { /* 已退出 */ }
      await waitForExit(child, 5_000).catch(() => child.kill("SIGKILL"));
      await browser.close().catch(() => undefined);
      main.close();
    },
  };
  return harness;
}

export function waitForExit(child, timeout) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null) return resolve(child.exitCode);
    const timer = setTimeout(() => reject(new Error("应用退出超时")), timeout);
    child.once("exit", (code) => { clearTimeout(timer); resolve(code ?? 0); });
  });
}

/** 主进程桩：文件选择、PDF 打开、错误框、断网；全部记录到 globalThis。 */
export async function installStubs(harness, { openPath = null, errorFile = null } = {}) {
  await harness.mainEval(`(() => {
    const { dialog, shell, session } = require("electron");
    globalThis.__pwOpenPath = ${JSON.stringify(openPath)};
    globalThis.__pwOpened = [];
    globalThis.__pwNetwork = [];
    dialog.showOpenDialog = async () => globalThis.__pwOpenPath
      ? { canceled: false, filePaths: [globalThis.__pwOpenPath] }
      : { canceled: true, filePaths: [] };
    dialog.showSaveDialog = async () => ({ canceled: true, filePath: undefined });
    dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
    dialog.showErrorBox = (title, content) => {
      ${errorFile ? `require("node:fs").writeFileSync(${JSON.stringify(errorFile)}, JSON.stringify({ title, content }));` : ""}
    };
    shell.openPath = async (file) => { globalThis.__pwOpened.push(file); return ""; };
    session.defaultSession.webRequest.onBeforeRequest(
      { urls: ["http://*/*", "https://*/*"] },
      (details, callback) => { globalThis.__pwNetwork.push(details.url); callback({ cancel: true }); },
    );
    return true;
  })()`);
}

export async function extractPdf(file) {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const data = new Uint8Array(readFileSync(file));
  const document = await getDocument({ data, useSystemFonts: true }).promise;
  const pages = [];
  for (let index = 1; index <= document.numPages; index++) {
    const page = await document.getPage(index);
    const content = await page.getTextContent();
    pages.push(content.items.map((item) => ("str" in item ? item.str : "")).join(" "));
  }
  return { pages: pages.length, text: pages.join("\n").normalize("NFKC") };
}

export function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/**
 * 打包应用内完整走查：导入原卷 → 录题（含公式和裁图）→ 审核 → 入篮建卷 →
 * 定稿并打开双卷。返回导出目录与学生／教师 PDF 路径。
 */
export async function runWorkflow(harness, { fixture, examTitle, paperTitle, exportRoot, stem, answer, confirmFinalize = true }) {
  const { page } = harness;
  await harness.setOpenPath(fixture);
  await page.getByRole("button", { name: "考试原卷" }).click();
  await page.getByLabel("考试标题").fill(examTitle);
  await page.getByLabel("年份").fill("2026");
  await page.getByLabel("来源").fill("自制合成");
  await page.getByRole("button", { name: "选择 PDF 并导入" }).click();
  await page.getByText(`已导入「${examTitle}」。`, { exact: true }).waitFor({ timeout: 30_000 });
  await page.getByRole("button", { name: "进入录题" }).click();
  await page.getByRole("region", { name: "原卷预览" }).waitFor();
  await page.getByAltText("原卷第 1 页").waitFor({ timeout: 30_000 });

  await page.getByLabel("原卷页码", { exact: true }).fill("2");
  await page.getByLabel("原题号").fill("1");
  await page.getByLabel("知识点（逗号分隔）").fill("一元二次方程");
  await page.getByLabel("题干 文字 1", { exact: true }).fill(stem);
  await page.getByLabel("小问 1 题干 文字 1", { exact: true }).fill("求 $x^2+1$ 的值。");
  await page.getByLabel("小问号").fill("(1)");
  await page.getByLabel("原分值").fill("4");
  const answerGroup = page.getByRole("group", { name: "小问 1 答案" });
  await answerGroup.getByRole("button", { name: "添加文字" }).click();
  await page.getByLabel("小问 1 答案 文字 1", { exact: true }).fill(answer);
  const scoringGroup = page.getByRole("group", { name: "小问 1 评分点" });
  await scoringGroup.getByRole("button", { name: "添加评分点" }).click();
  await scoringGroup.getByLabel("说明").fill("答案正确");
  await scoringGroup.getByLabel("分值").fill("4");
  const promptGroup = page.getByRole("group", { name: "小问 1 题干" });
  await promptGroup.getByRole("button", { name: "插入裁图" }).click();
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
  await page.getByText("裁图已插入当前编辑目标。", { exact: true }).waitFor();
  await page.getByRole("button", { name: "提交待核" }).click();
  await page.getByText("已提交待核（版本 1）。", { exact: true }).waitFor();

  await page.getByRole("button", { name: "返回考试原卷" }).click();
  await page.getByRole("button", { name: "返回录题草稿" }).click();
  await page.getByRole("button", { name: "题目审核" }).click();
  await page.getByRole("heading", { name: "题目审核" }).waitFor();
  const card = page.locator(".paper-card", { hasText: stem });
  await card.waitFor();
  await card.getByRole("button", { name: "查看并审核" }).click();
  const detail = page.getByRole("region", { name: "题目审核详情" });
  await detail.waitFor();
  await detail.locator(".katex").first().waitFor();
  await detail.getByRole("button", { name: "通过内容审核" }).click();
  await page.getByText("内容已通过审核。", { exact: true }).waitFor();
  await detail.getByRole("button", { name: "通过答案审核" }).click();
  await page.getByText("答案与评分已通过审核。", { exact: true }).waitFor();

  await page.getByRole("button", { name: "去题库与组卷" }).click();
  const result = page.locator(".paper-card", { hasText: stem });
  await result.waitFor();
  await result.getByRole("button", { name: "整题入篮" }).click();
  await page.getByText("已加入题篮。", { exact: true }).waitFor();
  await page.getByLabel("标题", { exact: true }).fill(paperTitle);
  await page.getByRole("button", { name: "创建试卷" }).click();
  await page.getByRole("button", { name: "添加小节" }).click();
  await page.getByRole("region", { name: "题篮" }).getByRole("button", { name: "加入试卷" }).click();
  await page.getByText("总分 4 分").waitFor();
  await page.getByRole("button", { name: "检查定稿" }).click();
  await page.getByText("定稿检查通过。", { exact: true }).waitFor();

  await harness.setOpenPath(exportRoot);
  await page.getByRole("button", { name: "生成学生卷与教师答案卷" }).click();
  if (confirmFinalize) {
    const confirm = page.getByRole("dialog", { name: "确认定稿" });
    await confirm.waitFor({ timeout: 60_000 });
    await confirm.getByRole("button", { name: "确认保存为定稿" }).click();
  }
  await page.getByText(/双卷已保存为定稿|学生卷与教师答案卷已保存并打开/).waitFor({ timeout: 60_000 });
  const directory = readdirSync(exportRoot).filter((name) => name.startsWith("拾题成卷-")).sort().at(-1);
  if (!directory) throw new Error("未找到导出的双卷目录");
  return {
    directory: join(exportRoot, directory),
    student: join(exportRoot, directory, "学生卷.pdf"),
    teacher: join(exportRoot, directory, "教师答案卷.pdf"),
  };
}

export function assert(condition, label, detail = "") {
  if (condition) {
    console.log(`✓ ${label}${detail ? ` — ${detail}` : ""}`);
    return true;
  }
  console.log(`✗ ${label}${detail ? ` — ${detail}` : ""}`);
  return false;
}
