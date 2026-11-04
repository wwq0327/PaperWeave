# M0 工程脚手架（Issue #1）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立 Electron + TypeScript + React + Vite 工程，Electron Forge 打包 macOS Apple Silicon 与 Windows x64 产物，应用断网可启动，依赖版本精确锁定并写入基线记录。

**Architecture:** 三进程分离（main / preload / renderer），`contextIsolation` 与 `sandbox` 默认开启、nodeIntegration 关闭。渲染进程 React 经 Vite 构建为静态资源由主进程加载；preload 用 contextBridge 暴露唯一受控接口 `window.paperweave`。单元测试用 Vitest（Node 环境），端到端冒烟用 Playwright 直接启动打包产物并断网断言。

**Tech Stack:** Electron 45.2.2（精确锁定）、Electron Forge 8.0.1、Vite、React 19、TypeScript、Vitest、Playwright 1.64.1；npm（`save-exact`）管理，lockfile 入库。

**Spec:**
- Issue #1（验收清单四条目）
- `docs/开发与验收流程-V1.md` §2 M0 过关条件、§4 测试安排（检查入口、界面测试工具小范围验证）
- `docs/本地跨平台应用方案-V1.md` §4 技术选型（打包、安全默认值）、§6 当前决策

## Global Constraints

- 验收平台：macOS Apple Silicon、Windows x64（方案 §4「打包」行）
- 关键依赖版本在 M0 固定，目标值与实测值分开记录（CLAUDE.md「开发约定」）
- 上下文隔离与沙箱默认开启、关闭 Node.js 集成（方案 §4 安全段）
- 无外部网络依赖，断网可启动（Issue #1 本次范围）
- 检查入口至少覆盖：类型检查、单元与集成测试、安装包基本检查（流程 §4）
- 对外分发、签名公证不在本期（方案 §4：「对外分发时再定签名和安装包策略」）
- 业务功能（编辑器/打印/AI）不在本期，属 Issue #3–#9

## Review Focus

1. **断网启动被"测试通过"掩盖**：路由拦截若只是静默放行失败请求，应用实际依赖网络也会通过测试——smoke 测试必须断言零网络请求（含 ledger 计数为 0），见 Task 2 Step 1。
2. **中文路径启动**：教师电脑用户目录常含中文，打包应用须能从中文路径启动——smoke 含 `out/e2e-tmp/中文测试路径/` 复制副本启动变体，见 Task 2 Step 1。
3. **渲染进程拿到 Node 能力**：sandbox/contextIsolation 若没真正生效，后续所有安全基线（Issue #9）都是空中楼阁——smoke 断言 `window.process === undefined`，见 Task 2 Step 8。
4. **Windows 交叉构建产物无法在本机验证启动**：本机无 Windows 硬件，只能验证 zip 产物存在与结构，启动标"待补验"并在 PR 与基线记录注明原因与补验方式，见 Task 3 Step 5。
5. **lockfile 漂移导致"固定的版本"不重现**：`save-exact` 只锁直接依赖，间接依赖靠 lockfile——lockfile 必须随每个任务提交，CI 缺位下这是唯一可复现保障，见各任务 Commit 步骤。

---

### Task 1: 检查入口与单测骨架

**Files:**
- Create: `package.json`、`.npmrc`、`.gitignore`、`tsconfig.json`、`tsconfig.node.json`、`tsconfig.web.json`、`vitest.config.ts`
- Create: `src/shared/versions.ts`
- Test: `tests/unit/shared/versions.test.ts`

**Interfaces:**
- Consumes: 无（首个任务）
- Produces: `getRuntimeVersions(src: RuntimeVersionSource): RuntimeVersions`，类型为
  ```ts
  export interface RuntimeVersions { app: string; electron: string | null; node: string | null; chrome: string | null }
  export interface RuntimeVersionSource { app: string; electron?: string; node?: string; chrome?: string }
  ```
  Task 2 的主进程 IPC 与单元测试都依赖此签名。

- [ ] **Step 1: 初始化 package.json 与固定版本机制**

`npm init -y` 后改 `package.json`：`name: "paperweave"`、`private: true、`engines.node: "22"`、scripts 先加 `"typecheck": "tsc -b"`、`"test": "vitest run"`、`"check": "npm run typecheck && npm run test"`。
创建 `.npmrc`（内容仅一行 `save-exact=true`）使所有依赖精确锁定。
创建 `.gitignore`：`node_modules/`、`out/`、`dist/`、`*.log`、`.DS_Store`、`.vite/`。

- [ ] **Step 2: 安装检查入口依赖**

`npm i -D typescript vitest @types/node`
（Electron/Forge/React/Playwright 属 Task 2/3 交付物所需，不在此安装。）

- [ ] **Step 3: TypeScript 与 Vitest 配置**

`tsconfig.json`：solution 文件，仅 `references: [{path: tsconfig.node.json}, {path: tsconfig.web.json}]`。
`tsconfig.node.json`：`composite: true, noEmit: true, module: NodeNext, moduleResolution: NodeNext, types: ["node"]`，include `src/main`、`src/preload`、`src/shared`、`tests/unit`、`*.config.ts`、`forge.config.ts`。
`tsconfig.web.json`：`composite: true, noEmit: true, module: ESNext, moduleResolution: bundler, jsx: react-jsx, lib: [ESNext, DOM, DOM.Iterable]`，include `src/renderer`。
`vitest.config.ts`：`test.include: ["tests/unit/**/*.test.ts"]`，环境 node。

- [ ] **Step 4: 写失败测试**

`tests/unit/shared/versions.test.ts`：
```ts
import { describe, expect, it } from "vitest";
import { getRuntimeVersions } from "../../../src/shared/versions";

describe("getRuntimeVersions", () => {
  it("返回固定四键，缺失来源置 null", () => {
    expect(getRuntimeVersions({ app: "paperweave@1.0.0" }))
      .toEqual({ app: "paperweave@1.0.0", electron: null, node: null, chrome: null });
    expect(getRuntimeVersions({ app: "a@0.0.1", electron: "45.2.2", node: "22.11.0", chrome: "138.0.0" }))
      .toEqual({ app: "a@0.0.1", electron: "45.2.2", node: "22.11.0", chrome: "138.0.0" });
  });
});
```

- [ ] **Step 5: 运行确认失败**

Run: `npm run test`
Expected: FAIL，报 `Cannot find module '../../../src/shared/versions'`

- [ ] **Step 6: 实现 `src/shared/versions.ts`**

按 Interfaces 签名实现：透传存在的来源值，缺失的置 `null`。

- [ ] **Step 7: 运行确认通过 + 全量检查**

Run: `npm run check`
Expected: typecheck 与单测全部 PASS

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json .npmrc .gitignore tsconfig*.json vitest.config.ts src/shared/versions.ts tests/unit/shared/versions.test.ts
git commit -m "feat: 工程检查入口与版本模块单测骨架"
```

---

### Task 2: 三进程骨架 + 断网冒烟 E2E

**Files:**
- Create: `forge.config.ts`、`vite.main.config.ts`、`vite.preload.config.ts`、`vite.renderer.config.ts`、`playwright.config.ts`
- Create: `src/main.ts`、`src/main/window.ts`、`src/preload.ts`、`src/renderer/index.html`、`src/renderer/main.tsx`、`src/renderer/App.tsx`、`src/renderer/env.d.ts`
- Test: `tests/e2e/smoke.spec.ts`

**Interfaces:**
- Consumes: Task 1 的 `getRuntimeVersions` / `RuntimeVersions`（主进程 IPC handler 调用）
- Produces:
  - `window.paperweave`（contextBridge 暴露）：`{ getRuntimeVersions(): Promise<RuntimeVersions>; platform: string }`——后续所有任务经此桥或扩展后的同类桥通信
  - IPC 通道名：`app:getRuntimeVersions`（ipcMain.handle 注册）
  - 打包产物路径约定：`out/PaperWeave-darwin-arm64/PaperWeave.app/Contents/MacOS/PaperWeave`（Task 3、E2E、证据步骤依赖）
  - 证据目录：`tests/e2e/evidence/`（入库），运行截图每次覆盖同名文件

- [ ] **Step 1: 写失败 E2E 冒烟测试**

`tests/e2e/smoke.spec.ts` 必须包含四条用例（断网 ledger、标题、桥与沙箱断言、中文路径变体）：
```ts
import { test, expect, _electron as electron } from "@playwright/test";
import { cpSync, rmSync, existsSync } from "node:fs";
import path from "node:path";

const MAC_APP = path.join("out", "PaperWeave-darwin-arm64", "PaperWeave.app", "Contents", "MacOS", "PaperWeave");

async function launchOffline(appPath: string) {
  const app = await electron.launch({ args: [path.resolve(appPath)] });
  const requests: string[] = [];
  await app.context().route("**/*", (route) => {
    requests.push(route.request().url());
    return route.abort();
  });
  return { app, requests };
}

test("断网启动：窗口打开、零网络请求、桥可用、渲染进程无 Node", async () => {
  const { app, requests } = await launchOffline(MAC_APP);
  const window = await app.firstWindow();
  await expect(window).toHaveTitle("拾题成卷 PaperWeave");
  await expect(window.getByText(/Electron \d+\./)).toBeVisible(); // 版本由桥经 IPC 渲染
  const probe = await window.evaluate(() => ({
    bridge: typeof (window as any).paperweave?.getRuntimeVersions === "function",
    nodeInRenderer: typeof (window as any).process,
  }));
  expect(probe.bridge).toBe(true);
  expect(probe.nodeInRenderer).toBe("undefined");
  expect(requests).toEqual([]); // Review Focus 1：零请求
  await window.screenshot({ path: path.join("tests", "e2e", "evidence", "smoke-offline.png") });
  await app.close();
});

test("中文路径启动", async () => {
  const zhDir = path.join("out", "e2e-tmp", "中文测试路径");
  rmSync(zhDir, { recursive: true, force: true });
  cpSync(path.dirname(path.dirname(MAC_APP)), path.join(zhDir, "PaperWeave.app"), { recursive: true });
  const { app } = await launchOffline(path.join(zhDir, "PaperWeave.app", "Contents", "MacOS", "PaperWeave"));
  const window = await app.firstWindow();
  await expect(window).toHaveTitle("拾题成卷 PaperWeave");
  await app.close();
  rmSync(path.join("out", "e2e-tmp"), { recursive: true, force: true });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm run test:e2e`
Expected: FAIL（Electron 与 Playwright 尚未安装，或打包产物不存在）

- [ ] **Step 3: 安装本任务依赖**

`npm i -D electron@45.2.2 @electron-forge/cli@8.0.1 @electron-forge/maker-zip@8.0.1 @electron-forge/maker-dmg@8.0.1 @electron-forge/plugin-vite@8.0.1 vite @vitejs/plugin-react playwright@1.64.1`
`npm i react react-dom`（devDeps 追加 `@types/react @types/react-dom`）
安装后确认 `package.json` 中全部为精确版本（无 `^`/`~`），否则检查 `.npmrc` 是否生效。

- [ ] **Step 4: Forge 与 Vite 配置**

`forge.config.ts`：plugin-vite 挂载 `vite.main.config.ts` / `vite.preload.config.ts` / `vite.renderer.config.ts`；packagerConfig `{ name: "PaperWeave", appBundleId: "com.wwq0327.paperweave" }`；makers 与平台条件留 Task 3。
`vite.main.config.ts`：`build.lib.entry: "src/main.ts"`，formats `["cjs"]`，external `electron` 与 `node:*`。
`vite.preload.config.ts`：同上，entry `src/preload.ts`（sandbox 下 preload 必须为 CJS）。
`vite.renderer.config.ts`：`root: "src/renderer"`，`base: "./"`（file:// 加载的必要条件），`plugins: [react()]`，`build.rollupOptions.input: "src/renderer/index.html"`。

- [ ] **Step 5: 主进程与窗口**

`src/main.ts`：`app.whenReady()` 后 `createMainWindow()`；`activate` 事件 macOS 重建窗口；`window-all-closed` 非 darwin 退出。
`src/main/window.ts`：`createMainWindow(): BrowserWindow`——窗口 `title: "拾题成卷 PaperWeave"`，尺寸 1280×800；`webPreferences` 严格按方案：`contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, preload: join(__dirname, "../preload/index.js")`；加载 `../renderer/index.html`（打包后为相对路径）。
同文件注册 `ipcMain.handle("app:getRuntimeVersions", () => getRuntimeVersions({ app: `${app.getName()}@${app.getVersion()}`, electron: process.versions.electron, node: process.versions.node, chrome: process.versions.chrome }))`。

- [ ] **Step 6: preload 桥**

`src/preload.ts`：`contextBridge.exposeInMainWorld("paperweave", { getRuntimeVersions: () => ipcRenderer.invoke("app:getRuntimeVersions"), platform: process.platform })`。

- [ ] **Step 7: React 首屏**

`src/renderer/index.html`（标题 `拾题成卷 PaperWeave`，`#root`，相对路径 script）、`main.tsx`、`App.tsx`：挂载后 `await window.paperweave.getRuntimeVersions()` 渲染应用名与 Electron/Node/Chrome 版本（加载中状态占位）、`env.d.ts` 按 Produces 的桥类型声明全局。

- [ ] **Step 8: 打包并跑通 E2E**

Run: `npm run test:e2e`（脚本为 `npm run package && playwright test`；`playwright.config.ts` 设 `testDir: "tests/e2e"`、`workers: 1`、`timeout: 60000`）
Expected: 两条用例 PASS；`tests/e2e/evidence/smoke-offline.png` 生成。

- [ ] **Step 9: LaunchServices 启动实测（双击等价证据）**

```bash
open -a "$PWD/out/PaperWeave-darwin-arm64/PaperWeave.app"
sleep 3
pgrep -f "PaperWeave.app" && screencapture -x tests/e2e/evidence/launchservices-open.png
osascript -e 'quit app "PaperWeave"'
```
Expected: `pgrep` 找到进程，截图为应用窗口存在；输出原样留作 PR 证据。

- [ ] **Step 10: Commit**

```bash
git add package.json package-lock.json forge.config.ts vite.*.config.ts playwright.config.ts src/ tests/e2e/
git commit -m "feat: Electron 三进程骨架与断网冒烟 E2E"
```

---

### Task 3: 双平台打包与产物检查

**Files:**
- Modify: `forge.config.ts`（makers 段）、`package.json`（scripts）
- Create: `scripts/check-artifacts.mjs`

**Interfaces:**
- Consumes: Task 2 的打包产物路径约定
- Produces: `npm run check:artifacts` 检查入口（流程 §4 要求"安装包基本检查"）；`make:win` 交叉构建命令；产物清单输出（Task 4 基线记录引用其输出格式：路径 + 字节数）

- [ ] **Step 1: 写失败的产物检查脚本**

`scripts/check-artifacts.mjs`：校验以下路径存在且非空，缺失时 `process.exit(1)` 并打印缺失项——
- `out/PaperWeave-darwin-arm64/PaperWeave.app/Contents/Info.plist`
- `out/make/zip/darwin/arm64/` 下恰好一个 `*.zip`
- `out/make/zip/win32/x64/` 下恰好一个 `*.zip`
找到时 `console.table` 输出每个产物的相对路径与字节数。

- [ ] **Step 2: 运行确认失败**

Run: `npm run package && npm run check:artifacts`
Expected: FAIL 并列出 win32 zip 缺失（尚未交叉构建）

- [ ] **Step 3: 配置 makers**

`forge.config.ts` makers：
- `@electron-forge/maker-zip`（darwin 与 win32 产物）
- `@electron-forge/maker-dmg` `{ format: "ULFO" }`（darwin）
- maker-squirrel（Windows 安装器）仅在 `process.platform === "win32"` 时加入数组，注释标明：本机无 Windows 硬件，安装器制作与启动标"待补验"，补验方式见 PR 与基线记录。

`package.json` scripts 增加：`"make": "electron-forge make"`、`"make:win": "electron-forge make --platform=win32 --arch=x64"`、`"check:artifacts": "node scripts/check-artifacts.mjs"`。

- [ ] **Step 4: 构建双平台产物**

Run: `npm run make && npm run make:win`
Expected: 生成 darwin arm64 zip+dmg、win32 x64 zip；命令输出中的产物路径留作记录。

- [ ] **Step 5: 产物检查通过 + Commit**

Run: `npm run check:artifacts`
Expected: PASS，`console.table` 产物清单输出。
Commit: `git add forge.config.ts package.json scripts/check-artifacts.mjs && git commit -m "feat: 双平台打包 makers 与产物检查入口"`

---

### Task 4: 基线记录与 PR 交付

**Files:**
- Create: `docs/基线记录.md`
- Modify: Issue #1 验收清单（PR 合并后回填）

**Interfaces:**
- Consumes: Task 2 E2E 输出（Electron/Node/Chrome 版本实测值）、Task 3 产物清单、`npm ls --depth=0` 输出
- Produces: `docs/基线记录.md`（Issue #2 在此文件继续补充机器规模与耗时目标）

- [ ] **Step 1: 写基线记录**

`docs/基线记录.md`，格式为表格 + 「目标值 / 实测值」分列，本期内容：
- 依赖版本：Electron、内置 Node、内置 Chrome、@electron-forge/cli、Vite、React、TypeScript、Vitest、Playwright——实测值取自 E2E 输出与 `npm ls --depth=0`，逐条精确版本
- 开发机：macOS Darwin 27.2.0 / Apple Silicon（`uname -m` 实测）、node 22.23.3
- 打包产物：macOS zip+dmg、Windows x64 zip 的路径与字节数
- 待补验一节：Windows 上安装并启动（原因：无 Windows 硬件；补验方式：Windows 机器上解压 zip 运行 `PaperWeave.exe` 并断网启动）；macOS 双击安装到 /Applications 的终验留给纸样复核批次
- 注明：规模与耗时目标由 Issue #2（ACC-12）补充

- [ ] **Step 2: Commit + Push + 建 PR**

```bash
git add docs/基线记录.md
git commit -m "docs: M0 脚手架依赖与产物基线记录"
git push -u origin feat/1-electron-scaffold
gh pr create --title "M0：工程脚手架——Electron 双平台安装包与断网启动" --body "<见 Step 3>"
```

- [ ] **Step 3: PR 描述与 Issue 回填**

PR body 必含：Issue #1 验收清单四条的逐项状态与证据路径（E2E 输出、两张截图、产物清单、`open -a` 输出原文）、待补验项原因与补验方式、关键决策记录（Electron 45.2.2 / Forge 8.0.1 / Playwright 选型理由：Electron 官方支持、不下载浏览器内核）。PR 合并后 `gh issue comment 1` 回填同样状态。

---

## Self-Review 记录

1. **Spec 覆盖**：Issue #1 四条验收——macOS 启动（Task 2 Step 8/9）、Windows 构建（Task 3 Step 4，启动待补验）、断网启动（Task 2 Step 1 用例 1）、版本写入基线（Task 4）；范围四条——三进程+隔离沙箱（Task 2 Step 4–6）、Forge 双平台（Task 3）、首屏最小界面（Task 2 Step 7）、无网络依赖（Task 2 全链）。无缺口。
2. **步骤粒度**：每个 Step 只决定一件事；实现体只出现在签名与测试不能确定处（config 值、IPC 通道名）。
3. **类型一致**：`RuntimeVersions` 四键在 Task 1 定义、Task 2 桥/E2E、Task 4 基线三处同名同形；`window.paperweave` 形状仅 Produces 一处定义。
4. **Review Focus**：5 条均已钉到 Task 2 Step 1/8（1、2、3）、Task 3 Step 5（4）、各 Commit 步骤（5）。
5. **比例**：计划描述脚手架而非业务代码，无算法体；代码块仅为测试与配置 exact 值，符合"计划是执行者不能独自做的决定"。
