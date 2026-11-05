import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { Database } from "../../../src/main/database";
import { ExamStore } from "../../../src/main/exams";
import { Intake } from "../../../src/main/intake";
import { QuestionBank } from "../../../src/main/question-bank";
import { WholePaperIntake } from "../../../src/main/whole-paper-intake";
import { WholePaperStore } from "../../../src/main/whole-paper-store";
import type { AiDraft } from "../../../src/shared/ai";
import { createWholePaperRun } from "../../../src/shared/whole-paper-runner";
import type { WholePaperBatchPlan } from "../../../src/shared/whole-paper-batches";
import type { Classification } from "../../../src/shared/question";
import { note } from "../fixtures/questions";

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

function stores({ db, exams, exam, section }: ReturnType<typeof setup>) {
  const bank = new QuestionBank(db);
  const intake = new Intake(exams, bank);
  const tasks = new WholePaperStore(db);
  const wholeIntake = new WholePaperIntake(db, tasks, intake, bank, exams);
  return { bank, intake, tasks, wholeIntake, exam, section };
}

const classification: Classification = { stage: "初中", subject: "语文", grade: "九年级", examType: "单元测", year: "2026", sourceName: "自制样题", questionType: "", knowledgePoints: [] };

function makeTask(tasks: WholePaperStore, examId: string, sectionId: string, draft: AiDraft) {
  // 手工构造单批计划：真实分批器按页标记限额会拆出多批，这里要精确控制批数。
  const text = "甲".repeat(10);
  const plan: WholePaperBatchPlan = {
    emptyPages: [],
    batches: [{ fragments: [{ page: 1, start: 0, end: 10, text }], pages: [1], text, sendable: true, reviewBoundaryBefore: false }],
  };
  const state = createWholePaperRun(plan);
  const task = tasks.create(examId, sectionId, state);
  const done = { ...state, batches: state.batches.map((batch) => ({ ...batch, status: "succeeded" as const, result: draft })) };
  return tasks.save(task.id, task.revision, done);
}

function draftOf(...questions: AiDraft["questions"]): AiDraft {
  return { questions, notes: [] };
}

const part = (prompt: string, answer = "A") => ({ label: "(1)", prompt, options: [], answer, explanation: "解析", score: 3, uncertain: [] });
const validQuestion = (originalNumber: string, stem: string, extra: Partial<AiDraft["questions"][number]> = {}) => ({
  stem, subquestions: [], options: [], tags: [], uncertain: [], page: 1,
  parts: [part("选择正确项。")], questionType: "选择题", knowledgePoints: ["词语运用"], originalNumber, ...extra,
});

const SHARED_MATERIAL = { title: "共享材料", content: "材料正文", source: "固定响应" };

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

test("建档：分类继承、材料去重、提交待核，重复建档幂等", () => {
  const context = setup();
  const { bank, intake, tasks, wholeIntake, exam, section } = stores(context);
  // 预置本科目知识点候选，AI 题的同名词应并入知识点。
  const seeded = bank.createQuestion(note());
  bank.setClassification(seeded.questionId, { ...classification, questionType: "选择题", knowledgePoints: ["词语运用"] });

  const draft = draftOf(
    validQuestion("1", "整卷第一题题干", { materials: [SHARED_MATERIAL] }),
    validQuestion("2", "整卷第二题题干", { parts: [part("说明理由。", "")], materials: [SHARED_MATERIAL], questionType: "解答题" }),
  );
  const task = makeTask(tasks, exam.id, section.id, draft);

  const summary = wholeIntake.create(task.id, classification);
  expect(summary).toEqual({ created: 2, duplicates: 0, failed: 0, existing: 0, materials: 1 });

  // 提交待核：题 1 有答案 → 内容/答案均待核；题 2 无答案 → 答案缺失。
  const questions = context.exams.listQuestions(exam.id);
  expect(questions).toHaveLength(2);
  expect(questions.map((item) => item.contentStatus)).toEqual(["pending", "pending"]);
  expect(questions[0].answerStatus).toBe("pending");
  expect(questions[1].answerStatus).toBe("missing");

  // 分类继承 + AI 每题题型合并 + 候选知识点并入。
  const saved0 = bank.getQuestionClassification(questions[0].questionId)!;
  expect(saved0).toMatchObject({ stage: "初中", subject: "语文", questionType: "选择题" });
  expect(saved0.knowledgePoints).toContain("词语运用");
  const saved1 = bank.getQuestionClassification(questions[1].questionId)!;
  expect(saved1.questionType).toBe("解答题");

  const items = wholeIntake.list(task.id);
  expect(items.map((item) => item.status)).toEqual(["created", "created"]);
  expect(items[0].originalNumber).toBe("1");
  expect(items[0].page).toBe(1);
  expect(items[0].preview).toContain("整卷第一题题干");
  expect(items[0].problems.join()).toContain("尚未审核");
  expect(items[0].materialIds).toEqual(items[1].materialIds);
  expect(items[0].materialIds).toHaveLength(1);

  // 重复建档幂等：不产生新题、不重建材料。
  const again = wholeIntake.create(task.id, classification);
  expect(again).toEqual({ created: 0, duplicates: 0, failed: 0, existing: 2, materials: 0 });
  expect(context.exams.listQuestions(exam.id)).toHaveLength(2);
});

test("重复候选：记录并提示，可跳过或建修订版，已审核旧版本不覆盖", () => {
  const context = setup();
  const { bank, intake, tasks, wholeIntake, exam, section } = stores(context);
  const existing = intake.save({
    examId: exam.id, sectionId: section.id,
    content: { ...note(), source: { section: section.title, pdfPage: 1, originalNumber: "1" } },
    classification, submit: true,
  });
  if (!existing.saved) throw new Error("预置题目失败");
  bank.setContentStatus(existing.versionId, "approved");
  bank.setAnswerStatus(existing.versionId, "approved");

  const task = makeTask(tasks, exam.id, section.id, draftOf(
    validQuestion("1", "整卷第一题题干"),
    validQuestion("2", "整卷第二题题干"),
  ));
  const summary = wholeIntake.create(task.id, classification);
  expect(summary).toEqual({ created: 1, duplicates: 1, failed: 0, existing: 0, materials: 0 });

  const items = wholeIntake.list(task.id);
  expect(items[0].status).toBe("duplicate");
  expect(items[0].message).toContain("已存在");
  expect(items[1].status).toBe("created");

  wholeIntake.resolve(task.id, items[0].id, "skip");
  expect(wholeIntake.list(task.id)[0].status).toBe("skipped");
  expect(context.exams.listQuestions(exam.id)).toHaveLength(2);
});

test("建修订版：追加版本、旧版本内容与已审核状态不变", () => {
  const context = setup();
  const { bank, intake, tasks, wholeIntake, exam, section } = stores(context);
  const existing = intake.save({
    examId: exam.id, sectionId: section.id,
    content: { ...note(), source: { section: section.title, pdfPage: 1, originalNumber: "1" } },
    classification, submit: true,
  });
  if (!existing.saved) throw new Error("预置题目失败");
  bank.setContentStatus(existing.versionId, "approved");

  const task = makeTask(tasks, exam.id, section.id, draftOf(validQuestion("1", "整卷第一题题干")));
  wholeIntake.create(task.id, classification);
  const record = wholeIntake.list(task.id)[0];
  wholeIntake.resolve(task.id, record.id, "revise");

  const latest = bank.getLatestQuestionVersion(existing.questionId)!;
  expect(latest.version).toBe(2);
  expect(latest.contentStatus).toBe("pending");
  expect(JSON.stringify(latest.content)).toContain("整卷第一题题干");
  const first = bank.getQuestionVersion(existing.versionId)!;
  expect(first.contentStatus).toBe("approved");
  expect(JSON.stringify(first.content)).toContain("留言条");

  const resolved = wholeIntake.list(task.id)[0];
  expect(resolved.status).toBe("revised");
  expect(resolved.versionId).toBe(latest.id);
});

test("单题校验失败记 failed 不中断整批；进行中批次与无效分类拒绝建档", () => {
  const context = setup();
  const { tasks, wholeIntake, exam, section } = stores(context);
  const broken = { stem: "整卷缺号题题干", subquestions: [], options: [], tags: [], uncertain: [], page: 1, parts: [part("说明理由。")] };
  const task = makeTask(tasks, exam.id, section.id, draftOf(
    validQuestion("1", "整卷第一题题干"),
    broken,
    validQuestion("3", "整卷第三题题干"),
  ));
  const summary = wholeIntake.create(task.id, classification);
  expect(summary.created).toBe(2);
  expect(summary.failed).toBe(1);
  const items = wholeIntake.list(task.id);
  expect(items[1].status).toBe("failed");
  expect(items[1].message).toContain("原题号");
  expect(context.exams.listQuestions(exam.id)).toHaveLength(2);

  const running = makeTask(tasks, exam.id, section.id, draftOf(validQuestion("9", "执行中")));
  const runningState = {
    ...running.state,
    batches: running.state.batches.map((batch) => {
      const { result: _drop, ...rest } = batch;
      return { ...rest, status: "running" as const };
    }),
  };
  const runningTask = tasks.save(running.id, running.revision, runningState);
  expect(() => wholeIntake.create(runningTask.id, classification)).toThrow(/正在执行/);

  expect(() => wholeIntake.create(task.id, { ...classification, subject: "" })).toThrow(/学科无效/);
});
