import { test, expect, _electron as electron } from "@playwright/test";
import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cpSync, rmSync } from "node:fs";
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
  const app = await electron.launch({ args: [path.resolve(entry)] });
  const requests: string[] = [];
  // 只拦 http(s)，放行 file:// —— 页面文档本身经 file:// 加载，全拦会阻止应用启动
  await app.context().route(
    (url) => url.protocol === "http:" || url.protocol === "https:",
    (route) => {
      requests.push(route.request().url());
      return route.abort();
    },
  );
  return { app, requests };
}

test("断网启动：窗口打开、零网络请求、桥可用、渲染进程无 Node", async () => {
  const { app, requests } = await launchOffline(BUILT_MAIN);
  const window = await app.firstWindow();
  await expect(window).toHaveTitle("拾题成卷 PaperWeave");
  await expect(window.getByText(/Electron \d+\./)).toBeVisible(); // 版本由桥经 IPC 渲染
  const probe = await window.evaluate(() => ({
    bridge: typeof (window as unknown as { paperweave?: { getRuntimeVersions?: unknown } }).paperweave
      ?.getRuntimeVersions === "function",
    nodeInRenderer: typeof (window as unknown as { process?: unknown }).process,
  }));
  expect(probe.bridge).toBe(true);
  expect(probe.nodeInRenderer).toBe("undefined");
  expect(requests).toEqual([]); // Review Focus 1：零请求
  await window.screenshot({ path: path.join("tests", "e2e", "evidence", "smoke-offline.png") });
  await app.close();
});

test("打包产物从中文路径启动并存活", async () => {
  const zhDir = path.join("out", "e2e-tmp", "中文测试路径");
  rmSync(zhDir, { recursive: true, force: true });
  const copiedApp = path.join(zhDir, "PaperWeave.app");
  // verbatimSymlinks：Electron 框架内是相对符号链接，保持原样副本才自包含；
  // ad-hoc 重签：修改过的 bundle 在 Apple Silicon 上签名失效会被终止。
  cpSync(MAC_APP, copiedApp, { recursive: true, verbatimSymlinks: true });
  await execFileAsync("codesign", ["--sign", "-", "--force", "--deep", copiedApp]);
  const child = spawn(
    path.resolve(path.join(copiedApp, "Contents", "MacOS", "PaperWeave")),
    { stdio: ["ignore", "pipe", "pipe"] },
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
  } finally {
    child.kill("SIGKILL");
    rmSync(path.join("out", "e2e-tmp"), { recursive: true, force: true });
  }
});
