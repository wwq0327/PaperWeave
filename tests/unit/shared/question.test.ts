import { expect, test } from "vitest";
import {
  buildSearchText,
  classificationProblem,
  hasContent,
  isClassification,
  materialImpacts,
  isQuestionContent,
  questionContentProblem,
  questionReadiness,
  selectionDependencies,
  selectionScore,
  type Classification,
  type QuestionBlock,
  type QuestionInline,
  type ReadinessInput,
} from "../../../src/shared/question";
import { exercise, math, note, paragraph as p, readingGroup, referenceGroup } from "../fixtures/questions";

function firstReference(blocks: QuestionBlock[]): Extract<QuestionInline, { type: "reference" }> {
  for (const block of blocks) {
    if (block.type !== "paragraph") continue;
    for (const run of block.runs) if (run.type === "reference") return run;
  }
  throw new Error("没有引用节点");
}

test("接受二选一习作、分项评分与依赖前问的自制结构", () => {
  for (const content of [exercise(), note(), math(), readingGroup(), referenceGroup()]) {
    expect(questionContentProblem(content)).toBeNull();
    expect(isQuestionContent(content)).toBe(true);
  }
});

test("二选一按同分候选计组总分 30，留言条计 5", () => {
  expect(selectionScore(exercise())).toEqual({ total: 30, conflict: null });
  expect(selectionScore(note())).toEqual({ total: 5, conflict: null });
  expect(selectionScore(math())).toEqual({ total: 10, conflict: null });
});

test("原分值优先于评分点合计，缺失时回退评分点", () => {
  const content = math();
  content.subQuestions[0].originalScore = 5;
  expect(selectionScore(content).total).toBe(11);

  content.subQuestions[0].originalScore = null;
  expect(selectionScore(content).total).toBe(10);

  expect(selectionScore(referenceGroup()).total).toBe(10);
});

test("候选分值不同时返回冲突而不相加", () => {
  const content = exercise();
  content.subQuestions[1].originalScore = 40;
  const result = selectionScore(content);
  expect(result.total).toBe(0);
  expect(result.conflict).toContain("候选分值不同");
});

test("拒绝未知字段、重复标识、悬空引用和悬空依赖", () => {
  expect(isQuestionContent({ ...note(), extra: true })).toBe(false);

  const missingExplanation = note();
  delete (missingExplanation.subQuestions[0] as { explanation?: unknown }).explanation;
  expect(questionContentProblem(missingExplanation)).not.toBeNull();

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

test("拒绝悬空的小问、材料与图引用，以及空回退文字", () => {
  const sub = referenceGroup();
  firstReference(sub.subQuestions[1].prompt).targetId = "missing";
  expect(isQuestionContent(sub)).toBe(false);

  const material = referenceGroup();
  firstReference(material.stem).targetId = "missing-material";
  expect(isQuestionContent(material)).toBe(false);

  const figure = referenceGroup();
  firstReference(figure.subQuestions[0].answers[0].blocks).targetId = "missing-figure";
  expect(isQuestionContent(figure)).toBe(false);

  const fallback = referenceGroup();
  firstReference(fallback.stem).fallback = " ";
  expect(isQuestionContent(fallback)).toBe(false);

  const kind = referenceGroup();
  (firstReference(kind.stem) as { kind: string }).kind = "book";
  expect(isQuestionContent(kind)).toBe(false);

  const extra = referenceGroup();
  (firstReference(extra.stem) as unknown as { note: string }).note = "多余字段";
  expect(isQuestionContent(extra)).toBe(false);
});

test("图标识在题目内容内必须唯一", () => {
  const content = referenceGroup();
  content.subQuestions[1].prompt.push({ type: "image", id: "b".repeat(64), alt: "第二张图", figureId: "figure-1" });
  expect(questionContentProblem(content)).toBe("图标识重复");
});

test("旧结构缺少原分值或小问材料时拒绝，不静默补默认值", () => {
  const score = math() as unknown as { subQuestions: Record<string, unknown>[] };
  delete score.subQuestions[0].originalScore;
  expect(questionContentProblem(score)).not.toBeNull();

  const materials = math() as unknown as { subQuestions: Record<string, unknown>[] };
  delete materials.subQuestions[0].materialIds;
  expect(questionContentProblem(materials)).not.toBeNull();
});

test("拒绝非法原分值", () => {
  for (const originalScore of [-1, 1001, Number.NaN, Number.POSITIVE_INFINITY, "4"]) {
    const content = math();
    (content.subQuestions[0] as unknown as { originalScore: unknown }).originalScore = originalScore;
    expect(questionContentProblem(content)).not.toBeNull();
  }
  const zero = math();
  zero.subQuestions[0].originalScore = 0;
  expect(questionContentProblem(zero)).toBeNull();
  const half = math();
  half.subQuestions[0].originalScore = 0.5;
  expect(questionContentProblem(half)).toBeNull();
});

test("小问材料必须非重且存在于题组材料池", () => {
  const missing = referenceGroup();
  missing.subQuestions[0].materialIds = ["missing"];
  expect(questionContentProblem(missing)).not.toBeNull();

  const duplicate = referenceGroup();
  duplicate.subQuestions[0].materialIds = ["material-a", "material-a"];
  expect(questionContentProblem(duplicate)).not.toBeNull();

  const empty = referenceGroup();
  empty.subQuestions[0].materialIds = [];
  expect(questionContentProblem(empty)).toBeNull();
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

const validClassification: Classification = {
  stage: "小学",
  subject: "语文",
  grade: "三年级",
  examType: "期中",
  year: "2025-2026",
  sourceName: "自编",
  questionType: "阅读",
  knowledgePoints: ["概括", "人物形象"],
};

test("接受完整分类并拒绝未知学段、重复知识点和未知字段", () => {
  expect(classificationProblem(validClassification)).toBeNull();
  expect(isClassification(validClassification)).toBe(true);
  expect(isClassification({ ...validClassification, stage: "大学" })).toBe(false);
  expect(isClassification({ ...validClassification, knowledgePoints: ["概括", "概括"] })).toBe(false);
  expect(isClassification({ ...validClassification, knowledgePoints: [" "] })).toBe(false);
  expect(isClassification({ ...validClassification, extra: true })).toBe(false);
  expect(isClassification({ ...validClassification, subject: " " })).toBe(false);
  expect(isClassification({ ...validClassification, grade: "" })).toBe(false);
  expect(isClassification({ ...validClassification, knowledgePoints: ["词".repeat(101)] })).toBe(false);
  expect(isClassification({ ...validClassification, sourceName: "来".repeat(201) })).toBe(false);
  expect(isClassification({ ...validClassification, knowledgePoints: Array.from({ length: 31 }, (_, index) => `点${index}`) })).toBe(false);
  expect(isClassification({ stage: "小学", subject: "语文", grade: "三年级", knowledgePoints: [] })).toBe(false);
  expect(isClassification({ ...validClassification, examType: "", year: "", sourceName: "", questionType: "" })).toBe(true);
});

test("可搜索文本只含题组指令、小问题干与选项", () => {
  const content = note();
  content.stem = [p("题组指令文字")];
  content.subQuestions[0].prompt = [
    p("小问题干文字"),
    p("合并  空白"),
    { type: "formula", latex: "x^{2}" },
    { type: "table", rows: [["表格单元"]] },
    { type: "image", id: "a".repeat(64), alt: "示意图" },
  ];
  content.subQuestions[0].options = [{ label: "A", content: [p("选项内容文字")] }];
  content.subQuestions[0].explanation = [p("解析文字")];
  content.subQuestions[0].answers = [{ slotId: null, blocks: [p("答案文字")], variants: ["变体文字"] }];
  content.subQuestions[0].scoring = [{ id: "s1", description: "评分说明文字", score: 5, slotIds: [] }];
  const searchText = buildSearchText(content);
  for (const expected of ["题组指令文字", "小问题干文字", "合并 空白", "x^{2}", "表格单元", "示意图", "A", "选项内容文字"]) {
    expect(searchText).toContain(expected);
  }
  for (const forbidden of ["解析文字", "答案文字", "变体文字", "评分说明文字"]) {
    expect(searchText).not.toContain(forbidden);
  }

  const long = note();
  long.subQuestions[0].prompt = [p("长".repeat(20000)), p("文".repeat(20000))];
  expect(buildSearchText(long).length).toBeLessThanOrEqual(20000);

  const referenced = referenceGroup();
  for (const expected of ["材料一", "图 1", "(1)"]) {
    expect(buildSearchText(referenced)).toContain(expected);
  }
  expect(hasContent(referenced.subQuestions[1].prompt)).toBe(true);
});

test("传递前问按原顺序返回，直接前问单列", () => {
  const deps = selectionDependencies(readingGroup(), "read-4");
  expect(deps.subQuestionId).toBe("read-4");
  expect(deps.directPrevious).toEqual(["read-3"]);
  expect(deps.previous).toEqual(["read-1", "read-2", "read-3"]);
});

test("共享材料与组选答候选进入依赖结果", () => {
  const reading = selectionDependencies(readingGroup(), "read-1");
  expect(reading.materialIds).toEqual(["material-a"]);
  expect(reading.groupCandidates).toEqual([]);
  expect(reading.usesGroupStem).toBe(true);

  const chosen = selectionDependencies(exercise(), "task-a");
  expect(chosen.groupCandidates).toEqual(["task-a", "task-b"]);
  expect(chosen.materialIds).toEqual([]);

  const partial = exercise();
  partial.selection = { mode: "choose", required: 1, candidates: ["task-a"] };
  expect(selectionDependencies(partial, "task-b").groupCandidates).toEqual([]);
});

test("依赖材料只看当前小问，不看题组材料池", () => {
  const content = referenceGroup();
  expect(selectionDependencies(content, "ref-1").materialIds).toEqual(["material-a"]);
  expect(selectionDependencies(content, "ref-2").materialIds).toEqual(["material-b"]);

  content.stem = [];
  content.subQuestions[0].materialIds = [];
  content.subQuestions[0].dependsOn = [];
  expect(selectionDependencies(content, "ref-1").independent).toBe(true);
});

test("无题组指令、无材料、无前问的小问判定为独立可用", () => {
  const content = note();
  content.stem = [];
  expect(selectionDependencies(content, "note-1")).toMatchObject({
    directPrevious: [],
    previous: [],
    materialIds: [],
    groupCandidates: [],
    usesGroupStem: false,
    independent: true,
  });
  expect(selectionDependencies(readingGroup(), "read-1").independent).toBe(false);
  expect(selectionDependencies(readingGroup(), "read-4").independent).toBe(false);
});

test("不存在的小问标识被拒绝", () => {
  expect(() => selectionDependencies(note(), "missing")).toThrow("小问不存在");
});

function chainedMaterial(): ReturnType<typeof math> {
  const content = math();
  content.materials = [{ materialId: "material-m", versionId: "material-m-v1" }];
  content.subQuestions[0].materialIds = ["material-m"];
  return content;
}

test("材料改动直接影响引用小问，并沿 dependsOn 传递为间接影响", () => {
  const content = chainedMaterial();
  const third = structuredClone(content.subQuestions[1]);
  third.id = "part-3";
  third.dependsOn = ["part-2"];
  content.subQuestions.push(third);
  expect(materialImpacts(content, "material-m")).toEqual([
    { subQuestionId: "part-1", direct: true, via: [] },
    { subQuestionId: "part-2", direct: false, via: ["part-1"] },
    { subQuestionId: "part-3", direct: false, via: ["part-2"] },
  ]);
  expect(materialImpacts(content, "other-material")).toEqual([]);
});

test("无依赖关系的小问不列为间接影响", () => {
  const content = chainedMaterial();
  content.subQuestions[1].dependsOn = [];
  expect(materialImpacts(content, "material-m")).toEqual([
    { subQuestionId: "part-1", direct: true, via: [] },
  ]);
});

test("材料只出现在题组材料池时整组视为直接影响", () => {
  const content = math();
  content.materials = [{ materialId: "material-m", versionId: "material-m-v1" }];
  expect(materialImpacts(content, "material-m")).toEqual([
    { subQuestionId: "part-1", direct: true, via: [] },
    { subQuestionId: "part-2", direct: true, via: [] },
  ]);
});

test("循环与自依赖数据不崩溃", () => {
  const content = chainedMaterial();
  content.subQuestions[0].dependsOn = ["part-2"];
  content.subQuestions[1].dependsOn = ["part-1"];
  expect(materialImpacts(content, "material-m")).toEqual([
    { subQuestionId: "part-1", direct: true, via: [] },
    { subQuestionId: "part-2", direct: false, via: ["part-1"] },
  ]);

  const lonely = math();
  lonely.subQuestions[0].dependsOn = ["part-2"];
  lonely.subQuestions[1].dependsOn = ["part-1"];
  expect(materialImpacts(lonely, "material-m")).toEqual([]);
});
