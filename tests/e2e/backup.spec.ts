import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database } from "../../src/main/database";

const entry = path.resolve(".vite/build/main.cjs");
const ids = {
  exam: "00000000-0000-0000-0000-000000000101",
  section: "00000000-0000-0000-0000-000000000102",
  file: "00000000-0000-0000-0000-000000000103",
  paper: "00000000-0000-0000-0000-000000000104",
  finalization: "00000000-0000-0000-0000-000000000105",
};
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const originals = Buffer.from("%PDF-1.4\n合成原卷\n");
const hash = (data: Buffer) => createHash("sha256").update(data).digest("hex");

function seed(dir: string, output: string) {
  const db = new Database(path.join(dir, "paperweave.sqlite"));
  const attachmentId = hash(png);
  const originalSha = hash(originals);
  mkdirSync(path.join(dir, "attachments"), { recursive: true });
  mkdirSync(path.join(dir, "originals"), { recursive: true });
  writeFileSync(path.join(dir, "attachments", attachmentId), png);
  writeFileSync(path.join(dir, "originals", `${originalSha}.pdf`), originals);
  const student = path.join(output, "学生卷.pdf");
  const teacher = path.join(output, "教师答案卷.pdf");
  writeFileSync(student, "%PDF-1.4\n学生卷\n");
  writeFileSync(teacher, "%PDF-1.4\n教师答案卷\n");
  const at = "2026-11-05T00:00:00.000Z";
  db.transaction((sqlite) => {
    sqlite.prepare("INSERT INTO exams (id, title, stage, subject, grade, region, exam_type, year, source_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(ids.exam, "合成考试", "初中", "数学", "九年级", "本地", "单元测", "2026", "自制", at, at);
    sqlite.prepare("INSERT INTO exam_sections (id, exam_id, title, subject, position) VALUES (?, ?, ?, ?, 1)").run(ids.section, ids.exam, "全卷", "数学");
    sqlite.prepare("INSERT INTO original_files (id, sha256, relative_path, original_name, size, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(ids.file, originalSha, `originals/${originalSha}.pdf`, "合成原卷.pdf", originals.length, at);
    sqlite.prepare("INSERT INTO exam_originals (exam_id, file_id, role, created_at) VALUES (?, ?, 'paper', ?)").run(ids.exam, ids.file, at);
    sqlite.prepare("INSERT INTO papers (id, title, stage, subject, grade, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(ids.paper, "原始卷", "初中", "数学", "九年级", at, at);
    sqlite.prepare("INSERT INTO paper_finalizations (id, paper_id, student_pdf, teacher_pdf, snapshot, student_sha256, teacher_sha256, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(ids.finalization, ids.paper, student, teacher, "{}", hash(Buffer.from("%PDF-1.4\n学生卷\n")), hash(Buffer.from("%PDF-1.4\n教师答案卷\n")), at);
  });
  db.close();
  return { attachmentId, originalSha };
}

async function closeApp(app: ElectronApplication) {
  await app.evaluate(({ app: electronApp }) => { electronApp.exit(0); }).catch(() => undefined);
  await app.close().catch(() => undefined);
}

async function openBackup(page: Page) {
  await page.getByRole("button", { name: "备份与恢复" }).click();
  await expect(page.getByRole("heading", { name: "备份与恢复" })).toBeVisible();
}

async function backupThroughUi(app: ElectronApplication, page: Page, destination: string): Promise<string> {
  await openBackup(page);
  await app.evaluate(({ dialog }, target) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] });
  }, destination);
  await page.getByRole("button", { name: "选择备份位置" }).click();
  await expect(page.getByText(`已选择位置：${path.basename(destination)}`, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "确认备份" }).click();
  await expect(page.getByText("备份完成，清单与文件校验值已写入。", { exact: true })).toBeVisible({ timeout: 15000 });
  const name = readdirSync(destination).find((entry) => entry.startsWith("PaperWeave-backup-"));
  if (!name) throw new Error("未找到备份目录");
  expect(existsSync(path.join(destination, name, "manifest.json"))).toBe(true);
  return path.join(destination, name);
}

test("备份包含原卷、配图与定稿 PDF，恢复并重启后数据回到备份时状态", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "paperweave-backup-"));
  const output = mkdtempSync(path.join(tmpdir(), "paperweave-backup-out-"));
  const destination = mkdtempSync(path.join(tmpdir(), "paperweave-backup-dest-"));
  const { attachmentId, originalSha } = seed(dir, output);
  let app = await electron.launch({ args: [entry, `--user-data-dir=${dir}`] });
  let backupDir = "";
  try {
    let page = await app.firstWindow();
    await expect(page.getByRole("heading", { name: "编辑草稿" })).toBeVisible();
    backupDir = await backupThroughUi(app, page, destination);

    await closeApp(app);
    const db = new Database(path.join(dir, "paperweave.sqlite"));
    db.transaction((sqlite) => {
      sqlite.prepare("INSERT INTO papers (id, title, stage, subject, grade, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(randomUUID(), "备份之后新增", "初中", "数学", "九年级", "2026-11-05T01:00:00.000Z", "2026-11-05T01:00:00.000Z");
    });
    db.close();

    app = await electron.launch({ args: [entry, `--user-data-dir=${dir}`] });
    page = await app.firstWindow();
    await openBackup(page);
    await app.evaluate(({ dialog }, target) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] });
    }, backupDir);
    await page.getByRole("button", { name: "选择备份目录" }).click();
    await expect(page.getByText("备份校验通过，请核对摘要后确认恢复。", { exact: true })).toBeVisible({ timeout: 15000 });
    await expect(page.getByRole("region", { name: "待恢复备份" })).toContainText("PaperWeave-backup-");
    await page.getByRole("button", { name: "恢复并重启" }).click();
    const dialog = page.getByRole("alertdialog", { name: "确认恢复备份" });
    await expect(dialog).toContainText("恢复会关闭当前题库");
    const exited = new Promise<void>((resolve) => app.process().once("exit", () => resolve()));
    await dialog.getByRole("button", { name: "确认恢复并重启" }).click();
    await Promise.race([exited, new Promise((_, reject) => setTimeout(() => reject(new Error("恢复后应用未退出")), 15000))]);
    await app.close().catch(() => undefined);

    app = await electron.launch({ args: [entry, `--user-data-dir=${dir}`] });
    page = await app.firstWindow();
    await expect(page.getByRole("heading", { name: "编辑草稿" })).toBeVisible();
    const result = await page.evaluate(async (input) => {
      const bridge = (window as unknown as { paperweave: {
        listPapers: () => Promise<{ id: string; title: string }[]>;
        listPaperFinalizations: (paperId: string) => Promise<{ id: string; studentPdf: string; teacherPdf: string }[]>;
        getExam: (examId: string) => Promise<{ exam: { title: string } }>;
        getExamFile: (fileId: string) => Promise<{ data: Uint8Array }>;
        getImage: (id: string) => Promise<string>;
      } }).paperweave;
      const [papers, finals, exam, file, image] = await Promise.all([
        bridge.listPapers(),
        bridge.listPaperFinalizations(input.paper),
        bridge.getExam(input.exam),
        bridge.getExamFile(input.file),
        bridge.getImage(input.attachment),
      ]);
      return { papers, finals, examTitle: exam.exam.title, originalBytes: file.data.length, image };
    }, { paper: ids.paper, exam: ids.exam, file: ids.file, attachment: attachmentId });

    expect(result.papers.map((paper) => paper.title)).toEqual(["原始卷"]);
    expect(result.examTitle).toBe("合成考试");
    expect(result.originalBytes).toBe(originals.length);
    expect(result.image.startsWith("data:image/png;base64,")).toBe(true);
    expect(result.finals).toHaveLength(1);
    expect(result.finals[0].studentPdf).toBe(path.join(realpathSync(dir), "papers", ids.finalization, "student.pdf"));
    expect(result.finals[0].teacherPdf).toBe(path.join(realpathSync(dir), "papers", ids.finalization, "teacher.pdf"));
    expect(readFileSync(result.finals[0].studentPdf, "utf8")).toContain("学生卷");
    expect(existsSync(path.join(dir, "originals", `${originalSha}.pdf`))).toBe(true);
    expect(readdirSync(dir).filter((name) => name.startsWith(".restore-"))).toEqual([]);
    expect(existsSync(path.join(dir, "restore-request.json"))).toBe(false);
  } finally {
    await closeApp(app);
    rmSync(dir, { recursive: true, force: true });
    rmSync(output, { recursive: true, force: true });
    rmSync(destination, { recursive: true, force: true });
  }
});

test("备份文件被篡改时拒绝恢复并保留原题库", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "paperweave-backup-bad-"));
  const output = mkdtempSync(path.join(tmpdir(), "paperweave-backup-bad-out-"));
  const destination = mkdtempSync(path.join(tmpdir(), "paperweave-backup-bad-dest-"));
  const { attachmentId } = seed(dir, output);
  let app = await electron.launch({ args: [entry, `--user-data-dir=${dir}`] });
  try {
    let page = await app.firstWindow();
    const backupDir = await backupThroughUi(app, page, destination);
    writeFileSync(path.join(backupDir, "attachments", attachmentId), "被篡改的配图");
    await closeApp(app);

    app = await electron.launch({ args: [entry, `--user-data-dir=${dir}`] });
    page = await app.firstWindow();
    await openBackup(page);
    await app.evaluate(({ dialog }, target) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] });
    }, backupDir);
    await page.getByRole("button", { name: "选择备份目录" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "备份文件校验失败" })).toBeVisible({ timeout: 15000 });
    expect(existsSync(path.join(dir, "restore-request.json"))).toBe(false);
    const papers = await page.evaluate(async () => {
      const bridge = (window as unknown as { paperweave: { listPapers: () => Promise<{ title: string }[]> } }).paperweave;
      return (await bridge.listPapers()).map((paper) => paper.title);
    });
    expect(papers).toContain("原始卷");
  } finally {
    await closeApp(app);
    rmSync(dir, { recursive: true, force: true });
    rmSync(output, { recursive: true, force: true });
    rmSync(destination, { recursive: true, force: true });
  }
});
