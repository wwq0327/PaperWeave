// 旧数据升级走查（Issue #66）：用上一版构建生成数据，降为数据版本 6 并制作
// 上一版备份；新构建打开后应迁移到 7、保留题目/原卷/配图/定稿/设置，且旧备份
// 可被识别。随后复制一份库并制造 v7 迁移失败，确认原库与迁移前快照都保留。
import { spawn } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  assert,
  installStubs,
  launchPackaged,
  runWorkflow,
  sha256,
  waitForExit,
} from "./packaged-harness.mjs";

const APP_VERSION = JSON.parse(readFileSync("package.json", "utf8")).version;
const NEW_APP = path.resolve("out", "PaperWeave-darwin-arm64", "PaperWeave.app", "Contents", "MacOS", "PaperWeave");
const PREVIOUS_APP = process.env.PAPERWEAVE_PREVIOUS_APP
  ? path.resolve(process.env.PAPERWEAVE_PREVIOUS_APP)
  : path.resolve("out", "previous-build", "PaperWeave.app", "Contents", "MacOS", "PaperWeave");
const FIXTURE = path.resolve("tests", "fixtures", "two-pages.pdf");
const failures = [];
const check = (...args) => { if (!assert(...args)) failures.push(args[0]); };

if (!existsSync(NEW_APP)) {
  console.error(`未找到新构建：${NEW_APP}，请先运行 npm run package`);
  process.exit(1);
}
const oldApp = existsSync(PREVIOUS_APP) ? PREVIOUS_APP : NEW_APP;
console.log(`旧数据由${oldApp === NEW_APP ? "当前构建（并降为 v6）" : "上一版构建"}生成：${oldApp}`);

const base = mkdtempSync(path.join(tmpdir(), "paperweave-upgrade-"));
const userData = path.join(base, "旧版用户数据", "拾题成卷 题库");
const exportRoot = path.join(base, "旧版导出");
const backupDir = path.join(base, "上一版备份", "PaperWeave-backup-v6");
const failUserData = path.join(base, "失败用户数据", "拾题成卷 题库");
let harness;

function countsOf(db) {
  return {
    questions: db.prepare("SELECT count(*) AS count FROM questions").get().count,
    versions: db.prepare("SELECT count(*) AS count FROM question_versions").get().count,
    papers: db.prepare("SELECT count(*) AS count FROM papers").get().count,
    items: db.prepare("SELECT count(*) AS count FROM paper_items").get().count,
    finalizations: db.prepare("SELECT count(*) AS count FROM paper_finalizations").get().count,
    originals: db.prepare("SELECT count(*) AS count FROM original_files").get().count,
    settings: db.prepare("SELECT count(*) AS count FROM app_settings").get().count,
    drafts: db.prepare("SELECT count(*) AS count FROM editor_drafts").get().count,
  };
}

function downgradeToV6(dbPath, { conflict = false } = {}) {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA foreign_keys = OFF");
    db.exec("DROP TABLE IF EXISTS import_records");
    db.exec("DROP TABLE IF EXISTS import_batches");
    if (conflict) db.exec("CREATE TABLE import_batches (wrong TEXT NOT NULL)");
    db.exec("PRAGMA user_version = 6");
  } finally {
    db.close();
  }
}

function snapshotFiles(userDataDir) {
  const directory = path.join(userDataDir, ".migration-backups");
  return existsSync(directory) ? readdirSync(directory).map((name) => path.join(directory, name)).sort() : [];
}

function makeV6Backup(userDataDir, destination) {
  mkdirSync(destination, { recursive: true });
  const files = [];
  const add = (source, relative) => {
    const target = path.join(destination, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(source, target);
    files.push({ path: relative, size: statSync(target).size, sha256: sha256(target) });
  };
  add(path.join(userDataDir, "paperweave.sqlite"), "database/paperweave.sqlite");

  const attachments = path.join(userDataDir, "attachments");
  if (existsSync(attachments)) {
    for (const name of readdirSync(attachments).sort()) {
      if (/^[a-f0-9]{64}$/.test(name)) add(path.join(attachments, name), `attachments/${name}`);
    }
  }

  const db = new DatabaseSync(path.join(userDataDir, "paperweave.sqlite"), { readOnly: true });
  try {
    for (const row of db.prepare("SELECT relative_path FROM original_files").all()) {
      add(path.join(userDataDir, row.relative_path), row.relative_path);
    }
    for (const row of db.prepare("SELECT id, student_pdf, teacher_pdf FROM paper_finalizations").all()) {
      add(row.student_pdf, `papers/${row.id}/student.pdf`);
      add(row.teacher_pdf, `papers/${row.id}/teacher.pdf`);
    }
  } finally {
    db.close();
  }

  const manifest = {
    format: "paperweave-backup",
    formatVersion: 1,
    dataVersion: 6,
    appVersion: APP_VERSION,
    createdAt: new Date().toISOString(),
    totalBytes: files.reduce((sum, file) => sum + file.size, 0),
    files,
  };
  writeFileSync(path.join(destination, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

function readOnly(dbPath, query) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try { return db.prepare(query).get().count; } finally { db.close(); }
}

function readVersion(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try { return db.prepare("PRAGMA user_version").get().user_version; } finally { db.close(); }
}

try {
  mkdirSync(exportRoot, { recursive: true });

  // 1. 上一版构建生成一套完整数据。
  harness = await launchPackaged({ appPath: oldApp, userData });
  await installStubs(harness, { openPath: FIXTURE });
  await harness.page.evaluate(() => window.paperweave.saveDraft({
    version: 2,
    blocks: [{ type: "paragraph", runs: [{ type: "text", text: "升级前草稿", style: "普通" }] }],
    teacherAnswer: "升级前答案",
  }));
  await harness.page.evaluate(() => window.paperweave.saveAiConfig({
    baseUrl: "https://api.example.invalid",
    textModel: "升级前文字模型",
    imageModel: "升级前图像模型",
  }));
  const stem = "升级前合成题：求下列式子的值。";
  await runWorkflow(harness, {
    fixture: FIXTURE,
    examTitle: "升级前原卷",
    paperTitle: "升级前试卷",
    exportRoot,
    stem,
    answer: "7",
    confirmFinalize: false, // 上一版构建没有定稿前预览确认
  });
  await harness.close();
  harness = undefined;

  const dbPath = path.join(userData, "paperweave.sqlite");
  const before = (() => { const db = new DatabaseSync(dbPath, { readOnly: true }); try { return countsOf(db); } finally { db.close(); } })();
  check(before.questions >= 1 && before.finalizations >= 1, "上一版数据已生成", JSON.stringify(before));
  downgradeToV6(dbPath);
  check(readVersion(dbPath) === 6 && readOnly(dbPath, "SELECT count(*) AS count FROM sqlite_schema WHERE name = 'import_records'") === 0, "数据已降为版本 6");
  const originalFiles = (() => { const db = new DatabaseSync(dbPath, { readOnly: true }); try { return db.prepare("SELECT relative_path FROM original_files").all().map((row) => row.relative_path); } finally { db.close(); } })();
  const attachmentFiles = readdirSync(path.join(userData, "attachments"));
  check(originalFiles.length >= 1 && originalFiles.every((file) => existsSync(path.join(userData, file))), "原卷文件在升级前存在");
  check(attachmentFiles.length >= 1, "配图附件在升级前存在");

  const manifest = makeV6Backup(userData, backupDir);
  check(manifest.dataVersion === 6 && manifest.files.some((file) => file.path === "database/paperweave.sqlite"), "已制作数据版本 6 的上一版备份", `${manifest.files.length} 个文件`);

  // 2. 新构建打开旧数据：迁移成功，数据与设置保留，旧备份可识别。
  harness = await launchPackaged({ appPath: NEW_APP, userData });
  await installStubs(harness, {});
  await harness.page.getByRole("button", { name: "题库与组卷" }).click();
  await harness.page.getByRole("heading", { name: /升级前试卷/ }).waitFor({ timeout: 30_000 });
  const snapshots = snapshotFiles(userData);
  check(snapshots.length === 1, "升级前生成迁移快照", String(snapshots.length));
  const config = await harness.page.evaluate(() => window.paperweave.getAiConfig());
  check(config.baseUrl === "https://api.example.invalid" && config.textModel === "升级前文字模型", "升级后模型设置保留", JSON.stringify(config));
  const draft = await harness.page.evaluate(() => window.paperweave.loadDraft());
  check(draft?.blocks?.[0]?.runs?.[0]?.text === "升级前草稿", "升级后草稿保留");
  await harness.page.getByLabel("关键词").fill(stem);
  await harness.page.getByRole("button", { name: "检索" }).click();
  const found = harness.page.locator(".paper-card", { hasText: stem });
  await found.waitFor({ timeout: 15_000 });
  check(await found.isVisible(), "升级后题目在题库中可读");

  await harness.page.getByRole("button", { name: "返回录题草稿" }).click();
  await harness.page.getByRole("button", { name: "备份与恢复" }).click();
  await harness.page.getByRole("heading", { name: "备份与恢复" }).waitFor();
  await harness.setOpenPath(backupDir);
  await harness.page.getByRole("button", { name: "选择备份目录" }).click();
  await harness.page.getByText("备份校验通过，请核对摘要后确认恢复。").waitFor({ timeout: 15_000 });
  const backupSummary = harness.page.getByRole("region", { name: "待恢复备份" });
  const summaryText = (await backupSummary.textContent()) ?? "";
  check(summaryText.includes("数据版本") && summaryText.includes("6"), "新版本识别上一版备份", summaryText.slice(0, 120));
  const opened = await harness.openedFiles();
  check(opened.length === 0, "升级校验不打开 PDF");

  // 3. 实际恢复上一版备份：备份内是 v6 快照，恢复流程应迁移到 7 并保留数据。
  await harness.page.getByRole("button", { name: "恢复并重启" }).click();
  const confirm = harness.page.getByRole("alertdialog", { name: "确认恢复备份" });
  await confirm.getByRole("button", { name: "确认恢复并重启" }).click();
  await waitForExit(harness.child, 20_000).catch(() => undefined);
  await harness.close().catch(() => undefined);
  harness = undefined;

  harness = await launchPackaged({ appPath: NEW_APP, userData });
  await installStubs(harness, {});
  await harness.page.getByRole("button", { name: "题库与组卷" }).click();
  await harness.page.getByRole("heading", { name: /升级前试卷/ }).waitFor({ timeout: 30_000 });
  const restored = (() => { const db = new DatabaseSync(dbPath, { readOnly: true }); try { return countsOf(db); } finally { db.close(); } })();
  check(JSON.stringify(restored) === JSON.stringify(before), "从 v6 备份恢复后计数一致", `${JSON.stringify(before)} → ${JSON.stringify(restored)}`);
  check(readVersion(dbPath) === 7, "恢复后数据版本为 7");
  const restoredConfig = await harness.page.evaluate(() => window.paperweave.getAiConfig());
  check(restoredConfig.baseUrl === "https://api.example.invalid" && restoredConfig.textModel === "升级前文字模型", "恢复后模型设置保留", JSON.stringify(restoredConfig));
  const restoredDraft = await harness.page.evaluate(() => window.paperweave.loadDraft());
  check(restoredDraft?.blocks?.[0]?.runs?.[0]?.text === "升级前草稿", "恢复后草稿保留");
  const restoredFinals = (() => {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try { return db.prepare("SELECT student_pdf, teacher_pdf FROM paper_finalizations").all(); } finally { db.close(); }
  })();
  check(restoredFinals.length === before.finalizations && restoredFinals.every((row) => existsSync(row.student_pdf) && existsSync(row.teacher_pdf)), "恢复后定稿 PDF 可读");
  await harness.close();
  harness = undefined;

  const after = (() => { const db = new DatabaseSync(dbPath, { readOnly: true }); try { return countsOf(db); } finally { db.close(); } })();
  check(readVersion(dbPath) === 7, "升级后数据版本为 7");
  check(JSON.stringify(after) === JSON.stringify(before), "升级前后题目/原卷/定稿/设置计数一致", `${JSON.stringify(before)} → ${JSON.stringify(after)}`);
  check(readOnly(dbPath, "SELECT count(*) AS count FROM sqlite_schema WHERE name = 'import_records'") === 1, "版本 7 表已建立");
  const snapshotDb = new DatabaseSync(snapshots[0], { readOnly: true });
  try {
    check(snapshotDb.prepare("PRAGMA user_version").get().user_version === 6, "迁移快照保持版本 6");
    check(JSON.stringify(countsOf(snapshotDb)) === JSON.stringify(before), "迁移快照数据完整");
  } finally {
    snapshotDb.close();
  }

  // 3. 复制库并制造迁移失败：版本 7 表冲突，迁移应整次回滚。
  mkdirSync(path.dirname(failUserData), { recursive: true });
  cpSync(userData, failUserData, { recursive: true });
  const failDb = path.join(failUserData, "paperweave.sqlite");
  downgradeToV6(failDb, { conflict: true });
  const failSnapshotsBefore = snapshotFiles(failUserData).length;
  const failPort = 9800 + Math.floor(Math.random() * 150);
  const failApp = spawn(NEW_APP, [`--user-data-dir=${failUserData}`, `--remote-debugging-port=${failPort}`], { stdio: "ignore", env: { ...process.env, PAPERWEAVE_TEST: "1" } });
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  let failPages = [];
  try {
    const targets = await (await fetch(`http://127.0.0.1:${failPort}/json/list`)).json();
    failPages = targets.filter((target) => target.type === "page" && target.url.startsWith("file://"));
  } catch { /* 进程已退出或调试端口未就绪 */ }
  if (failApp.exitCode === null) failApp.kill("SIGKILL");
  await waitForExit(failApp, 5_000).catch(() => undefined);
  check(failPages.length === 0, "迁移失败时不打开题库界面", `页面数 ${failPages.length}`);

  const failed = new DatabaseSync(failDb, { readOnly: true });
  try {
    check(failed.prepare("PRAGMA user_version").get().user_version === 6, "失败后原库仍为版本 6");
    check(JSON.stringify(countsOf(failed)) === JSON.stringify(before), "失败后题目/原卷/定稿/设置未变");
    check(failed.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE name = 'import_records'").get().count === 0, "失败后未留下半迁移表");
    check(failed.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE name = 'import_batches'").get().count === 1, "失败后原库结构保留");
  } finally {
    failed.close();
  }
  const failSnapshots = snapshotFiles(failUserData);
  check(failSnapshots.length === failSnapshotsBefore + 1, "失败前也生成迁移快照", `${failSnapshotsBefore} → ${failSnapshots.length}`);
  const latest = failSnapshots.sort().at(-1);
  const latestDb = new DatabaseSync(latest, { readOnly: true });
  try {
    check(latestDb.prepare("PRAGMA user_version").get().user_version === 6, "失败路径快照为版本 6");
    check(JSON.stringify(countsOf(latestDb)) === JSON.stringify(before), "失败路径快照数据完整");
  } finally {
    latestDb.close();
 }
} catch (error) {
  console.error(`升级走查中断：${String(error).slice(0, 500)}`);
  failures.push("升级走查未跑完");
} finally {
  if (harness) await harness.close().catch(() => undefined);
  if (failures.length) {
    console.error(`\n安装包升级走查未通过（${failures.length} 项）：${failures.join("；")}\n临时目录保留：${base}`);
    process.exit(1);
  }
  if (process.env.PAPERWEAVE_KEEP_TEMP === "1") console.log(`\n临时目录保留：${base}`);
  else rmSync(base, { recursive: true, force: true });
}
console.log("\n安装包升级走查全部通过");
