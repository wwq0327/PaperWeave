// 安装包深度核验：直接启动打包后的 PaperWeave.app，通过 CDP 检查
// 标题、CSP、桥接口、渲染进程隔离、零网络请求与草稿保存重开。
// Playwright 无法向打包 Mach-O 注入自动化 bridge，这里用 remote-debugging-port + CDP。
// 运行前需先 `npm run package`（或 `npm run test:e2e`，其会先打包）。
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const APP = path.join("out", "PaperWeave-darwin-arm64", "PaperWeave.app", "Contents", "MacOS", "PaperWeave");
const failures = [];
const ok = (label, condition, detail = "") => {
  console.log(`${condition ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!condition) failures.push(label);
};

if (!existsSync(APP)) {
  console.error(`未找到安装包产物：${APP}，请先运行 npm run package`);
  process.exit(1);
}

const dataDir = mkdtempSync(path.join(tmpdir(), "paperweave-packaged-"));
const port = 9300 + Math.floor(Math.random() * 500);
const child = spawn(path.resolve(APP), [
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${dataDir}`,
], { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, PAPERWEAVE_TEST: "1" } });
let stderr = "";
child.stderr.on("data", (d) => (stderr += d.toString()));

async function cdpTargets() {
  const res = await fetch(`http://127.0.0.1:${port}/json`);
  return (await res.json());
}

let ws;
let messageId = 0;
const pending = new Map();
const networkRequests = [];
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++messageId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

try {
  // 等 CDP 就绪并找到 file:// 页面
  let target;
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`安装包提前退出 code=${child.exitCode}\n${stderr}`);
    try {
      const targets = await cdpTargets();
      target = targets.find((t) => t.type === "page" && t.url.startsWith("file://"));
      if (target) break;
    } catch { /* CDP 未就绪 */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  if (!target) throw new Error("未找到安装包的 file:// 页面目标");

  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id).resolve(message);
      pending.delete(message.id);
    } else if (message.method === "Network.requestWillBeSent") {
      networkRequests.push(message.params.request.url);
    }
  };

  await send("Network.enable");
  await send("Runtime.enable");
  // 等应用渲染完成
  await new Promise((r) => setTimeout(r, 2500));

  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.result?.exceptionDetails) throw new Error(`页面内求值失败：${JSON.stringify(result.result.exceptionDetails).slice(0, 200)}`);
    return result.result?.result?.value;
  };

  const probe = await evaluate(`(() => {
    const csp = document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute("content") ?? "";
    const w = window;
    return {
      title: document.title,
      csp,
      globals: ["process", "require", "module", "ipcRenderer", "Buffer", "electron"].map((n) => n + ":" + typeof w[n]),
      bridgeKeys: typeof w.paperweave === "object" && w.paperweave ? Object.keys(w.paperweave).sort() : [],
    };
  })()`);
  ok("窗口标题", probe.title === "拾题成卷 PaperWeave", probe.title);
  ok("CSP default-src 'none'", probe.csp.includes("default-src 'none'"));
  ok("CSP connect-src 'none'", probe.csp.includes("connect-src 'none'"));
  ok("CSP script-src 'self'", probe.csp.includes("script-src 'self'"));
  ok("渲染进程无 Node 全局", probe.globals.every((g) => g.endsWith(":undefined")), probe.globals.join(" "));
  ok("桥接口 62 个", probe.bridgeKeys.length === 62, `实际 ${probe.bridgeKeys.length}`);

  const config = await evaluate(`window.paperweave.getAiConfig()`);
  ok("AI 配置默认值且无密钥", config && config.hasKey === false && config.baseUrl === "https://api.anthropic.com", JSON.stringify(config));

  const versions = await evaluate(`window.paperweave.getRuntimeVersions()`);
  ok("运行信息只读可用", versions && typeof versions.electron === "string" && versions.electron.length > 0);

  await evaluate(`window.paperweave.saveDraft({ version: 2, blocks: [{ type: "paragraph", runs: [{ type: "text", text: "安装包核验草稿", style: "普通" }] }], teacherAnswer: "安装包核验答案" })`);
  const draft = await evaluate(`window.paperweave.loadDraft()`);
  ok("安装包内草稿保存重开一致",
    draft?.version === 3 && draft.blocks?.[0]?.runs?.[0]?.text === "安装包核验草稿" && draft.teacherAnswer === "安装包核验答案");

  const httpRequests = networkRequests.filter((url) => url.startsWith("http://") || url.startsWith("https://"));
  ok("零网络请求", httpRequests.length === 0, httpRequests.slice(0, 3).join(" "));

  const editorVisible = await evaluate(`!!document.querySelector("h1") && document.querySelector("h1").textContent`);
  ok("编辑界面已渲染", editorVisible === "编辑草稿", String(editorVisible));
} catch (error) {
  console.error(`核验中断：${String(error).slice(0, 300)}`);
  failures.push("核验流程未跑完");
} finally {
  child.kill("SIGKILL");
  await new Promise((r) => setTimeout(r, 500));
  rmSync(dataDir, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`\n安装包核验未通过（${failures.length} 项）：${failures.join("；")}`);
  process.exit(1);
}
console.log("\n安装包核验全部通过");
