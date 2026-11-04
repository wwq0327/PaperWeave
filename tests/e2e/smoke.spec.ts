import { test, expect, _electron as electron } from "@playwright/test";
import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cpSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const execFileAsync = promisify(execFile);

// Playwright 只向 node_modules 的 dev Electron 注入自动化 bridge（-r loader.js），
// 无法自动化打包后的 Mach-O 产物（源码 coreBundle.js 证实）。
// 因此行为断言用本地 Electron 45.2.2 跑构建产物 .vite/build/main.cjs
// （与打包产物同版本同代码），打包产物的启动验证由「中文路径启动」用例
// 以直接 spawn + 进程存活断言覆盖。
const BUILT_MAIN = path.join(".vite", "build", "main.cjs");
const MAC_APP = path.join("out", "PaperWeave-darwin-arm64", "PaperWeave.app");

async function launchOffline(entry: string) {
  const dataDir = mkdtempSync(path.join(tmpdir(), "paperweave-smoke-"));
  const app = await electron.launch({ args: [path.resolve(entry), `--user-data-dir=${dataDir}`] });
  const requests: string[] = [];
  // 只拦 http(s)，放行 file:// —— 页面文档本身经 file:// 加载，全拦会阻止应用启动
  await app.context().route(
    (url) => url.protocol === "http:" || url.protocol === "https:",
    (route) => {
      requests.push(route.request().url());
      return route.abort();
    },
  );
  return { app, requests, dataDir };
}

test("断网启动：窗口打开、零网络请求、桥可用、渲染进程无 Node", async () => {
  const { app, requests, dataDir } = await launchOffline(BUILT_MAIN);
  const window = await app.firstWindow();
  await expect(window).toHaveTitle("拾题成卷 PaperWeave");
  await expect(window.getByRole("heading", { name: "编辑草稿" })).toBeVisible();
  const probe = await window.evaluate(() => ({
    bridge: typeof (window as unknown as { paperweave?: { getRuntimeVersions?: unknown } }).paperweave
      ?.getRuntimeVersions === "function",
    nodeInRenderer: typeof (window as unknown as { process?: unknown }).process,
  }));
  expect(probe.bridge).toBe(true);
  expect(probe.nodeInRenderer).toBe("undefined");
  // 测试模式下窗口应隐藏，避免跑套件时频繁弹窗打扰屏幕。
  const visibility = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((win) => win.isVisible()));
  expect(visibility.length).toBeGreaterThan(0);
  expect(visibility.every((visible) => visible === false)).toBe(true);
  expect(requests).toEqual([]); // Review Focus 1：零请求
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

test("打包产物从中文路径启动并存活", async () => {
  const zhDir = path.join("out", "e2e-tmp", "中文测试路径");
  rmSync(zhDir, { recursive: true, force: true });
  const copiedApp = path.join(zhDir, "PaperWeave.app");
  // verbatimSymlinks：Electron 框架内是相对符号链接，保持原样副本才自包含；
  // ad-hoc 重签：修改过的 bundle 在 Apple Silicon 上签名失效会被终止。
  cpSync(MAC_APP, copiedApp, { recursive: true, verbatimSymlinks: true });
  await execFileAsync("codesign", ["--sign", "-", "--force", "--deep", copiedApp]);
  // 评审 I-1：进程存活不覆盖「主进程活着但渲染层白屏」，加 CDP 标题断言钉住
  const debugPort = 9300 + Math.floor(Math.random() * 500);
  const child = spawn(
    path.resolve(path.join(copiedApp, "Contents", "MacOS", "PaperWeave")),
    [`--remote-debugging-port=${debugPort}`, `--user-data-dir=${path.resolve(zhDir, "user-data")}`],
    { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PAPERWEAVE_TEST: "1" } },
  );
  let stderr = "";
  child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 3000); // 存活 3 秒即视为启动成功
      child.once("exit", (code, signal) => {
        clearTimeout(timer);
        reject(new Error(`打包产物提前退出 code=${code} signal=${signal}\nstderr: ${stderr}`));
      });
    });
    expect(child.exitCode).toBeNull();
    const title = await pollCdpPageTitle(debugPort);
    expect(title).toBe("拾题成卷 PaperWeave");
  } finally {
    child.kill("SIGKILL");
    rmSync(path.join("out", "e2e-tmp"), { recursive: true, force: true });
  }
});

async function pollCdpPageTitle(port: number, timeoutMs = 15000): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json`);
      const targets = (await res.json()) as Array<{ type: string; url: string; title: string }>;
      // 冷启动（如系统负载高时）下 CDP 可能先列出 file:// 目标但标题尚未设置，
      // 必须等标题非空，否则会把「还在加载」误判为启动失败。
      const page = targets.find((t) => t.type === "page" && t.url.startsWith("file://") && t.title);
      if (page) return page.title;
    } catch {
      // CDP 尚未就绪，继续轮询
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return null;
}
