// 使用独立数据目录启动 macOS 安装包，验证实际主进程建库及重开。
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

if (process.platform !== "darwin") throw new Error("此检查目前仅支持 macOS");
const executable = resolve("out/PaperWeave-darwin-arm64/PaperWeave.app/Contents/MacOS/PaperWeave");
const dataVersion = Number(/const DATA_VERSION = (\d+);/.exec(readFileSync("src/main/database.ts", "utf8"))?.[1]);
if (!Number.isInteger(dataVersion)) throw new Error("无法从 src/main/database.ts 读取 DATA_VERSION");
const dir = mkdtempSync(join(tmpdir(), "paperweave-packaged-"));
const file = join(dir, "paperweave.sqlite");
const probe = (script) => {
  const result = spawnSync(executable, ["-e", script, file], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || `检查进程退出：${result.status}`);
  return result.stdout.trim();
};
async function startAndWait() {
  const portFile = join(dir, "DevToolsActivePort");
  rmSync(portFile, { force: true });
  const child = spawn(executable, [`--user-data-dir=${dir}`, "--remote-debugging-port=0"], { stdio: "ignore", env: { ...process.env, PAPERWEAVE_TEST: "1" } });
  try {
    for (let i = 0; i < 100 && !existsSync(file); i++) {
      if (child.exitCode !== null) throw new Error(`应用提前退出：${child.exitCode}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!existsSync(file)) throw new Error("打包应用未在隔离目录建库");
    // 等到本次进程窗口就绪，避免旧库存在时把尚未启动的重开误记为通过。
    for (let i = 0; i < 100; i++) {
      try {
        if (child.exitCode !== null) throw new Error("应用提前退出");
        const port = Number(readFileSync(portFile, "utf8").split("\n")[0]);
        const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
        if (pages.some((page) => page.type === "page" && page.title === "拾题成卷 PaperWeave") &&
            probe("const d=new (require('node:sqlite').DatabaseSync)(process.argv[1]); console.log(d.prepare('PRAGMA user_version').get().user_version); d.close()") === String(dataVersion)) return child;
      } catch { /* 应用尚未就绪 */ }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("建库迁移未完成");
  } catch (error) {
    await stop(child);
    throw error;
  }
}
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  await exited;
}
try {
  let app = await startAndWait();
  await stop(app);
  const version = probe("const d=new (require('node:sqlite').DatabaseSync)(process.argv[1]); d.prepare('INSERT INTO app_settings VALUES (?, ?)').run('测试','保留'); console.log(d.prepare('SELECT sqlite_version() AS version').get().version); d.close()");
  app = await startAndWait();
  await stop(app);
  const value = probe("const d=new (require('node:sqlite').DatabaseSync)(process.argv[1]); console.log(d.prepare('SELECT value FROM app_settings WHERE key = ?').get('测试').value); d.close()");
  if (value !== "保留") throw new Error("重开后数据不一致");
  console.log(`打包应用建库、写入和重开通过；SQLite ${version}`);
} finally {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
