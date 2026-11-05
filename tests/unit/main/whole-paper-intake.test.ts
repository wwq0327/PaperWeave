import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { Database } from "../../../src/main/database";
import { ExamStore } from "../../../src/main/exams";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function setup() {
  const root = mkdtempSync(join(tmpdir(), "whole-paper-intake-")); dirs.push(root);
  const db = new Database(join(root, "db.sqlite"));
  const source = join(root, "paper.pdf"); writeFileSync(source, "%PDF-1.4\n%%EOF");
  const exams = new ExamStore(db, root);
  const exam = exams.importPaper({ title: "自制卷", stage: "初中", subject: "数学", grade: "九年级", region: "", examType: "", year: "", sourceName: "" }, source).exam;
  const section = exams.getExam(exam.id).sections[0];
  return { root, db, exams, exam, section };
}

test("数据版本 8：整卷建档记录表带任务内唯一约束", () => {
  const { db } = setup();
  expect(db.dataVersion()).toBe(8);
  const now = new Date().toISOString();
  const insert = () => db.transaction((s) => {
    s.prepare("INSERT INTO whole_paper_intakes (id, task_id, batch_index, question_index, status, created_at, updated_at) VALUES ('r1','t',0,0,'created',?,?)").run(now, now);
  });
  insert();
  expect(() => insert()).toThrow();
});
