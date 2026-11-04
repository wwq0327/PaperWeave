import { expect, test } from "vitest";
import type { Block } from "../../../src/shared/document";
import { hasContent, isQuestionContent, questionContentProblem, questionReadiness, selectionScore, type QuestionContent, type ReadinessInput } from "../../../src/shared/question";

const p = (text: string): Block => ({ type: "paragraph", runs: [{ type: "text", text, style: "普通" }] });

/** 二选一习作：两个候选各 30 分，选 1 篇，组总分 30。 */
function exercise(): QuestionContent {
  return {
    stem: [p("从下面两题中任选一题作文。")],
    subQuestions: [
      {
        id: "task-a",
        originalLabel: "题一",
        prompt: [p("以“那一刻”为题写一篇记叙文。")],
        options: [],
        slots: [],
        answers: [],
        scoring: [{ id: "score-a", description: "符合题意，结构完整", score: 30, slotIds: [] }],
        dependsOn: [],
      },
      {
        id: "task-b",
        originalLabel: "题二",
        prompt: [p("以“改变”为题写一篇记叙文。")],
        options: [],
        slots: [],
        answers: [],
        scoring: [{ id: "score-b", description: "符合题意，结构完整", score: 30, slotIds: [] }],
        dependsOn: [],
      },
    ],
    materials: [],
    selection: { mode: "choose", required: 1, candidates: ["task-a", "task-b"] },
    source: { section: "语文·写作", pdfPage: 8, originalNumber: "17" },
  };
}

/** 留言条：一个作答位置，格式 2 + 内容 2 + 表达 1 = 5 分。 */
function note(): QuestionContent {
  return {
    stem: [p("根据情境写一张留言条。")],
    subQuestions: [
      {
        id: "note-1",
        originalLabel: "(3)",
        prompt: [p("同学不在家，请代写留言条说明还书一事。")],
        options: [],
        slots: [{ id: "note-slot", label: "留言条", kind: "text", required: true, interchangeableWith: [] }],
        answers: [{ slotId: "note-slot", blocks: [p("示例答案")], variants: [] }],
        scoring: [
          { id: "format", description: "格式正确", score: 2, slotIds: ["note-slot"] },
          { id: "content", description: "内容完整", score: 2, slotIds: ["note-slot"] },
          { id: "express", description: "表达清楚", score: 1, slotIds: ["note-slot"] },
        ],
        dependsOn: [],
      },
    ],
    materials: [],
    selection: { mode: "all" },
    source: { section: "语文·积累运用", pdfPage: 4, originalNumber: "15" },
  };
}

/** 数学综合题：小问 (2) 依赖前问 (1)。 */
function math(): QuestionContent {
  return {
    stem: [p("已知函数 f(x) 满足给定条件。")],
    subQuestions: [
      {
        id: "part-1",
        originalLabel: "(1)",
        prompt: [p("求 f(1) 的值。")],
        options: [],
        slots: [{ id: "p1-slot", label: "答案", kind: "text", required: true, interchangeableWith: [] }],
        answers: [{ slotId: "p1-slot", blocks: [p("3")], variants: [] }],
        scoring: [{ id: "p1-score", description: "得出 f(1)=3", score: 4, slotIds: ["p1-slot"] }],
        dependsOn: [],
      },
      {
        id: "part-2",
        originalLabel: "(2)",
        prompt: [p("利用第(1)问的结果，求最大值。")],
        options: [],
        slots: [],
        answers: [],
        scoring: [{ id: "p2-score", description: "得出最大值", score: 6, slotIds: [] }],
        dependsOn: ["part-1"],
      },
    ],
    materials: [],
    selection: { mode: "all" },
    source: { section: "数学·解答题", pdfPage: 7, originalNumber: "23" },
  };
}

test("接受二选一习作、分项评分与依赖前问的自制结构", () => {
  for (const content of [exercise(), note(), math()]) {
    expect(questionContentProblem(content)).toBeNull();
    expect(isQuestionContent(content)).toBe(true);
  }
});

test("二选一按同分候选计组总分 30，留言条计 5", () => {
  expect(selectionScore(exercise())).toEqual({ total: 30, conflict: null });
  expect(selectionScore(note())).toEqual({ total: 5, conflict: null });
  expect(selectionScore(math())).toEqual({ total: 10, conflict: null });
});

test("候选分值不同时返回冲突而不相加", () => {
  const content = exercise();
  content.subQuestions[1].scoring[0].score = 40;
  const result = selectionScore(content);
  expect(result.total).toBe(0);
  expect(result.conflict).toContain("候选分值不同");
});

test("拒绝未知字段、重复标识、悬空引用和悬空依赖", () => {
  expect(isQuestionContent({ ...note(), extra: true })).toBe(false);

  const duplicateSub = math();
  duplicateSub.subQuestions[1].id = "part-1";
  expect(questionContentProblem(duplicateSub)).not.toBeNull();

  const danglingSlot = note();
  danglingSlot.subQuestions[0].answers[0].slotId = "missing-slot";
  expect(questionContentProblem(danglingSlot)).not.toBeNull();

  const danglingScore = note();
  danglingScore.subQuestions[0].scoring[0].slotIds = ["missing-slot"];
  expect(questionContentProblem(danglingScore)).not.toBeNull();

  const danglingDepends = math();
  danglingDepends.subQuestions[1].dependsOn = ["missing-part"];
  expect(questionContentProblem(danglingDepends)).not.toBeNull();

  const asymmetric = note();
  asymmetric.subQuestions[0].slots.push({ id: "note-slot-2", label: "第二空", kind: "blank", required: false, interchangeableWith: [] });
  asymmetric.subQuestions[0].slots[0].interchangeableWith = ["note-slot-2"];
  expect(questionContentProblem(asymmetric)).not.toBeNull();
});

test("拒绝指向后置或跨组小问的依赖", () => {
  const backward = math();
  backward.subQuestions[0].dependsOn = ["part-2"];
  expect(isQuestionContent(backward)).toBe(false);

  const external = math();
  external.subQuestions[1].dependsOn = ["task-a"];
  expect(isQuestionContent(external)).toBe(false);
});

test("拒绝非法的组选答规则", () => {
  const zero = exercise();
  zero.selection = { mode: "choose", required: 0, candidates: ["task-a", "task-b"] };
  expect(isQuestionContent(zero)).toBe(false);

  const tooMany = exercise();
  tooMany.selection = { mode: "choose", required: 3, candidates: ["task-a", "task-b"] };
  expect(isQuestionContent(tooMany)).toBe(false);

  const unknown = exercise();
  unknown.selection = { mode: "choose", required: 1, candidates: ["task-a", "missing"] };
  expect(isQuestionContent(unknown)).toBe(false);

  const duplicate = exercise();
  duplicate.selection = { mode: "choose", required: 1, candidates: ["task-a", "task-a"] };
  expect(isQuestionContent(duplicate)).toBe(false);

  const fraction = exercise();
  fraction.selection = { mode: "choose", required: 1.5, candidates: ["task-a", "task-b"] };
  expect(isQuestionContent(fraction)).toBe(false);
});

test("换行和空白内容不算已填写", () => {
  expect(hasContent([])).toBe(false);
  expect(hasContent([p("  \n\t")])).toBe(false);
  expect(hasContent([{ type: "formula", latex: " " }])).toBe(false);
  expect(hasContent([{ type: "table", rows: [["", " "]] }])).toBe(false);
  expect(hasContent([p("有内容")])).toBe(true);
  expect(hasContent([{ type: "image", id: "a".repeat(64), alt: "" }])).toBe(true);
});

function readiness(overrides: Partial<ReadinessInput> = {}): ReadinessInput {
  return { content: math(), contentStatus: "approved", answerStatus: "approved", confirmAnswerGap: false, materialStatuses: {}, ...overrides };
}

test("内容未审核时阻断并说明原因", () => {
  const result = questionReadiness(readiness({ contentStatus: "pending" }));
  expect(result.ready).toBe(false);
  expect(result.blockers).toContain("题目内容尚未审核");
});

test("必要材料缺失或未审核时阻断", () => {
  const content = math();
  content.materials = [{ materialId: "material-1", versionId: "material-v1" }];
  const missing = questionReadiness(readiness({ content }));
  expect(missing.ready).toBe(false);
  expect(missing.blockers).toContain("材料「material-1」缺失");

  const pending = questionReadiness(readiness({ content, materialStatuses: { "material-v1": "pending" } }));
  expect(pending.blockers).toContain("材料「material-1」尚未审核");

  const approved = questionReadiness(readiness({ content, materialStatuses: { "material-v1": "approved" } }));
  expect(approved.ready).toBe(true);
});

test("小问题干为空时阻断", () => {
  const content = note();
  content.subQuestions[0].prompt = [p("   ")];
  const result = questionReadiness(readiness({ content }));
  expect(result.ready).toBe(false);
  expect(result.blockers).toContain("小问「(3)」缺少题干");
});

test("仅答案或评分待补时要求教师确认", () => {
  for (const answerStatus of ["missing", "pending"] as const) {
    const result = questionReadiness(readiness({ answerStatus }));
    expect(result.ready).toBe(false);
    expect(result.requiresAnswerConfirmation).toBe(true);
    expect(result.blockers).toContain("答案或评分尚未齐全，需教师确认后出卷");
  }
});

test("教师确认答案待补后通过并给出教师版提示", () => {
  const result = questionReadiness(readiness({ answerStatus: "missing", confirmAnswerGap: true }));
  expect(result.ready).toBe(true);
  expect(result.requiresAnswerConfirmation).toBe(true);
  expect(result.blockers).toEqual([]);
  expect(result.notices).toContain("答案或评分尚未齐全，教师版将标注待补");
});

test("内容与材料均已审核且答案齐全时直接通过", () => {
  const result = questionReadiness(readiness());
  expect(result).toEqual({ ready: true, blockers: [], notices: [], requiresAnswerConfirmation: false });
});
