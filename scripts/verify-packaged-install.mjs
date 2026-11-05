// 安装包干净安装走查（Issue #66）：从 dmg 挂载复制到中文路径，首次建库，
// 断网完成导入原卷 → 录题 → 审核 → 组卷 → 定稿双卷 → 重开。
// 运行前先 `npm run make` 生成 dmg（或 `npm run package` 后手动指定）。
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  assert,
  extractPdf,
  installStubs,
  launchPackaged,
  runWorkflow,
} from "./packaged-harness.mjs";

const APP_VERSION = JSON.parse(readFileSync("package.json", "utf8")).version;
const DMG = path.resolve("out", "make", "dmg", "arm64", `PaperWeave-${APP_VERSION}-arm64.dmg`);
const FIXTURE = path.resolve("tests", "fixtures", "two-pages.pdf");
const failures = [];
const check = (...args) => { if (!assert(...args)) failures.push(args[0]); };

if (!existsSync(DMG)) {
  console.error(`未找到 dmg：${DMG}，请先运行 npm run make`);
  process.exit(1);
}

const base = mkdtempSync(path.join(tmpdir(), "paperweave-install-"));
const mount = path.join(base, "挂载");
const installRoot = path.join(base, "应用程序", "拾题成卷 安装测试");
const appBundle = path.join(installRoot, "PaperWeave.app");
const appPath = path.join(appBundle, "Contents", "MacOS", "PaperWeave");
const userData = path.join(base, "用户数据", "拾题成卷 题库");
const exportRoot = path.join(base, "导出");
let harness;

try {
  mkdirSync(mount, { recursive: true });
  mkdirSync(installRoot, { recursive: true });
  mkdirSync(exportRoot, { recursive: true });
  mkdirSync(userData, { recursive: true });
  execFileSync("hdiutil", ["attach", "-nobrowse", "-readonly", "-mountpoint", mount, DMG], { stdio: "ignore" });
  try {
    const bundles = readdirSync(mount).filter((name) => name.endsWith(".app"));
    check(bundles.length === 1, "dmg 内含一个应用包", bundles.join("、") || "无");
    if (bundles.length !== 1) throw new Error("dmg 内容不符合预期");
    execFileSync("ditto", [path.join(mount, bundles[0]), appBundle]);
  } finally {
    execFileSync("hdiutil", ["detach", mount, "-force"], { stdio: "ignore" });
  }
  execFileSync("codesign", ["--sign", "-", "--force", "--deep", appBundle], { stdio: "ignore" });
  check(existsSync(appPath), "应用包已复制到中文路径", appBundle);

  harness = await launchPackaged({
    appPath,
    userData,
    env: { PAPERWEAVE_AI_FAKE: "ok" },
  });
  await installStubs(harness, { openPath: FIXTURE });

  const main = await harness.mainEval(`(() => {
    const { app } = require("electron");
    return { packaged: app.isPackaged, version: app.getVersion(), userData: app.getPath("userData") };
  })()`);
  check(main.packaged === true, "主进程 app.isPackaged 为 true");
  check(main.version === APP_VERSION, "应用版本与 package.json 一致", `${main.version} / ${APP_VERSION}`);
  check(path.resolve(main.userData) === path.resolve(userData) || realpathSync(main.userData) === realpathSync(userData), "使用隔离的中文 userData", main.userData);

  const probe = await harness.page.evaluate(() => ({
    title: document.title,
    heading: document.querySelector("h1")?.textContent ?? "",
    bridge: typeof window.paperweave === "object" && window.paperweave ? Object.keys(window.paperweave).length : 0,
    globals: ["process", "require", "module", "ipcRenderer", "Buffer", "electron"].map((name) => typeof window[name]),
  }));
  check(probe.title === "拾题成卷 PaperWeave", "窗口标题", probe.title);
  check(probe.heading === "编辑草稿", "首次启动进入编辑界面", probe.heading);
  check(probe.bridge === 82, "桥接口 82 个", String(probe.bridge));
  check(probe.globals.every((value) => value === "undefined"), "渲染进程无 Node 全局", probe.globals.join(" "));
  check(existsSync(path.join(userData, "paperweave.sqlite")), "首次启动创建题库数据库");
  check(readdirSync(userData).includes("paperweave.sqlite"), "userData 使用指定目录");

  const fake = await harness.page.evaluate(async () => {
    try {
      await window.paperweave.generateAiDraft("packaged-fake-check-1234", { mode: "text", text: "安装包固定响应检查", pages: [1] });
      return "resolved";
    } catch (error) {
      return String(error);
    }
  });
  check(fake.includes("尚未配置模型密钥"), "打包应用不启用固定响应后门", fake);
  check(fake !== "resolved", "固定响应未返回草稿");

  await harness.page.evaluate(() => window.paperweave.saveDraft({
    version: 2,
    blocks: [{ type: "paragraph", runs: [{ type: "text", text: "安装验收草稿", style: "普通" }] }],
    teacherAnswer: "安装验收答案",
  }));
  await harness.page.evaluate(() => window.paperweave.saveAiConfig({
    baseUrl: "https://api.example.invalid",
    textModel: "合成文字模型",
    imageModel: "合成图像模型",
  }));

  const stem = "安装验收合成题：求下列式子的值。";
  const exported = await runWorkflow(harness, {
    fixture: FIXTURE,
    examTitle: "安装验收原卷",
    paperTitle: "安装验收卷",
    exportRoot,
    stem,
    answer: "2",
  });
  check(existsSync(exported.student), "学生卷已写出", exported.student);
  check(existsSync(exported.teacher), "教师答案卷已写出", exported.teacher);
  const student = await extractPdf(exported.student);
  const teacher = await extractPdf(exported.teacher);
  check(student.text.includes("安装验收卷") && student.text.includes("安装验收合成题"), "学生卷含卷名与题干", `${student.pages} 页`);
  check(!student.text.includes("参考答案") && !student.text.includes("答案正确"), "学生卷不含答案与评分");
  check(teacher.text.includes("参考答案") && teacher.text.includes("答案正确"), "教师卷含答案与评分");
  const opened = await harness.openedFiles();
  check(opened.some((file) => file.endsWith("学生卷.pdf")) && opened.some((file) => file.endsWith("教师答案卷.pdf")), "双卷交给系统打开", opened.join("、"));
  const attempts = await harness.networkAttempts();
  check(attempts.length === 0, "断网走查零网络请求", attempts.slice(0, 3).join(" "));

  await harness.close();
  harness = undefined;

  const raw = new DatabaseSync(path.join(userData, "paperweave.sqlite"));
  const version = raw.prepare("PRAGMA user_version").get().user_version;
  const counts = {
    questions: raw.prepare("SELECT count(*) AS count FROM questions").get().count,
    versions: raw.prepare("SELECT count(*) AS count FROM question_versions").get().count,
    papers: raw.prepare("SELECT count(*) AS count FROM papers").get().count,
    finalizations: raw.prepare("SELECT count(*) AS count FROM paper_finalizations").get().count,
    originals: raw.prepare("SELECT count(*) AS count FROM original_files").get().count,
  };
  raw.close();
  check(version === 7, "首次建库数据版本为 7", String(version));
  check(counts.questions >= 1 && counts.versions >= 1, "题目与版本已写库", JSON.stringify(counts));
  check(counts.papers >= 1 && counts.finalizations >= 1, "试卷与定稿已写库", JSON.stringify(counts));
  check(counts.originals >= 1, "原卷文件已登记", JSON.stringify(counts));
  check(readdirSync(path.join(userData, "attachments")).length >= 1, "裁图附件已保存");

  harness = await launchPackaged({ appPath, userData });
  await installStubs(harness, {});
  const config = await harness.page.evaluate(() => window.paperweave.getAiConfig());
  check(config.baseUrl === "https://api.example.invalid" && config.textModel === "合成文字模型", "重开后模型设置保留", JSON.stringify(config));
  const draft = await harness.page.evaluate(() => window.paperweave.loadDraft());
  check(draft?.blocks?.[0]?.runs?.[0]?.text === "安装验收草稿", "重开后草稿保留");
  await harness.page.getByRole("button", { name: "题库与组卷" }).click();
  await harness.page.getByRole("heading", { name: /安装验收卷/ }).waitFor({ timeout: 30_000 });
  await harness.page.getByLabel("关键词").fill(stem);
  await harness.page.getByRole("button", { name: "检索" }).click();
  const found = harness.page.locator(".paper-card", { hasText: stem });
  await found.waitFor({ timeout: 15_000 });
  check(await found.isVisible(), "重开后试卷与题目可读");
  const attemptsAfter = await harness.networkAttempts();
  check(attemptsAfter.length === 0, "重开零网络请求", attemptsAfter.slice(0, 3).join(" "));
} catch (error) {
  console.error(`走查中断：${String(error).slice(0, 500)}`);
  failures.push("安装走查未跑完");
} finally {
  if (harness) await harness.close().catch(() => undefined);
  if (failures.length) {
    console.error(`\n安装包干净安装走查未通过（${failures.length} 项）：${failures.join("；")}\n临时目录保留：${base}`);
    process.exit(1);
  }
  if (process.env.PAPERWEAVE_KEEP_TEMP === "1") console.log(`\n临时目录保留：${base}`);
  else rmSync(base, { recursive: true, force: true });
}
console.log("\n安装包干净安装走查全部通过");
