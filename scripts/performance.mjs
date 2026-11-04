#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";

// 用法：
//   node scripts/performance.mjs                 构建生产包并完整实测
//   node scripts/performance.mjs --skip-build    复用现有 .vite/build
//   node scripts/performance.mjs --fixture-only  只生成规模测试库
//   node scripts/performance.mjs --data-dir DIR  指定规模库目录（存在且标记完整时复用）
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const dataDir = path.resolve(value("--data-dir") ?? path.join("out", "performance", new Date().toISOString().replace(/[:.]/g, "-")));

if (!flag("--skip-build")) {
  const build = spawnSync("npm", ["run", "package"], { stdio: "inherit" });
  if (build.status !== 0) process.exit(build.status ?? 1);
}

const result = spawnSync("npx", ["playwright", "test", "--config=playwright.performance.config.ts"], {
  stdio: "inherit",
  env: {
    ...process.env,
    PAPERWEAVE_PERF_DIR: dataDir,
    PAPERWEAVE_PERF_FIXTURE_ONLY: flag("--fixture-only") ? "1" : "",
  },
});
console.log(`\n规模库目录：${dataDir}`);
process.exit(result.status ?? 1);
