import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { Database } from "../../../src/main/database";
import { ExamStore } from "../../../src/main/exams";

const directories: string[] = [];
function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  directories.push(dir);
  return dir;
}
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const pdf = (text: string) => Buffer.from(`%PDF-1.4\n${text}\n%%EOF`);
const input = { title: "九年级数学单元卷", stage: "初中" as const, subject: "数学", grade: "九年级", region: "四川南充", examType: "单元测", year: "2026", sourceName: "自制样题" };

function open() {
  const root = temp("paperweave-exams-");
  const source = temp("paperweave-exams-src-");
  const db = new Database(join(root, "paperweave.sqlite"));
  return { root, source, db, store: new ExamStore(db, root) };
}

test("导入原卷复制文件并按指纹去重", () => {
  const { root, source, store } = open();
  const file = join(source, "九年级数学.pdf");
  const bytes = pdf("原卷内容");
  writeFileSync(file, bytes);
  const sha = createHash("sha256").update(bytes).digest("hex");

  const first = store.importPaper(input, file);
  expect(first.existing).toBe(false);
  expect(first.exam.title).toBe(input.title);
  expect(first.file.sha256).toBe(sha);
  expect(first.file.relativePath).toBe(`originals/${sha}.pdf`);
  const copied = join(root, first.file.relativePath);
  expect(existsSync(copied)).toBe(true);
  expect(readFileSync(copied).equals(bytes)).toBe(true);
  const detail = store.getExam(first.exam.id);
  expect(detail.sections).toHaveLength(1);
  expect(detail.sections[0].title).toBe("全卷");
  expect(detail.files).toMatchObject([{ role: "paper", sha256: sha, originalName: "九年级数学.pdf" }]);

  const again = store.importPaper(input, file);
  expect(again.existing).toBe(true);
  expect(again.exam.id).toBe(first.exam.id);
  expect(readdirSync(join(root, "originals")).sort()).toEqual([`${sha}.pdf`]);
  expect(store.listExams()).toHaveLength(1);
  expect(store.readFile(first.file.id).data.equals(bytes)).toBe(true);
});

test("答案文件单独挂接，不替换原卷；篡改后读取失败", () => {
  const { root, source, store } = open();
  const paperPath = join(source, "卷.pdf");
  const answerPath = join(source, "答案.pdf");
  writeFileSync(paperPath, pdf("原卷"));
  writeFileSync(answerPath, pdf("答案"));
  const imported = store.importPaper(input, paperPath);
  const answer = store.attachFile(imported.exam.id, "answer", answerPath);
  expect(answer.existing).toBe(false);
  expect(answer.file.sha256).not.toBe(imported.file.sha256);
  const detail = store.getExam(imported.exam.id);
  expect(detail.files.map((entry) => entry.role).sort()).toEqual(["answer", "paper"]);
  expect(detail.files.find((entry) => entry.role === "paper")?.id).toBe(imported.file.id);
  expect(store.attachFile(imported.exam.id, "answer", answerPath).existing).toBe(true);
  expect(store.getExam(imported.exam.id).files).toHaveLength(2);

  const stored = join(root, answer.file.relativePath);
  writeFileSync(stored, pdf("被篡改"));
  expect(() => store.readFile(answer.file.id)).toThrow("校验失败");
});

test("拒绝非 PDF、缺字段与未知考试，分部可单独标学科", () => {
  const { source, store } = open();
  const textFile = join(source, "不是卷.pdf");
  writeFileSync(textFile, "普通文本");
  expect(() => store.importPaper(input, textFile)).toThrow("PDF");
  expect(() => store.importPaper({ ...input, title: "" }, textFile)).toThrow("标题");
  expect(() => store.importPaper({ ...input, stage: "大学" }, textFile)).toThrow("学段");
  expect(() => store.getExam("00000000-0000-0000-0000-000000000000")).toThrow("考试不存在");

  const paperPath = join(source, "合卷.pdf");
  writeFileSync(paperPath, pdf("合卷"));
  const imported = store.importPaper(input, paperPath);
  const section = store.addSection(imported.exam.id, "数学部分", "数学");
  expect(section).toMatchObject({ title: "数学部分", subject: "数学", position: 2 });
  expect(() => store.addSection(imported.exam.id, "", "数学")).toThrow("分部");
  expect(store.getExam(imported.exam.id).sections.map((entry) => entry.title)).toEqual(["全卷", "数学部分"]);
});
