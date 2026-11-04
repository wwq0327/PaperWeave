import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { extractPdfText } from "../../src/main/pdf-text";
import { createFixture, fixtureSummary, HIT_KEYWORDS, MISS_KEYWORDS, readFixture, SCALE, type FixtureInfo } from "./fixture";

/**
 * M4 规模与性能实测（Issue #65 / REQ-07 / ACC-12）。
 * 方法：docs/基线记录.md「测量方法与目标」——同一隔离库、断网、本地磁盘，
 * 每项预热一次后连续 5 次，记录全部结果与最大值，慢次不剔除。
 * 受自动化限制，使用 Electron 45.2.2 运行生产构建 .vite/build/main.cjs
 * （与打包产物同版本同代码）；安装包冷启动与可见窗口人工复核单独记录。
 */

const entry = path.resolve(".vite/build/main.cjs");
const RESULTS_FILE = path.resolve("docs", "性能实测结果.json");
const APP_VERSION = (JSON.parse(readFileSync("package.json", "utf8")) as { version: string }).version;
const RUNS = 5;
const TARGETS = { coldStart: 10_000, search: 2_000, save: 5_000, export: 30_000, backup: 300_000 } as const;

interface RunResult {
  operation: string;
  variant: string;
  unit: "ms";
  target: number;
  values: number[];
  max: number;
  passed: boolean;
}

interface Verification {
  export?: { runs: { studentBytes: number; teacherBytes: number; studentPages: number; teacherPages: number }[] };
  draft?: { blocks: number; text: string; imageBytes: number; imageId: string };
  backup?: { totalBytes: number; fileCount: number }[];
}

function summarize(operation: string, variant: string, target: number, values: number[]): RunResult {
  const max = Math.max(...values);
  return { operation, variant, unit: "ms", target, values, max, passed: max <= target };
}

async function launch(dataDir: string): Promise<{ app: ElectronApplication; page: Page; requests: string[] }> {
  const app = await electron.launch({
    args: [entry, `--user-data-dir=${dataDir}`],
    // 实测使用可见窗口（与教师实际使用一致）；测试套件的隐藏窗口模式不用于计时。
    env: { ...process.env, PAPERWEAVE_TEST: "" },
  });
  const requests: string[] = [];
  await app.context().route(
    (url) => url.protocol === "http:" || url.protocol === "https:",
    (route) => {
      requests.push(route.request().url());
      return route.abort();
    },
  );
  const page = await app.firstWindow();
  await page.bringToFront().catch(() => undefined);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.focus()).catch(() => undefined);
  return { app, page, requests };
}

async function waitForEditor(page: Page): Promise<void> {
  await expect(page.getByRole("heading", { name: "编辑草稿" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: "题库与组卷" })).toBeVisible();
}

async function close(app: ElectronApplication): Promise<void> {
  await app.close().catch(async () => {
    await app.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => undefined);
  });
}

async function openPaperWorkbench(page: Page): Promise<void> {
  await page.getByRole("button", { name: "题库与组卷" }).click();
  await expect(page.getByRole("heading", { name: "题库与组卷" })).toBeVisible();
  await expect(page.getByRole("heading", { name: /九年级数学规模测试卷/ })).toBeVisible({ timeout: 30_000 });
}

async function measureSearch(page: Page, keyword: string, hit: boolean): Promise<number> {
  await page.getByLabel("关键词").fill(keyword);
  return page.evaluate(async ({ wanted, hit }) => {
    const section = document.querySelector<HTMLElement>('[aria-label="题库检索"]');
    if (!section) throw new Error("未找到题库检索区域");
    const button = [...section.querySelectorAll("button")].find((entry) => entry.textContent?.trim() === "检索");
    if (!button) throw new Error("未找到检索按钮");
    const started = performance.now();
    button.click();
    const done = () => hit
      ? [...section.querySelectorAll(".paper-card")].some((card) => card.textContent?.includes(wanted))
      : (section.textContent ?? "").includes("没有检索结果。");
    while (!done()) {
      if (performance.now() - started > 15_000) throw new Error(`检索等待超时（${hit ? "有结果" : "无结果"}）`);
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    return performance.now() - started;
  }, { wanted: keyword, hit });
}

async function measureSave(page: Page, suffix: string): Promise<number> {
  return page.evaluate(async (tail) => {
    const block = document.querySelector<HTMLElement>('[aria-label="内容 1"]');
    const textarea = block?.querySelector("textarea");
    if (!textarea) throw new Error("未找到草稿段落");
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    if (!setter) throw new Error("无法写入草稿段落");
    setter.call(textarea, textarea.value + tail);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    const statusLine = () => document.querySelector('[aria-live="polite"]')?.textContent ?? "";
    const waitFor = async (predicate: () => boolean, label: string) => {
      const began = performance.now();
      while (!predicate()) {
        if (performance.now() - began > 15_000) throw new Error(`保存等待超时：${label}`);
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
    };
    await waitFor(() => statusLine().startsWith("有未保存的修改"), "进入未保存状态");
    const button = [...document.querySelectorAll("button")].find((entry) => entry.textContent?.trim() === "保存草稿");
    if (!button) throw new Error("未找到保存草稿按钮");
    const started = performance.now();
    button.click();
    await waitFor(() => statusLine().startsWith("没有未保存的修改"), "保存完成");
    return performance.now() - started;
  }, suffix);
}

async function measureExport(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const success = "学生卷与教师答案卷已保存并打开";
    const button = [...document.querySelectorAll("button")].find((entry) => entry.textContent?.trim() === "生成学生卷与教师答案卷");
    if (!button) throw new Error("未找到生成双卷按钮");
    const text = () => document.body.textContent ?? "";
    const waitFor = async (predicate: () => boolean, label: string, limit = 120_000) => {
      const began = performance.now();
      while (!predicate()) {
        if (performance.now() - began > limit) throw new Error(`导出等待超时：${label}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    };
    const started = performance.now();
    button.click();
    // 上一轮的成功提示仍在页面中；先确认本轮已清空或进入打印视图，再等待完成。
    await waitFor(() => !text().includes(success) || document.querySelector(".paper-print") !== null, "开始生成");
    await waitFor(() => text().includes(success), "生成完成");
    return performance.now() - started;
  });
}

async function openBackup(page: Page): Promise<void> {
  if (await page.getByRole("button", { name: "返回录题草稿" }).isVisible().catch(() => false)) {
    await page.getByRole("button", { name: "返回录题草稿" }).click();
  }
  await page.getByRole("button", { name: "备份与恢复" }).click();
  await expect(page.getByRole("heading", { name: "备份与恢复" })).toBeVisible();
}

async function measureBackup(app: ElectronApplication, page: Page, destination: string): Promise<number> {
  await app.evaluate(({ dialog }, target) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] });
  }, destination);
  await page.getByRole("button", { name: "选择备份位置" }).click();
  await expect(page.getByText("已选择备份位置，请确认后开始备份。")).toBeVisible();
  return page.evaluate(async () => {
    const success = "备份完成，清单与文件校验值已写入。";
    const button = [...document.querySelectorAll("button")].find((entry) => entry.textContent?.trim() === "确认备份");
    if (!button) throw new Error("未找到确认备份按钮");
    const started = performance.now();
    button.click();
    while (!(document.body.textContent ?? "").includes(success)) {
      if (performance.now() - started > 360_000) throw new Error("备份等待超时");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return performance.now() - started;
  });
}

function exportedPdfs(destination: string): { student: string; teacher: string } {
  const directory = readdirSync(destination)
    .filter((name) => name.startsWith("拾题成卷-样张-"))
    .map((name) => path.join(destination, name))
    .sort()
    .at(-1);
  if (!directory) throw new Error(`未找到导出的双卷目录：${destination}`);
  return { student: path.join(directory, "学生卷.pdf"), teacher: path.join(directory, "教师答案卷.pdf") };
}

async function verifyPdf(file: string): Promise<{ bytes: number; pages: number }> {
  const data = readFileSync(file);
  const result = await extractPdfText(new Uint8Array(data));
  return { bytes: data.length, pages: result.pages.length };
}

function environment(): Record<string, unknown> {
  return {
    platform: process.platform,
    arch: process.arch,
    release: os.release(),
    cpu: os.cpus()[0]?.model.trim() ?? "unknown",
    cpuCount: os.cpus().length,
    totalMemoryBytes: os.totalmem(),
    loadAverageBefore: os.loadavg(),
    nodeInTestRunner: process.version,
  };
}

test("规模与性能实测", async () => {
  test.setTimeout(3_600_000);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dataDir = path.resolve(process.env.PAPERWEAVE_PERF_DIR ?? path.join("out", "performance", stamp));
  const fixtureOnly = process.env.PAPERWEAVE_PERF_FIXTURE_ONLY === "1";
  mkdirSync(dataDir, { recursive: true });
  const existing = readFixture(dataDir);
  const fixture: FixtureInfo = existing ?? await createFixture(dataDir);
  console.log(`[perf] 规模库：${dataDir}\n[perf] ${fixtureSummary(fixture)}${existing ? "（复用已有库）" : ""}`);
  if (fixtureOnly) return;

  expect(fixture.questions).toBe(SCALE.questions);
  expect(fixture.materials).toBe(SCALE.materials);
  expect(fixture.originals).toBe(SCALE.originals + 1);
  expect(fixture.paperItems).toBe(SCALE.paperItems);

  const results: RunResult[] = [];
  const warmup: Record<string, number> = {};
  const verification: Verification = {};
  const allRequests: string[] = [];

  // 冷启动：完全退出后重开，读取主进程自启动至主界面可操作的耗时。
  {
    const first = await launch(dataDir);
    await waitForEditor(first.page);
    allRequests.push(...first.requests);
    warmup.coldStart = await first.app.evaluate(() => Math.round(process.uptime() * 1000));
    await close(first.app);
    const values: number[] = [];
    for (let run = 1; run <= RUNS; run++) {
      const opened = await launch(dataDir);
      await waitForEditor(opened.page);
      const clock = await opened.app.evaluate(() => Math.round(process.uptime() * 1000));
      values.push(clock);
      allRequests.push(...opened.requests);
      console.log(`[perf] 冷启动 ${run}/${RUNS}: ${clock} ms`);
      await close(opened.app);
    }
    results.push(summarize("冷启动", "打开规模库至主界面可操作", TARGETS.coldStart, values));
  }

  const { app, page, requests } = await launch(dataDir);
  try {
    await waitForEditor(page);
    allRequests.push(...requests);

    // 检索：两个筛选条件（学科、年级）加题干关键词，分别测有结果与无结果。
    await openPaperWorkbench(page);
    await page.getByLabel("学科").fill("数学");
    await page.getByLabel("年级").fill("九年级");
    warmup.searchHit = await measureSearch(page, HIT_KEYWORDS[0], true);
    warmup.searchMiss = await measureSearch(page, MISS_KEYWORDS[0], false);
    const hitValues: number[] = [];
    const missValues: number[] = [];
    // 预热结束停在“无结果”；先测有结果，再交替，保证每次都能观察到本轮状态变化。
    for (let run = 0; run < RUNS; run++) {
      const hit = await measureSearch(page, HIT_KEYWORDS[run], true);
      const miss = await measureSearch(page, MISS_KEYWORDS[run], false);
      hitValues.push(hit);
      missValues.push(miss);
      console.log(`[perf] 检索 第 ${run + 1} 轮：有结果 ${hit} ms，无结果 ${miss} ms`);
    }
    results.push(summarize("检索", "有结果（学科+年级+关键词）", TARGETS.search, hitValues));
    results.push(summarize("检索", "无结果（学科+年级+关键词）", TARGETS.search, missValues));

    // 保存：含中文、行内/独立公式、表格与一张 2 MiB 图片的草稿。
    await page.getByRole("button", { name: "返回录题草稿" }).click();
    await expect(page.getByRole("heading", { name: "编辑草稿" })).toBeVisible();
    warmup.save = await measureSave(page, "·预热");
    const saveValues: number[] = [];
    for (let run = 1; run <= RUNS; run++) {
      const elapsed = await measureSave(page, `·第${run}次`);
      saveValues.push(elapsed);
      console.log(`[perf] 保存 ${run}/${RUNS}: ${elapsed} ms`);
    }
    results.push(summarize("保存", "草稿含公式/表格/2 MiB 图片", TARGETS.save, saveValues));

    // 导出：50 小题卷生成学生卷与教师答案卷，至两份 PDF 写完。
    await openPaperWorkbench(page);
    const exportRoot = path.join(dataDir, "exports");
    mkdirSync(exportRoot, { recursive: true });
    await app.evaluate(({ dialog, shell }, target) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] });
      shell.openPath = async () => "";
    }, exportRoot);
    warmup.export = await measureExport(page);
    const exportValues: number[] = [];
    const exportRuns: NonNullable<Verification["export"]>["runs"] = [];
    for (let run = 1; run <= RUNS; run++) {
      const destination = path.join(exportRoot, `${stamp}-${run}`);
      mkdirSync(destination, { recursive: true });
      await app.evaluate(({ dialog }, target) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] });
      }, destination);
      const elapsed = await measureExport(page);
      exportValues.push(elapsed);
      const pdfs = exportedPdfs(destination);
      const student = await verifyPdf(pdfs.student);
      const teacher = await verifyPdf(pdfs.teacher);
      exportRuns.push({ studentBytes: student.bytes, teacherBytes: teacher.bytes, studentPages: student.pages, teacherPages: teacher.pages });
      console.log(`[perf] 导出 ${run}/${RUNS}: ${elapsed} ms（学生卷 ${student.pages} 页，教师卷 ${teacher.pages} 页）`);
    }
    verification.export = { runs: exportRuns };
    results.push(summarize("导出双卷", "50 小题至两份 PDF 写完", TARGETS.export, exportValues));

    // 备份：确认后至数据库与全部附件、原卷、定稿复制及校验完成。
    await openBackup(page);
    const backupRoot = path.join(dataDir, "backups");
    mkdirSync(backupRoot, { recursive: true });
    const backupVerification: NonNullable<Verification["backup"]> = [];
    const backupMeasure = async (destination: string): Promise<{ ms: number; totalBytes: number; fileCount: number }> => {
      mkdirSync(destination, { recursive: true });
      const elapsed = await measureBackup(app, page, destination);
      const name = readdirSync(destination).find((entry) => entry.startsWith("PaperWeave-backup-"));
      if (!name) throw new Error("未找到备份目录");
      const manifest = JSON.parse(readFileSync(path.join(destination, name, "manifest.json"), "utf8")) as { totalBytes: number; files: unknown[] };
      return { ms: elapsed, totalBytes: manifest.totalBytes, fileCount: manifest.files.length };
    };
    const backupWarmup = await backupMeasure(path.join(backupRoot, `${stamp}-warmup`));
    warmup.backup = backupWarmup.ms;
    const backupValues: number[] = [];
    for (let run = 1; run <= RUNS; run++) {
      const result = await backupMeasure(path.join(backupRoot, `${stamp}-run-${run}`));
      backupValues.push(result.ms);
      backupVerification.push({ totalBytes: result.totalBytes, fileCount: result.fileCount });
      console.log(`[perf] 备份 ${run}/${RUNS}: ${result.ms} ms，${result.totalBytes} 字节，${result.fileCount} 个文件`);
    }
    verification.backup = backupVerification;
    results.push(summarize("备份", "含全部原卷、附件与定稿", TARGETS.backup, backupValues));
  } finally {
    await close(app);
  }

  // 重开校验：保存的草稿内容完整、图片可读取；这部分不计入保存耗时。
  {
    const reopened = await launch(dataDir);
    try {
      await waitForEditor(reopened.page);
      await expect(reopened.page.getByRole("region", { name: "内容 4" }).getByRole("img", { name: "合成 2 MiB 测试图" })).toBeVisible({ timeout: 15_000 });
      const draft = await reopened.page.evaluate(() => ({
        blocks: document.querySelectorAll('[aria-label^="内容 "]').length,
        text: document.querySelector<HTMLTextAreaElement>('[aria-label="内容 1"] textarea')?.value ?? "",
        imageSource: document.querySelector('[aria-label="内容 4"] img')?.getAttribute("src") ?? "",
      }));
      const imageBytes = statSync(path.join(dataDir, "attachments", fixture.draftImageId)).size;
      expect(draft.blocks).toBe(4);
      expect(draft.text).toContain("合成规模测试草稿");
      expect(draft.imageSource.startsWith("data:image/png;base64,")).toBe(true);
      expect(imageBytes).toBe(2 * 1024 * 1024);
      verification.draft = { blocks: draft.blocks, text: draft.text, imageBytes, imageId: fixture.draftImageId };
    } finally {
      await close(reopened.app);
    }
  }

  expect(allRequests).toEqual([]); // 断网测量：零网络请求。
  const versions = await (async () => {
    const probe = await launch(dataDir);
    try {
      await waitForEditor(probe.page);
      return await probe.app.evaluate(() => ({
        electron: process.versions.electron,
        node: process.versions.node,
        chrome: process.versions.chrome,
      }));
    } finally {
      await close(probe.app);
    }
  })();
  const loadAverageAfter = os.loadavg();
  const liveDatabaseBytes = statSync(path.join(dataDir, "paperweave.sqlite")).size;
  const failed = results.filter((result) => !result.passed);
  const report = {
    issue: 65,
    measuredAt: new Date().toISOString(),
    method: "docs/基线记录.md：同一隔离库、断网、本地磁盘；每项预热一次后连续 5 次，记录全部结果与最大值，慢次不剔除。",
    harness: "Electron 45.2.2 运行生产构建 .vite/build/main.cjs（与打包产物同版本同代码）；可见窗口；Playwright 自动化。",
    environment: { ...environment(), appVersion: APP_VERSION, ...versions, loadAverageAfter },
    fixture: { ...fixture, dataDir: path.relative(process.cwd(), dataDir), databaseBytes: liveDatabaseBytes, summary: fixtureSummary(fixture) },
    targets: TARGETS,
    runs: RUNS,
    warmup,
    results,
    verification,
    limitations: [
      "Playwright 无法自动化打包后的 Mach-O 产物，计时使用与打包产物同版本同代码的 Electron 45.2.2 生产构建；安装包可见窗口冷启动仍待人工复核。",
      "保存按 M0 目标样本测编辑器草稿（含 2 MiB 图片引用，每次保存校验附件哈希），重开完整性另验；录题表单保存走同一 SQLite 事务层，未单独计时。",
      "Windows 待硬件，按同一方法另记，不用 macOS 结果代替。",
    ],
    backgroundLoad: { loadAverageBefore: os.loadavg(), loadAverageAfter, note: "测量期间未主动运行其他大型任务；以 load average 记录后台负载。" },
    networkRequests: allRequests,
  };
  writeFileSync(RESULTS_FILE, `${JSON.stringify(report, null, 2)}\n`);

  const lines = [
    "| 操作 | 样本 | 上限（ms） | 5 次实测（ms） | 最大值（ms） | 结果 |",
    "|---|---|---:|---|---:|---|",
    ...results.map((result) => `| ${result.operation} | ${result.variant} | ${result.target} | ${result.values.join(" / ")} | ${result.max} | ${result.passed ? "通过" : "未达标"} |`),
  ];
  console.log(`[perf] 结果已写入 ${RESULTS_FILE}\n${lines.join("\n")}`);
  expect(failed, JSON.stringify(failed, null, 2)).toEqual([]);
});
