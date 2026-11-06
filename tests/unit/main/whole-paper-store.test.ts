import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { Database } from "../../../src/main/database";
import { ExamStore } from "../../../src/main/exams";
import { WholePaperStore } from "../../../src/main/whole-paper-store";
import { planWholePaperBatches } from "../../../src/shared/whole-paper-batches";
import { createWholePaperRun, WholePaperRunner } from "../../../src/shared/whole-paper-runner";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const draft = { questions: [{ stem: "题", subquestions: [], options: [], tags: [], uncertain: [], page: 1 }], notes: [] };
function setup() {
  const root = mkdtempSync(join(tmpdir(), "whole-paper-")); dirs.push(root);
  const path = join(root, "db.sqlite");
  const db = new Database(path);
  const source = join(root, "paper.pdf"); writeFileSync(source, "%PDF-1.4\n%%EOF");
  const exams = new ExamStore(db, root);
  const exam = exams.importPaper({ title: "自制卷", stage: "初中", subject: "数学", grade: "九年级", region: "", examType: "", year: "", sourceName: "" }, source).exam;
  const section = exams.getExam(exam.id).sections[0];
  const state = createWholePaperRun(planWholePaperBatches([{ page: 1, text: "甲".repeat(10) }], 20));
  return { root, path, db, exam, section, state };
}

test("保存执行结果并重开数据库恢复，失败批次重试不重复成功批次", async () => {
  const { path, db, exam, section, state } = setup();
  let store = new WholePaperStore(db);
  let task = store.create(exam.id, section.id, state);
  const request = vi.fn().mockResolvedValueOnce(draft).mockRejectedValueOnce(new Error("secret")).mockResolvedValue(draft);
  const runner = new WholePaperRunner(async (next) => { task = store.save(task.id, task.revision, next); }, request);
  await runner.run(task.state, new AbortController().signal);
  expect(store.list()).toHaveLength(1);
  expect(JSON.stringify(task)).not.toContain("secret");
  const id = task.id;
  db.close();
  const reopened = new Database(path);
  store = new WholePaperStore(reopened);
  task = store.get(id);
  expect(task.state.batches.map((batch) => batch.status)).toEqual(["succeeded", "failed"]);
  const retry = new WholePaperRunner(async (next) => { task = store.save(task.id, task.revision, next); }, request);
  await retry.run(task.state, new AbortController().signal, true);
  expect(store.get(id).state.batches.map((batch) => batch.status)).toEqual(["succeeded", "succeeded"]);
  expect(request).toHaveBeenCalledTimes(3);
  reopened.close();
});

test("拒绝错误分部、旧版本覆盖、计划变更与维护期间写入", () => {
  const { db, exam, section, state } = setup();
  const store = new WholePaperStore(db);
  expect(() => store.create(exam.id, "missing", state)).toThrow("考试分部不存在");
  const task = store.create(exam.id, section.id, state);
  const updated = store.save(task.id, task.revision, state);
  expect(() => store.save(task.id, task.revision, state)).toThrow("已被更新");
  const altered = createWholePaperRun(planWholePaperBatches([{ page: 1, text: "不同" }]));
  expect(() => store.save(task.id, updated.revision, altered)).toThrow("不可修改");
  db.beginMaintenance("备份");
  expect(() => store.save(task.id, updated.revision, state)).toThrow("备份进行中");
  db.endMaintenance(); db.close();
});

test("损坏状态不会被读取或覆盖", () => {
  const { db, exam, section, state } = setup();
  const store = new WholePaperStore(db);
  const task = store.create(exam.id, section.id, state);
  db.setSetting(`whole-paper.task.${task.id}`, "{");
  expect(() => store.get(task.id)).toThrow("数据损坏");
  expect(() => store.list()).toThrow("数据损坏");
  expect(() => store.save(task.id, task.revision, state)).toThrow("数据损坏");
  expect(db.getSetting(`whole-paper.task.${task.id}`)).toBe("{");
  db.close();
});

test("保存 DOCX 媒体定位并拒绝无效附件标识", () => {
  const { db, exam, section, state } = setup();
  state.plan.docxImages = [{ unit: 1, start: 0, end: 3, name: "pic.png", attachmentId: "a".repeat(64) }];
  const store = new WholePaperStore(db);
  const task = store.create(exam.id, section.id, state);
  expect(store.get(task.id).state.plan.docxImages).toEqual(state.plan.docxImages);
  const invalid = structuredClone(state);
  invalid.plan.docxImages = [{ unit: 1, start: 0, end: 3, name: "pic.png", attachmentId: "bad" }];
  expect(() => store.create(exam.id, section.id, invalid)).toThrow("初始状态无效");
  db.close();
});

test("保存扫描批次与答案批次，并拒绝缺失结果的完成状态", () => {
  const { db, exam, section } = setup();
  const store = new WholePaperStore(db);
  const image = { page: 1, attachmentId: "a".repeat(64), width: 1200, height: 1600 };
  const answer = { fileId: "file-1", role: "answer" as const, name: "答案.pdf" };
  const scanPlan = {
    batches: [
      { kind: "scan" as const, fragments: [], pages: [1], text: "", sendable: true, reviewBoundaryBefore: false, image },
      { kind: "answer-text" as const, fragments: [{ page: 1, start: 0, end: 4, text: "1. 4" }], pages: [1], text: "1. 4", sendable: true, reviewBoundaryBefore: true, answer },
    ],
    emptyPages: [],
    answerFiles: [answer],
  };
  const task = store.create(exam.id, section.id, createWholePaperRun(scanPlan));
  const succeeded = structuredClone(task.state);
  succeeded.batches[0] = { status: "succeeded", result: { questions: [{ stem: "题", subquestions: [], options: [], tags: [], uncertain: [], page: 1, scanAreas: [{ page: 1, rect: { x: 0, y: 0, width: 1, height: 1 } }] }], notes: [] } };
  succeeded.batches[1] = { status: "succeeded", answers: { answers: [{ originalNumber: "1", label: "", answer: "4", page: 1 }], notes: [] } };
  const saved = store.save(task.id, task.revision, succeeded);
  expect(store.get(saved.id).state.plan.batches.map((batch) => batch.kind)).toEqual(["scan", "answer-text"]);

  const missing = structuredClone(saved.state);
  delete (missing.batches[1] as { answers?: unknown }).answers;
  expect(() => store.save(saved.id, saved.revision, missing)).toThrow("状态无效");
  const badImage = structuredClone(saved.state.plan);
  badImage.batches[0].image = { ...image, attachmentId: "bad" };
  expect(() => store.create(exam.id, section.id, createWholePaperRun(badImage))).toThrow("初始状态无效");
  db.close();
});
