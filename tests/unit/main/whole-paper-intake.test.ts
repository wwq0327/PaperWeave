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
import type { AiAnswerDraft, AiDraft, AiScanRect } from "../../../src/shared/ai";
import { createWholePaperRun } from "../../../src/shared/whole-paper-runner";
import type { WholePaperBatchPlan, WholePaperPageImage } from "../../../src/shared/whole-paper-batches";
import type { Classification } from "../../../src/shared/question";
import { note } from "../fixtures/questions";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function setup(metadata: Partial<{ stage: "小学" | "初中" | "高中"; subject: string; grade: string; examType: string; year: string; sourceName: string }> = {}) {
  const root = mkdtempSync(join(tmpdir(), "whole-paper-intake-")); dirs.push(root);
  const db = new Database(join(root, "db.sqlite"));
  const source = join(root, "paper.pdf"); writeFileSync(source, "%PDF-1.4\n%%EOF");
  const exams = new ExamStore(db, root);
  const exam = exams.importPaper({ title: "自制卷", stage: "初中", subject: "数学", grade: "九年级", region: "", examType: "", year: "", sourceName: "", ...metadata }, source).exam;
  const section = exams.getExam(exam.id).sections[0];
  return { root, db, exams, exam, section };
}

function stores({ db, exams, exam, section }: ReturnType<typeof setup>, cropScan?: (pageImage: WholePaperPageImage, rect: AiScanRect) => { attachmentId: string } | { error: string }) {
  const bank = new QuestionBank(db);
  const intake = new Intake(exams, bank);
  const tasks = new WholePaperStore(db);
  const wholeIntake = new WholePaperIntake(db, tasks, intake, bank, exams, cropScan);
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

function makeMultiBatchTask(tasks: WholePaperStore, examId: string, sectionId: string, drafts: AiDraft[]) {
  const batches = drafts.map((draft, index) => {
    const text = `第${index + 1}批文字`;
    return { fragments: [{ page: index + 1, start: 0, end: text.length, text }], pages: [index + 1], text, sendable: true, reviewBoundaryBefore: index > 0 };
  });
  const plan: WholePaperBatchPlan = { emptyPages: [], batches };
  const state = createWholePaperRun(plan);
  const task = tasks.create(examId, sectionId, state);
  const done = {
    ...state,
    batches: state.batches.map((batch, index) => ({ ...batch, status: "succeeded" as const, result: drafts[index] })),
  };
  return tasks.save(task.id, task.revision, done);
}

const part = (prompt: string, answer = "A") => ({ label: "(1)", prompt, options: [], answer, explanation: "解析", score: 3, uncertain: [] });
const validQuestion = (originalNumber: string, stem: string, extra: Partial<AiDraft["questions"][number]> = {}) => ({
  stem, subquestions: [], options: [], tags: [], uncertain: [], page: 1,
  parts: [part("选择正确项。")], questionType: "选择题", knowledgePoints: ["词语运用"], originalNumber,
  sourceAnchors: [{ page: 1, start: 0, end: 10 }], ...extra,
});

function makeDocxTask(tasks: WholePaperStore, examId: string, sectionId: string, text: string, images: NonNullable<WholePaperBatchPlan["docxImages"]>) {
  const fragments = [{ page: 1, start: 0, end: [...text].length, text }];
  const plan: WholePaperBatchPlan = {
    sourceKind: "docx",
    emptyPages: [],
    batches: [{ fragments, pages: [1], text, sendable: true, reviewBoundaryBefore: false }],
    docxImages: images,
  };
  const state = createWholePaperRun(plan);
  const task = tasks.create(examId, sectionId, state);
  const done = { ...state, batches: state.batches.map((batch) => ({ ...batch, status: "succeeded" as const, result: draftOf(validQuestion("1", "DOCX 题", { sourceAnchors: [{ page: 1, start: 0, end: [...text].length }] })) })) };
  return tasks.save(task.id, task.revision, done);
}

function makeAnswerTask(tasks: WholePaperStore, examId: string, sectionId: string, draft: AiDraft, answers: AiAnswerDraft) {
  // 文字批与答案批共用页号：答案文字不能混入原卷覆盖。
  const text = "甲".repeat(10);
  const answerText = "Question 1: Answer 4";
  const answer = { fileId: "file-1", role: "answer" as const, name: "答案.pdf" };
  const plan: WholePaperBatchPlan = {
    emptyPages: [],
    answerFiles: [answer],
    batches: [
      { fragments: [{ page: 1, start: 0, end: 10, text }], pages: [1], text, sendable: true, reviewBoundaryBefore: false },
      { kind: "answer-text", fragments: [{ page: 1, start: 0, end: [...answerText].length, text: answerText }], pages: [1], text: answerText, sendable: true, reviewBoundaryBefore: true, answer },
    ],
  };
  const state = createWholePaperRun(plan);
  const task = tasks.create(examId, sectionId, state);
  const done = {
    ...state,
    batches: [
      { ...state.batches[0], status: "succeeded" as const, result: draft },
      { ...state.batches[1], status: "succeeded" as const, answers },
    ],
  };
  return tasks.save(task.id, task.revision, done);
}



const attachment = "a".repeat(64);
const cropAttachment = "c".repeat(64);

function makeScanTask(tasks: WholePaperStore, examId: string, sectionId: string, draft: AiDraft) {
  const plan: WholePaperBatchPlan = {
    emptyPages: [1],
    batches: [{ kind: "scan", fragments: [], pages: [1], text: "", sendable: true, reviewBoundaryBefore: false, image: { page: 1, attachmentId: attachment, width: 1200, height: 1600 } }],
  };
  const state = createWholePaperRun(plan);
  const task = tasks.create(examId, sectionId, state);
  const done = { ...state, batches: state.batches.map((batch) => ({ ...batch, status: "succeeded" as const, result: draft })) };
  return tasks.save(task.id, task.revision, done);
}

const SHARED_MATERIAL = { title: "共享材料", content: "材料正文", source: "固定响应" };

test("数据版本 10：整卷建档记录表带任务内唯一约束、质量与证据字段", () => {
  const { db } = setup();
  expect(db.dataVersion()).toBe(10);
  const now = new Date().toISOString();
  const insert = () => db.transaction((s) => {
    s.prepare("INSERT INTO whole_paper_intakes (id, task_id, batch_index, question_index, status, created_at, updated_at) VALUES ('r1','t',0,0,'created',?,?)").run(now, now);
  });
  insert();
  const row = db.read((s) => s.prepare("SELECT quality, issues, member_keys, evidence FROM whole_paper_intakes WHERE id = 'r1'").get()) as { quality: string; issues: string; member_keys: string; evidence: string };
  expect(row).toEqual({ quality: "needs_attention", issues: "[]", member_keys: "[]", evidence: "{}" });
  expect(() => insert()).toThrow();
});

test("跨批同题号合并建档：只建一条记录，成员键与证据齐全，重复建档不新增", () => {
  const context = setup();
  const { tasks, wholeIntake, exam, section } = stores(context);
  const first = validQuestion("6", "跨批题第一段", { page: 1, sourceAnchors: [{ page: 1, start: 0, end: 6 }], parts: [{ ...part("求值。"), answer: "", score: null }] });
  const second = validQuestion("6", "跨批题第二段", { page: 2, sourceAnchors: [{ page: 2, start: 0, end: 8 }], parts: [{ ...part("求值并说明理由。"), answer: "4", score: 5 }] });
  const task = makeMultiBatchTask(tasks, exam.id, section.id, [draftOf(first), draftOf(second)]);

  const summary = wholeIntake.create(task.id, classification);
  expect(summary.created).toBe(1);
  const items = wholeIntake.list(task.id);
  expect(items).toHaveLength(1);
  expect(items[0].memberKeys).toEqual(["0:0", "1:0"]);
  expect(items[0].evidence.anchors).toEqual([{ page: 1, start: 0, end: 6 }, { page: 2, start: 0, end: 8 }]);
  expect(items[0].batchIndex).toBe(0);
  expect(items[0].questionIndex).toBe(0);

  const again = wholeIntake.create(task.id, classification);
  expect(again.created).toBe(0);
  expect(again.existing).toBe(1);
  expect(context.exams.listQuestions(exam.id)).toHaveLength(1);
});

test("覆盖对账汇总成功批次与记录锚点", () => {
  const context = setup();
  const { tasks, wholeIntake, exam, section } = stores(context);
  const task = makeTask(tasks, exam.id, section.id, draftOf(validQuestion("1", "覆盖题题干")));
  wholeIntake.create(task.id, classification);
  const coverage = wholeIntake.coverage(task.id);
  expect(coverage.percent).toBe(100);
  expect(coverage.gaps).toEqual([]);
  expect(coverage.pages).toEqual([{ page: 1, total: 10, covered: 10 }]);
});

test("答案文字批次不计入原卷覆盖", () => {
  const context = setup();
  const { tasks, wholeIntake, exam, section } = stores(context);
  const task = makeAnswerTask(tasks, exam.id, section.id, draftOf(validQuestion("1", "覆盖题题干")), { answers: [{ originalNumber: "1", label: "", answer: "4", page: 1 }], notes: [] });
  wholeIntake.create(task.id, classification);
  const coverage = wholeIntake.coverage(task.id);
  expect(coverage.percent).toBe(100);
  expect(coverage.pages).toEqual([{ page: 1, total: 10, covered: 10 }]);
  expect(coverage.gaps).toEqual([]);
});

test("同卷答案唯一匹配：填入空白小问并记录答案条目", () => {
  const context = setup();
  const { bank, tasks, wholeIntake, exam, section } = stores(context);
  const question = validQuestion("1", "答案题", { parts: [{ ...part("求值。"), answer: "" }] });
  const task = makeAnswerTask(tasks, exam.id, section.id, draftOf(question), { answers: [{ originalNumber: "1", label: "", answer: "4", page: 1 }], notes: [] });
  const summary = wholeIntake.create(task.id, classification);
  expect(summary.answerMatched).toBe(1);
  expect(summary.answerAmbiguous).toBe(0);
  const item = wholeIntake.list(task.id)[0];
  expect(item.evidence.answerKeys).toEqual(["1:0"]);
  expect(item.issues.map((entry) => entry.code)).not.toContain("answer_missing");
  const content = bank.getLatestQuestionVersion(item.questionId!)!.content;
  expect(content.subQuestions[0].answers).toHaveLength(1);
  expect(JSON.stringify(content.subQuestions[0].answers)).toContain('"text":"4"');
  expect(wholeIntake.coverage(task.id).answerMatches).toEqual({ total: 1, matched: 1, ambiguous: 0, unmatched: 0 });
});

test("同小问多条答案记为歧义，不填入且阻止自动通过", () => {
  const context = setup();
  const { bank, tasks, wholeIntake, exam, section } = stores(context);
  const question = validQuestion("1", "歧义题", { parts: [{ ...part("求值。"), answer: "" }] });
  const task = makeAnswerTask(tasks, exam.id, section.id, draftOf(question), {
    answers: [{ originalNumber: "1", label: "(1)", answer: "4", page: 1 }, { originalNumber: "1", label: "(1)", answer: "5", page: 1 }],
    notes: [],
  });
  const summary = wholeIntake.create(task.id, classification);
  expect(summary.answerAmbiguous).toBe(2);
  expect(summary.answerMatched).toBe(0);
  const item = wholeIntake.list(task.id)[0];
  expect(item.quality).toBe("needs_attention");
  expect(item.issues.map((entry) => entry.code)).toContain("answer_ambiguous");
  const content = bank.getLatestQuestionVersion(item.questionId!)!.content;
  expect(content.subQuestions[0].answers).toEqual([]);
  expect(wholeIntake.coverage(task.id).answerMatches).toEqual({ total: 2, matched: 0, ambiguous: 2, unmatched: 0 });
});

test("答案题号无对应题时进入覆盖未匹配", () => {
  const context = setup();
  const { tasks, wholeIntake, exam, section } = stores(context);
  const task = makeAnswerTask(tasks, exam.id, section.id, draftOf(validQuestion("1", "普通题")), { answers: [{ originalNumber: "99", label: "(1)", answer: "4", page: 1 }], notes: [] });
  wholeIntake.create(task.id, classification);
  expect(wholeIntake.coverage(task.id).answerMatches).toEqual({ total: 1, matched: 0, ambiguous: 0, unmatched: 1 });
});

test("无锚点且题号无法定位时记 anchor_missing 并阻止自动通过", () => {
  const context = setup();
  const { tasks, wholeIntake, exam, section } = stores(context);
  const task = makeTask(tasks, exam.id, section.id, draftOf(validQuestion("1", "无锚点题题干", { sourceAnchors: [] })));
  wholeIntake.create(task.id, classification);
  const item = wholeIntake.list(task.id)[0];
  expect(item.quality).toBe("needs_attention");
  expect(item.issues.map((entry) => entry.code)).toContain("anchor_missing");
});

test("DOCX 内嵌 PNG 按来源锚点绑定到小问", () => {
  const context = setup();
  const { bank, tasks, wholeIntake, exam, section } = stores(context);
  const seeded = bank.createQuestion(note());
  bank.setClassification(seeded.questionId, { ...classification, questionType: "选择题", knowledgePoints: ["词语运用"] });
  const text = "1. 观察图片：[图片：pic.png]";
  const start = text.indexOf("[图片：pic.png]");
  const task = makeDocxTask(tasks, exam.id, section.id, text, [{ unit: 1, start, end: start + [..."[图片：pic.png]"].length, name: "pic.png", attachmentId: attachment }]);
  wholeIntake.create(task.id, classification);
  const item = wholeIntake.list(task.id)[0];
  expect(item.quality).toBe("auto_passed");
  const content = bank.getLatestQuestionVersion(item.questionId!)!.content;
  expect(content.subQuestions[0].prompt).toContainEqual({ type: "image", id: attachment, alt: "内嵌图 pic.png" });
});

test("DOCX 公式与无法自动提取的图片进入待核异常", () => {
  const context = setup();
  const { tasks, wholeIntake, exam, section } = stores(context);
  const formula = makeDocxTask(tasks, exam.id, section.id, "1. 已知 f(x) = [公式]，求值。", []);
  wholeIntake.create(formula.id, classification);
  const formulaItem = wholeIntake.list(formula.id)[0];
  expect(formulaItem.quality).toBe("needs_attention");
  expect(formulaItem.issues.map((entry) => entry.code)).toContain("formula_review");
  expect(formulaItem.issues.find((entry) => entry.code === "formula_review")?.message).toContain("OMML 公式");

  const image = makeDocxTask(tasks, exam.id, section.id, "1. 图形：[图片：pic.emf]", [{ unit: 1, start: 4, end: 17, name: "pic.emf", note: "不支持的图片格式（仅支持 PNG/JPEG）" }]);
  wholeIntake.create(image.id, classification);
  const imageItem = wholeIntake.list(image.id)[0];
  expect(imageItem.issues.map((entry) => entry.code)).toContain("image_review");
  expect(imageItem.issues.find((entry) => entry.code === "image_review")?.message).toContain("pic.emf");
});

test("DOCX 缺失图片关系提示人工补录", () => {
  const context = setup();
  const { tasks, wholeIntake, exam, section } = stores(context);
  const task = makeDocxTask(tasks, exam.id, section.id, "1. 图形：[图片]", []);
  wholeIntake.create(task.id, classification);
  const item = wholeIntake.list(task.id)[0];
  expect(item.issues.map((entry) => entry.code)).toContain("image_review");
});

test("扫描题按归一化区域在本机裁图并写入小问", () => {
  const context = setup();
  const calls: { pageImage: WholePaperPageImage; rect: AiScanRect }[] = [];
  const { bank, tasks, wholeIntake, exam, section } = stores(context, (pageImage, rect) => {
    calls.push({ pageImage, rect });
    return { attachmentId: cropAttachment };
  });
  const seeded = bank.createQuestion(note());
  bank.setClassification(seeded.questionId, { ...classification, questionType: "选择题", knowledgePoints: ["词语运用"] });
  const rect = { x: 0.1, y: 0.2, width: 0.8, height: 0.5 };
  const task = makeScanTask(tasks, exam.id, section.id, draftOf(validQuestion("1", "扫描题干", { sourceAnchors: [], scanAreas: [{ page: 1, rect }] })));
  wholeIntake.create(task.id, classification);
  const item = wholeIntake.list(task.id)[0];
  expect(item.quality).toBe("auto_passed");
  expect(calls).toEqual([{ pageImage: { page: 1, attachmentId: attachment, width: 1200, height: 1600 }, rect }]);
  expect(item.evidence.scanRegions).toEqual([{ page: 1, rect }]);
  expect(item.issues.map((entry) => entry.code)).not.toContain("anchor_missing");
  const content = bank.getLatestQuestionVersion(item.questionId!)!.content;
  expect(content.subQuestions[0].prompt).toContainEqual({ type: "image", id: cropAttachment, alt: "扫描裁图 第 1 页" });
  const coverage = wholeIntake.coverage(task.id);
  expect(coverage.scanPages).toEqual([{ page: 1, covered: true }]);
  expect(coverage.scanPercent).toBe(100);
});

test("扫描裁图失败记为待核异常并保留区域证据", () => {
  const context = setup();
  const { tasks, wholeIntake, exam, section } = stores(context, () => ({ error: "页面图像损坏" }));
  const rect = { x: 0.1, y: 0.2, width: 0.8, height: 0.5 };
  const task = makeScanTask(tasks, exam.id, section.id, draftOf(validQuestion("1", "扫描题干", { sourceAnchors: [], scanAreas: [{ page: 1, rect }] })));
  wholeIntake.create(task.id, classification);
  const item = wholeIntake.list(task.id)[0];
  expect(item.quality).toBe("needs_attention");
  expect(item.evidence.scanRegions).toEqual([{ page: 1, rect }]);
  expect(item.issues.find((entry) => entry.code === "image_review")?.message).toContain("页面图像损坏");
});

test("旧记录缺少证据列时按空证据读取", () => {
  const context = setup();
  const { tasks, wholeIntake, exam, section } = stores(context);
  const task = makeTask(tasks, exam.id, section.id, draftOf(validQuestion("1", "占位")));
  const now = new Date().toISOString();
  context.db.transaction((s) => {
    s.prepare("INSERT INTO whole_paper_intakes (id, task_id, batch_index, question_index, status, created_at, updated_at) VALUES ('legacy', ?, 5, 5, 'failed', ?, ?)").run(task.id, now, now);
  });
  const legacy = wholeIntake.list(task.id).find((item) => item.id === "legacy");
  expect(legacy?.memberKeys).toEqual([]);
  expect(legacy?.evidence).toEqual({ anchors: [], materialAnchors: [], figures: [], answerSources: [], scanRegions: [], answerKeys: [] });
});

test("参数继承：整卷分类的空字段由考试元数据补齐", () => {
  const context = setup({ stage: "初中", subject: "数学", grade: "八年级", examType: "期中", year: "2025", sourceName: "区统考" });
  const { bank, tasks, wholeIntake, exam, section } = stores(context);
  const task = makeTask(tasks, exam.id, section.id, draftOf(validQuestion("1", "继承分类题")));
  const summary = wholeIntake.create(task.id, { ...classification, stage: "高中", subject: " ", grade: "", examType: "", year: "", sourceName: "", questionType: "选择题" });
  expect(summary.created).toBe(1);
  const questionId = context.exams.listQuestions(exam.id)[0].questionId;
  const row = context.db.read((s) => s.prepare("SELECT stage, subject, grade, exam_type, year, source_name FROM questions WHERE id = ?").get(questionId));
  expect(row).toEqual({ stage: "高中", subject: "数学", grade: "八年级", exam_type: "期中", year: "2025", source_name: "区统考" });
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
  expect(summary).toEqual({ created: 2, duplicates: 0, failed: 0, existing: 0, materials: 1, needsAttention: 2, answerMatched: 0, answerAmbiguous: 0 });

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
  expect(items[0].quality).toBe("needs_attention");
  expect(items[0].issues.map((entry) => entry.code)).toEqual(["material_pending"]);
  expect(items[1].issues.map((entry) => entry.code)).toEqual(["answer_missing", "material_pending"]);

  // 重复建档幂等：不产生新题、不重建材料。
  const again = wholeIntake.create(task.id, classification);
  expect(again).toEqual({ created: 0, duplicates: 0, failed: 0, existing: 2, materials: 0, needsAttention: 0, answerMatched: 0, answerAmbiguous: 0 });
  expect(context.exams.listQuestions(exam.id)).toHaveLength(2);
});

test("重复候选：记录并提示，可跳过或建修订版，已审核旧版本不覆盖", () => {
  const context = setup();
  const { bank, intake, tasks, wholeIntake, exam, section } = stores(context);
  const seeded = bank.createQuestion(note());
  bank.setClassification(seeded.questionId, { ...classification, questionType: "选择题", knowledgePoints: ["词语运用"] });
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
  expect(summary).toEqual({ created: 1, duplicates: 1, failed: 0, existing: 0, materials: 0, needsAttention: 1, answerMatched: 0, answerAmbiguous: 0 });

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
  const { bank, tasks, wholeIntake, exam, section } = stores(context);
  const seeded = bank.createQuestion(note());
  bank.setClassification(seeded.questionId, { ...classification, questionType: "选择题", knowledgePoints: ["词语运用"] });
  const broken = { stem: "整卷缺号题题干", subquestions: [], options: [], tags: [], uncertain: [], page: 1, parts: [part("说明理由。")] };
  const task = makeTask(tasks, exam.id, section.id, draftOf(
    validQuestion("1", "整卷第一题题干"),
    broken,
    validQuestion("3", "整卷第三题题干"),
  ));
  const summary = wholeIntake.create(task.id, classification);
  expect(summary.created).toBe(2);
  expect(summary.failed).toBe(1);
  expect(summary.needsAttention).toBe(1);
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

  expect(() => wholeIntake.create(task.id, { ...classification, subject: 123 as unknown as string })).toThrow(/学科无效/);
});

test("异常持久化：不确定项、新标签、缺答案、缺分值与材料待审阻止自动通过", () => {
  const context = setup();
  const { bank, tasks, wholeIntake, exam, section } = stores(context);
  const question = validQuestion("5", "异常题题干", {
    uncertain: ["公式待核"],
    parts: [{ label: "(1)", prompt: "求值。", options: [], answer: "", explanation: "", score: null, uncertain: [] }],
    materials: [{ title: "材料X", content: "材料正文", source: "自制" }],
  });
  const task = makeTask(tasks, exam.id, section.id, draftOf(question));
  const summary = wholeIntake.create(task.id, classification);
  expect(summary).toEqual({ created: 1, duplicates: 0, failed: 0, existing: 0, materials: 1, needsAttention: 1, answerMatched: 0, answerAmbiguous: 0 });

  const before = wholeIntake.list(task.id)[0];
  expect(before.quality).toBe("needs_attention");
  expect(new Set(before.issues.map((entry) => entry.code))).toEqual(new Set(["uncertain", "new_tag", "answer_missing", "score_missing", "material_pending"]));
  expect(wholeIntake.approve(task.id, [before.id])).toEqual({ approved: 0, rejected: [{ id: before.id, reason: expect.stringContaining("仍有未处理异常") }] });

  // 材料审核通过后，材料待审异常自动消除，其余异常仍需教师处理。
  bank.setMaterialStatus(before.materials[0].versionId, "pending");
  bank.setMaterialStatus(before.materials[0].versionId, "approved");
  const afterMaterial = wholeIntake.list(task.id)[0];
  expect(afterMaterial.issues.map((entry) => entry.code)).not.toContain("material_pending");
  expect(afterMaterial.problems).toEqual([]);
  expect(wholeIntake.approve(task.id, [before.id]).approved).toBe(0);

  wholeIntake.resolve(task.id, before.id, "resolve");
  expect(wholeIntake.list(task.id)[0].quality).toBe("resolved");
  expect(wholeIntake.approve(task.id, [before.id])).toEqual({ approved: 1, rejected: [] });
  const latest = bank.getLatestQuestionVersion(before.questionId!)!;
  expect(latest.contentStatus).toBe("approved");
  expect(latest.answerStatus).toBe("missing");
});

test("材料 appliesTo 只关联指定小问；未标明归属的多小问记异常", () => {
  const context = setup();
  const { bank, tasks, wholeIntake, exam, section } = stores(context);
  const seeded = bank.createQuestion(note());
  bank.setClassification(seeded.questionId, { ...classification, questionType: "选择题", knowledgePoints: ["词语运用"] });

  const scoped = validQuestion("1", "带归属题", {
    parts: [{ ...part("小问一。"), label: "(1)" }, { ...part("小问二。"), label: "(2)" }],
    materials: [{ title: "材料一", content: "正文一", source: "自制", appliesTo: ["(1)"] }],
  });
  const unscoped = validQuestion("2", "无归属题", {
    parts: [{ ...part("小问一。"), label: "(1)" }, { ...part("小问二。"), label: "(2)" }],
    materials: [{ title: "材料二", content: "正文二", source: "自制" }],
  });
  const task = makeTask(tasks, exam.id, section.id, draftOf(scoped, unscoped));
  wholeIntake.create(task.id, classification);

  const items = wholeIntake.list(task.id);
  const scopedContent = bank.getLatestQuestionVersion(items[0].questionId!)!.content;
  expect(scopedContent.subQuestions[0].materialIds).toEqual([items[0].materialIds[0]]);
  expect(scopedContent.subQuestions[1].materialIds).toEqual([]);
  expect(items[0].issues.map((entry) => entry.code)).not.toContain("material_scope");

  const unscopedContent = bank.getLatestQuestionVersion(items[1].questionId!)!.content;
  expect(unscopedContent.subQuestions[0].materialIds).toEqual([items[1].materialIds[0]]);
  expect(unscopedContent.subQuestions[1].materialIds).toEqual([items[1].materialIds[0]]);
  expect(items[1].issues.map((entry) => entry.code)).toContain("material_scope");
});

test("审批拒绝已有新版本的旧记录，并支持排除", () => {
  const context = setup();
  const { bank, intake, tasks, wholeIntake, exam, section } = stores(context);
  const seeded = bank.createQuestion(note());
  bank.setClassification(seeded.questionId, { ...classification, questionType: "选择题", knowledgePoints: ["词语运用"] });

  const task = makeTask(tasks, exam.id, section.id, draftOf(validQuestion("1", "第一版题干")));
  wholeIntake.create(task.id, classification);
  const record = wholeIntake.list(task.id)[0];
  expect(record.quality).toBe("auto_passed");

  const latestContent = bank.getLatestQuestionVersion(record.questionId!)!.content;
  const edited = intake.save({
    examId: exam.id, sectionId: section.id, questionId: record.questionId!,
    content: { ...latestContent, subQuestions: latestContent.subQuestions.map((sub) => ({ ...sub, prompt: [{ type: "paragraph", runs: [{ type: "text", text: "第二版题干", style: "普通" }] }] })) },
    classification, submit: true,
  });
  if (!edited.saved) throw new Error("修订失败");
  const stale = wholeIntake.approve(task.id, [record.id]);
  expect(stale.approved).toBe(0);
  expect(stale.rejected[0].reason).toContain("已有新版本");

  wholeIntake.resolve(task.id, record.id, "exclude");
  expect(wholeIntake.list(task.id)[0].quality).toBe("excluded");
  expect(wholeIntake.approve(task.id, [record.id]).rejected[0].reason).toContain("已排除");
});
