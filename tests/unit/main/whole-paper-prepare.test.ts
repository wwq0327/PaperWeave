import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { AttachmentStore } from "../../../src/main/attachments";
import { Database } from "../../../src/main/database";
import { ExamStore } from "../../../src/main/exams";
import { prepareWholePaper } from "../../../src/main/whole-paper-prepare";
import { WholePaperStore } from "../../../src/main/whole-paper-store";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const input = { title: "自制卷", stage: "初中" as const, subject: "数学", grade: "九年级", region: "", examType: "", year: "", sourceName: "" };
function setup() {
  const root = mkdtempSync(join(tmpdir(), "prepare-paper-")); dirs.push(root);
  const db = new Database(join(root, "db.sqlite"));
  const exams = new ExamStore(db, root);
  const tasks = new WholePaperStore(db);
  const attachments = new AttachmentStore(root);
  const source = (name: string) => {
    const path = join(root, name); copyFileSync(join(process.cwd(), "tests/fixtures", name), path);
    const imported = exams.importPaper(input, path);
    return { ...imported, sectionId: exams.getExam(imported.exam.id).sections[0].id };
  };
  return { root, db, exams, tasks, attachments, source };
}

test("从已关联文字 PDF 准备任务并持久保存来源和逐页内容", async () => {
  const { db, exams, tasks, attachments, source } = setup();
  const paper = source("two-pages.pdf");
  const task = await prepareWholePaper(exams, tasks, attachments, paper.exam.id, paper.sectionId, paper.file.id);
  expect(task.sourceFileId).toBe(paper.file.id);
  expect(task.state.plan.sourceKind).toBe("pdf");
  expect(tasks.get(task.id).state.plan.batches[0].pages).toEqual([1, 2]);
  expect(task.state.plan.batches[0].text).toContain("Page one text.");
  expect(task.state.plan.batches[0].text).toContain("Page two text.");
  db.close();
});

test("从 DOCX 原卷准备任务：按文档段落定位，空段落保留待处理提示", async () => {
  const { db, exams, tasks, attachments, source } = setup();
  const paper = source("sample.docx");
  const task = await prepareWholePaper(exams, tasks, attachments, paper.exam.id, paper.sectionId, paper.file.id);
  expect(task.sourceFileId).toBe(paper.file.id);
  expect(tasks.get(task.id).state.plan.sourceKind).toBe("docx");
  expect(task.state.plan.batches).toHaveLength(1);
  // 第 4 个文档段落为空，表格是第 5 个单元：定位用的是段落序号而不是 Word 分页。
  expect(task.state.plan.batches[0].pages).toEqual([1, 2, 3, 5]);
  expect(task.state.plan.batches[0].text).toContain("1. 计算：3 + 5");
  expect(task.state.plan.batches[0].text).toContain("[公式]");
  expect(task.state.plan.emptyPages).toEqual([4]);
  const image = task.state.plan.docxImages?.[0];
  expect(image).toMatchObject({ name: "image1.png", unit: 3, start: [..."3. 观察下图，回答问题："].length, end: [..."3. 观察下图，回答问题：[图片：image1.png]"].length });
  expect(image?.attachmentId).toMatch(/^[a-f0-9]{64}$/);
  const stored = attachments.read(image?.attachmentId as string);
  expect(stored.mime).toBe("image/png");
  expect(stored.data.length).toBeGreaterThan(0);
  db.close();
});

test("拒绝跨考试原卷、无效分部及扫描页，不创建任务", async () => {
  const { db, exams, tasks, attachments, source } = setup();
  const first = source("text.pdf");
  const blank = source("blank.pdf");
  await expect(prepareWholePaper(exams, tasks, attachments, first.exam.id, first.sectionId, blank.file.id)).rejects.toThrow("原卷不属于该考试");
  await expect(prepareWholePaper(exams, tasks, attachments, first.exam.id, blank.sectionId, first.file.id)).rejects.toThrow("考试分部不存在");
  await expect(prepareWholePaper(exams, tasks, attachments, blank.exam.id, blank.sectionId, blank.file.id)).rejects.toThrow("扫描页");
  expect(tasks.list()).toHaveLength(0);
  db.close();
});

test("混合 PDF 的无文字页保留待处理提示", async () => {
  const { root, db, exams, tasks, attachments } = setup();
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Length 37 >>\nstream\nBT /F1 12 Tf 20 200 Td (Question) Tj ET\nendstream",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  const path = join(root, "mixed.pdf"); writeFileSync(path, pdf);
  const imported = exams.importPaper(input, path);
  const task = await prepareWholePaper(exams, tasks, attachments, imported.exam.id, exams.getExam(imported.exam.id).sections[0].id, imported.file.id);
  expect(task.state.plan.emptyPages).toEqual([2]);
  db.close();
});

test("损坏 PDF 提取失败时不创建任务", async () => {
  const { root, db, exams, tasks, attachments } = setup();
  const path = join(root, "bad.pdf"); writeFileSync(path, "%PDF-1.4\ninvalid\n%%EOF");
  const imported = exams.importPaper(input, path);
  const section = exams.getExam(imported.exam.id).sections[0];
  await expect(prepareWholePaper(exams, tasks, attachments, imported.exam.id, section.id, imported.file.id)).rejects.toThrow("无法读取 PDF");
  expect(tasks.list()).toHaveLength(0);
  db.close();
});
