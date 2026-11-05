import { expect, test } from "vitest";
import { blankSubQuestion, buildContent, contentToForm, dependencyOrderProblems, duplicateSubLabels, moveSubQuestion, newIntakeForm } from "../../../src/shared/intake";
import { hasContent, isQuestionContent, type Classification, type QuestionContent } from "../../../src/shared/question";

const classification: Classification = {
  stage: "初中",
  subject: "数学",
  grade: "九年级",
  examType: "单元测",
  year: "2026",
  sourceName: "自制样题",
  questionType: "解答题",
  knowledgePoints: ["一元二次方程"],
};

function form() {
  const value = newIntakeForm(classification, "全卷");
  value.source = { section: "数学部分", pdfPage: "2", originalNumber: "17" };
  value.stem = [
    { kind: "text", text: "阅读材料，回答问题。" },
    { kind: "formula", latex: "x^2+1" },
  ];
  const sub = value.subQuestions[0];
  sub.originalLabel = "(1)";
  sub.prompt = [{ kind: "text", text: "求 $x$ 的值。" }];
  sub.options = "选项甲\n选项乙";
  sub.answer = [{ kind: "text", text: "4" }];
  sub.explanation = [{ kind: "text", text: "移项后开方。" }];
  sub.originalScore = "5";
  sub.scoring = [
    { description: "列式正确", score: "2", slotIds: [] },
    { description: "求得结果", score: "3", slotIds: [] },
  ];
  value.selection = { mode: "all" };
  return value;
}

test("表单生成题目内容：公式、选项、答案、评分与来源", () => {
  const { content, problems } = buildContent(form());
  expect(problems).toEqual([]);
  expect(content).not.toBeNull();
  const value = content as QuestionContent;
  expect(isQuestionContent(value)).toBe(true);
  expect(value.stem[0]).toEqual({ type: "paragraph", runs: [{ type: "text", text: "阅读材料，回答问题。", style: "普通" }] });
  expect(value.stem[1]).toEqual({ type: "formula", latex: "x^2+1" });
  const sub = value.subQuestions[0];
  expect(sub.originalLabel).toBe("(1)");
  expect(sub.prompt[0]).toMatchObject({ type: "paragraph", runs: [{ type: "text", text: "求 " }, { type: "formula", latex: "x" }, { type: "text", text: " 的值。", style: "普通" }] });
  expect(sub.options.map((option) => option.label)).toEqual(["A", "B"]);
  expect(sub.answers).toHaveLength(1);
  expect(sub.answers[0].slotId).toBeNull();
  expect(hasContent(sub.answers[0].blocks)).toBe(true);
  expect(sub.scoring.map((point) => point.score)).toEqual([2, 3]);
  expect(sub.originalScore).toBe(5);
  expect(value.source).toEqual({ section: "数学部分", pdfPage: 2, originalNumber: "17" });
  expect(value.selection).toEqual({ mode: "all" });
});

test("内容回填表单后再生成，保持题干、图、表、答案与评分", () => {
  const content: QuestionContent = {
    stem: [{ type: "paragraph", runs: [{ type: "text", text: "观察下表。", style: "普通" }] }],
    subQuestions: [{
      id: "sub-a",
      originalLabel: "(1)",
      prompt: [
        { type: "paragraph", runs: [{ type: "text", text: "图中阴影面积是 ", style: "普通" }, { type: "formula", latex: "\\pi r^2" }, { type: "text", text: " 吗？", style: "普通" }] },
        { type: "image", id: "a".repeat(64), alt: "原卷裁图" },
        { type: "table", rows: [["项目", "数值"], ["半径", "2"]] },
      ],
      explanation: [{ type: "formula", latex: "S=\\pi r^2" }],
      options: [{ label: "A", content: [{ type: "paragraph", runs: [{ type: "text", text: "是", style: "普通" }] }] }],
      slots: [],
      answers: [{ slotId: null, blocks: [{ type: "paragraph", runs: [{ type: "text", text: "是", style: "普通" }] }], variants: [] }],
      scoring: [{ id: "score-1", description: "判断正确", score: 2, slotIds: [] }],
      originalScore: 4,
      materialIds: ["material-a"],
      dependsOn: [],
    }],
    materials: [{ materialId: "material-a", versionId: "material-version-a" }],
    selection: { mode: "all" },
    source: { section: "数学", pdfPage: 3, originalNumber: "18" },
  };
  const roundtrip = contentToForm(content, classification, [{ materialId: "material-a", versionId: "material-version-a", title: "材料甲", status: "approved" }]);
  expect(roundtrip.problem).toBeUndefined();
  expect(roundtrip.form).toBeDefined();
  const again = buildContent(roundtrip.form!);
  expect(again.problems).toEqual([]);
  const value = again.content as QuestionContent;
  expect(value.stem).toEqual(content.stem);
  expect(value.subQuestions[0].id).toBe("sub-a");
  expect(value.subQuestions[0].prompt[0]).toEqual(content.subQuestions[0].prompt[0]);
  expect(value.subQuestions[0].prompt[1]).toEqual(content.subQuestions[0].prompt[1]);
  expect(value.subQuestions[0].prompt[2]).toEqual(content.subQuestions[0].prompt[2]);
  expect(value.subQuestions[0].explanation).toEqual(content.subQuestions[0].explanation);
  expect(value.subQuestions[0].answers).toEqual(content.subQuestions[0].answers);
  expect(value.subQuestions[0].scoring[0]).toMatchObject({ description: "判断正确", score: 2 });
  expect(value.subQuestions[0].materialIds).toEqual(["material-a"]);
  expect(value.materials).toEqual(content.materials);
  expect(value.source).toEqual(content.source);
});

test("文字块样式写入题目片段；接续块合并回同一段落", () => {
  const value = form();
  value.stem = [
    { kind: "text", text: "粗体提示：", style: "粗体" },
    { kind: "text", text: "x", style: "上标", continuesPrevious: true },
    { kind: "text", text: " 为普通文字。", continuesPrevious: true },
  ];
  const built = buildContent(value);
  expect(built.problems).toEqual([]);
  expect(built.content?.stem).toEqual([{ type: "paragraph", runs: [
    { type: "text", text: "粗体提示：", style: "粗体" },
    { type: "text", text: "x", style: "上标" },
    { type: "text", text: " 为普通文字。", style: "普通" },
  ] }]);
});

test("回填含样式题目时保留文字样式、段落分组与选项样式", () => {
  const styled: QuestionContent = {
    stem: [{ type: "paragraph", runs: [
      { type: "text", text: "注意：", style: "粗体" },
      { type: "text", text: "x", style: "上标" },
      { type: "text", text: " 表示平方。", style: "普通" },
    ] }],
    subQuestions: [{
      id: "sub-a",
      originalLabel: "(1)",
      prompt: [{ type: "paragraph", runs: [{ type: "text", text: "选择正确项。", style: "斜体" }] }],
      explanation: [],
      options: [
        { label: "A", content: [{ type: "paragraph", runs: [{ type: "text", text: "甲", style: "下划线" }] }] },
        { label: "B", content: [{ type: "paragraph", runs: [{ type: "text", text: "乙", style: "普通" }] }] },
      ],
      slots: [],
      answers: [],
      scoring: [],
      originalScore: null,
      materialIds: [],
      dependsOn: [],
    }],
    materials: [],
    selection: { mode: "all" },
    source: { section: "全卷", pdfPage: 1, originalNumber: "1" },
  };
  const roundtrip = contentToForm(styled, classification);
  expect(roundtrip.problem).toBeUndefined();
  const value = roundtrip.form!;
  expect(value.stem).toEqual([
    { kind: "text", text: "注意：", style: "粗体" },
    { kind: "text", text: "x", style: "上标", continuesPrevious: true },
    { kind: "text", text: " 表示平方。", continuesPrevious: true },
  ]);
  expect(value.subQuestions[0].prompt).toEqual([{ kind: "text", text: "选择正确项。", style: "斜体" }]);
  expect(value.subQuestions[0].optionStyles).toEqual(["下划线", "普通"]);
  const again = buildContent(value);
  expect(again.problems).toEqual([]);
  expect(again.content?.stem).toEqual(styled.stem);
  expect(again.content?.subQuestions[0].prompt).toEqual(styled.subQuestions[0].prompt);
  expect(again.content?.subQuestions[0].options).toEqual(styled.subQuestions[0].options);
});

test("无效文字样式被拒绝，不静默当作普通文字保存", () => {
  const value = form();
  value.stem = [{ kind: "text", text: "文字", style: "花体" as never }];
  expect(buildContent(value).problems.join("；")).toContain("样式");
});


test("小问号查重忽略全半角括号与空白，空号不参与", () => {
  expect(duplicateSubLabels(["(1)", "（1）", "(2)", "", "3", "（3）"])).toEqual(["(1)", "3"]);
  expect(duplicateSubLabels(["(1)", "(2)", "(3)"])).toEqual([]);
});

test("空题干、坏页码、未配对公式与悬空依赖给出可读提示", () => {
  const empty = newIntakeForm(classification, "全卷");
  empty.stem = [];
  empty.subQuestions[0].prompt = [];
  const emptyResult = buildContent(empty);
  expect(emptyResult.content).toBeNull();
  expect(emptyResult.problems.join("；")).toContain("题干");

  const page = form();
  page.source.pdfPage = "0";
  expect(buildContent(page).problems.join("；")).toContain("页码");

  const formula = form();
  formula.subQuestions[0].prompt = [{ kind: "text", text: "求 $x 的值。" }];
  expect(buildContent(formula).problems.join("；")).toContain("公式");

  const dependency = form();
  dependency.subQuestions[0].dependsOn = ["missing-sub"];
  expect(buildContent(dependency).problems.join("；")).toContain("依赖");

  const score = form();
  score.subQuestions[0].scoring = [{ description: "列式", score: "", slotIds: [] }];
  expect(buildContent(score).problems.join("；")).toContain("评分");
});

/** 两个小问的完整表单，第 (2) 问依赖第 (1) 问。 */
function chainedForm() {
  const value = form();
  const second = blankSubQuestion();
  second.key = "second-key";
  second.id = "second-id";
  second.originalLabel = "(2)";
  second.prompt = [{ kind: "text", text: "第二问。" }];
  second.answer = [{ kind: "text", text: "5" }];
  second.dependsOn = [value.subQuestions[0].id];
  value.subQuestions.push(second);
  return value;
}

test("上移与下移改变小问顺序，不改小问号与依赖", () => {
  const value = chainedForm();
  const movedUp = moveSubQuestion(value, "second-key", "up");
  expect(movedUp.subQuestions.map((sub) => sub.key)).toEqual(["second-key", value.subQuestions[0].key]);
  expect(movedUp.subQuestions[0].originalLabel).toBe("(2)");
  expect(movedUp.subQuestions[0].dependsOn).toEqual([value.subQuestions[0].id]);
  expect(value.subQuestions.map((sub) => sub.key)).toEqual([value.subQuestions[0].key, "second-key"]);

  const movedBack = moveSubQuestion(movedUp, "second-key", "down");
  expect(movedBack.subQuestions.map((sub) => sub.key)).toEqual([value.subQuestions[0].key, "second-key"]);
  expect(moveSubQuestion(value, value.subQuestions[0].key, "up")).toBe(value);
  expect(moveSubQuestion(value, "second-key", "down")).toBe(value);
});

test("依赖排在被依赖小问之后时给出顺序提示且保存被拒", () => {
  const value = chainedForm();
  expect(dependencyOrderProblems(value)).toEqual([]);
  expect(buildContent(value).content).not.toBeNull();

  const moved = moveSubQuestion(value, "second-key", "up");
  expect(dependencyOrderProblems(moved)).toEqual([{ subQuestionId: "second-id", later: ["(1)"], missing: [] }]);
  const result = buildContent(moved);
  expect(result.content).toBeNull();
  expect(result.problems.join("；")).toContain("第 (2) 小问依赖的小问不存在或不在前面");

  moved.subQuestions[0].dependsOn = ["missing-id"];
  expect(dependencyOrderProblems(moved)).toEqual([{ subQuestionId: "second-id", later: [], missing: ["missing-id"] }]);
});

test("题干与小问引用可回填编辑；选项引用与答案变体仍拒绝", () => {
  const referenced: QuestionContent = {
    stem: [{ type: "paragraph", runs: [{ type: "reference", kind: "material", targetId: "material-a", fallback: "材料甲" }] }],
    subQuestions: [{ id: "sub-a", originalLabel: "(1)", prompt: [], explanation: [], options: [], slots: [], answers: [], scoring: [], originalScore: null, materialIds: [], dependsOn: [] }],
    materials: [{ materialId: "material-a", versionId: "material-version-a" }],
    selection: { mode: "all" },
    source: { section: "全卷", pdfPage: 1, originalNumber: "1" },
  };
  const editable = contentToForm(referenced, classification);
  expect(editable.problem).toBeUndefined();
  expect(editable.form!.stem).toEqual([{ kind: "reference", refKind: "material", targetId: "material-a", fallback: "材料甲" }]);

  const optionReference = structuredClone(referenced);
  optionReference.subQuestions[0].options = [{ label: "A", content: [{ type: "paragraph", runs: [{ type: "reference", kind: "material", targetId: "material-a", fallback: "材料甲" }] }] }];
  expect(contentToForm(optionReference, classification).problem).toContain("选项");

  const variant = structuredClone(referenced);
  variant.subQuestions[0].answers = [{ slotId: null, blocks: [], variants: ["另一种写法"] }];
  expect(contentToForm(variant, classification).problem).toContain("答案变体");
});

test("小问、材料与图引用及图标识在表单和题目内容间往返保持", () => {
  const content: QuestionContent = {
    stem: [{ type: "paragraph", runs: [
      { type: "text", text: "提示：", style: "普通" },
      { type: "reference", kind: "material", targetId: "material-a", fallback: "材料甲" },
      { type: "text", text: "。", style: "普通" },
    ] }],
    subQuestions: [
      {
        id: "sub-a",
        originalLabel: "(1)",
        prompt: [
          { type: "image", id: "a".repeat(64), alt: "示意图", figureId: "fig-a" },
          { type: "paragraph", runs: [
            { type: "text", text: "结合", style: "普通" },
            { type: "reference", kind: "subQuestion", targetId: "sub-b", fallback: "下一问" },
            { type: "text", text: "作答。", style: "普通" },
          ] },
        ],
        explanation: [],
        options: [],
        slots: [],
        answers: [{ slotId: null, blocks: [{ type: "paragraph", runs: [{ type: "reference", kind: "figure", targetId: "fig-a", fallback: "旧图" }] }], variants: [] }],
        scoring: [],
        originalScore: null,
        materialIds: ["material-a"],
        dependsOn: [],
      },
      {
        id: "sub-b",
        originalLabel: "(2)",
        prompt: [],
        explanation: [],
        options: [],
        slots: [],
        answers: [],
        scoring: [],
        originalScore: null,
        materialIds: [],
        dependsOn: [],
      },
    ],
    materials: [{ materialId: "material-a", versionId: "material-version-a" }],
    selection: { mode: "all" },
    source: { section: "全卷", pdfPage: 1, originalNumber: "1" },
  };
  const roundtrip = contentToForm(content, classification);
  expect(roundtrip.problem).toBeUndefined();
  const form = roundtrip.form!;
  expect(form.stem).toEqual([
    { kind: "text", text: "提示：" },
    { kind: "reference", refKind: "material", targetId: "material-a", fallback: "材料甲" },
    { kind: "text", text: "。" },
  ]);
  expect(form.subQuestions[0].prompt[0]).toEqual({ kind: "image", id: "a".repeat(64), alt: "示意图", figureId: "fig-a" });
  expect(form.subQuestions[0].prompt[1]).toEqual({ kind: "text", text: "结合" });
  expect(form.subQuestions[0].prompt[2]).toEqual({ kind: "reference", refKind: "subQuestion", targetId: "sub-b", fallback: "下一问" });
  expect(form.subQuestions[0].answer).toEqual([{ kind: "reference", refKind: "figure", targetId: "fig-a", fallback: "旧图" }]);

  const again = buildContent(form);
  expect(again.problems).toEqual([]);
  const built = again.content as QuestionContent;
  expect(isQuestionContent(built)).toBe(true);
  expect(built.subQuestions[0].prompt[0]).toEqual({ type: "image", id: "a".repeat(64), alt: "示意图", figureId: "fig-a" });
  expect(built.subQuestions[0].prompt[2]).toEqual({ type: "paragraph", runs: [
    { type: "reference", kind: "subQuestion", targetId: "sub-b", fallback: "下一问" },
  ] });
  expect(built.subQuestions[0].answers[0].blocks).toEqual([{ type: "paragraph", runs: [{ type: "reference", kind: "figure", targetId: "fig-a", fallback: "旧图" }] }]);
  expect(built.stem).toContainEqual({ type: "paragraph", runs: [{ type: "reference", kind: "material", targetId: "material-a", fallback: "材料甲" }] });
});

test("引用目标缺失、类型无效、回退文字为空与图标识重复被拒绝", () => {
  const missingSub = newIntakeForm(classification, "全卷");
  missingSub.subQuestions[0].prompt = [{ kind: "reference", refKind: "subQuestion", targetId: "missing", fallback: "上一问" }];
  expect(buildContent(missingSub).problems.join("；")).toContain("引用了不存在的小问");

  const missingMaterial = newIntakeForm(classification, "全卷");
  missingMaterial.subQuestions[0].prompt = [{ kind: "reference", refKind: "material", targetId: "material-a", fallback: "材料甲" }];
  expect(buildContent(missingMaterial).problems.join("；")).toContain("引用了不在本题材料列表中的材料");

  const missingFigure = newIntakeForm(classification, "全卷");
  missingFigure.subQuestions[0].prompt = [{ kind: "reference", refKind: "figure", targetId: "fig-a", fallback: "图 1" }];
  expect(buildContent(missingFigure).problems.join("；")).toContain("引用了不存在的图");

  const badKind = newIntakeForm(classification, "全卷");
  badKind.subQuestions[0].prompt = [{ kind: "reference", refKind: "unknown" as never, targetId: "sub-a", fallback: "引用" }];
  expect(buildContent(badKind).problems.join("；")).toContain("引用类型无效");

  const emptyFallback = newIntakeForm(classification, "全卷");
  emptyFallback.subQuestions[0].prompt = [{ kind: "reference", refKind: "subQuestion", targetId: emptyFallback.subQuestions[0].id, fallback: " " }];
  expect(buildContent(emptyFallback).problems.join("；")).toContain("引用缺少回退文字");

  const duplicateFigure = newIntakeForm(classification, "全卷");
  duplicateFigure.subQuestions[0].prompt = [
    { kind: "image", id: "a".repeat(64), alt: "图一", figureId: "fig-a" },
    { kind: "image", id: "b".repeat(64), alt: "图二", figureId: "fig-a" },
  ];
  expect(buildContent(duplicateFigure).problems.join("；")).toContain("图标识重复");
});

test("两个可互换作答位置、空位答案与评分点关联在表单和题目内容间往返保持", () => {
  const value = form();
  value.subQuestions[0].answer = [];
  value.subQuestions[0].slots = [
    { id: "slot-a", label: "第一空", kind: "text", required: true, interchangeableWith: ["slot-b"] },
    { id: "slot-b", label: "第二空", kind: "blank", required: false, interchangeableWith: ["slot-a"] },
  ];
  value.subQuestions[0].slotAnswers = [
    { slotId: "slot-a", blocks: [{ kind: "text", text: "4" }] },
    { slotId: "slot-b", blocks: [{ kind: "text", text: "x=2" }] },
  ];
  value.subQuestions[0].scoring = [{ description: "两空正确", score: "5", slotIds: ["slot-a", "slot-b"] }];

  const built = buildContent(value);
  expect(built.problems).toEqual([]);
  const content = built.content as QuestionContent;
  expect(isQuestionContent(content)).toBe(true);
  expect(content.subQuestions[0].slots).toEqual([
    { id: "slot-a", label: "第一空", kind: "text", required: true, interchangeableWith: ["slot-b"] },
    { id: "slot-b", label: "第二空", kind: "blank", required: false, interchangeableWith: ["slot-a"] },
  ]);
  expect(content.subQuestions[0].answers.map((answer) => answer.slotId)).toEqual(["slot-a", "slot-b"]);
  expect(content.subQuestions[0].scoring[0].slotIds).toEqual(["slot-a", "slot-b"]);

  const roundtrip = contentToForm(content, classification);
  expect(roundtrip.problem).toBeUndefined();
  const restored = roundtrip.form!.subQuestions[0];
  expect(restored.slots).toEqual(content.subQuestions[0].slots);
  expect(restored.slotAnswers).toEqual([
    { slotId: "slot-a", blocks: [{ kind: "text", text: "4" }] },
    { slotId: "slot-b", blocks: [{ kind: "text", text: "x=2" }] },
  ]);
  expect(restored.scoring[0].slotIds).toEqual(["slot-a", "slot-b"]);

  const again = buildContent(roundtrip.form!);
  expect(again.problems).toEqual([]);
  expect(again.content!.subQuestions[0].slots).toEqual(content.subQuestions[0].slots);
  expect(again.content!.subQuestions[0].answers).toEqual(content.subQuestions[0].answers);
  expect(again.content!.subQuestions[0].scoring[0].slotIds).toEqual(["slot-a", "slot-b"]);
});

test("作答位置标签为空、标识重复、互换不互指、答案或评分点指向不存在的空时给出提示", () => {
  const noLabel = form();
  noLabel.subQuestions[0].slots = [{ id: "slot-a", label: " ", kind: "text", required: true, interchangeableWith: [] }];
  expect(buildContent(noLabel).problems.join("；")).toContain("作答位置缺少标签");

  const duplicate = form();
  duplicate.subQuestions[0].slots = [
    { id: "slot-a", label: "第一空", kind: "text", required: true, interchangeableWith: [] },
    { id: "slot-a", label: "第二空", kind: "text", required: true, interchangeableWith: [] },
  ];
  expect(buildContent(duplicate).problems.join("；")).toContain("作答位置标识重复");

  const oneWay = form();
  oneWay.subQuestions[0].slots = [
    { id: "slot-a", label: "第一空", kind: "text", required: true, interchangeableWith: ["slot-b"] },
    { id: "slot-b", label: "第二空", kind: "text", required: true, interchangeableWith: [] },
  ];
  expect(buildContent(oneWay).problems.join("；")).toContain("互换关系必须互为引用");

  const danglingAnswer = form();
  danglingAnswer.subQuestions[0].slots = [{ id: "slot-a", label: "第一空", kind: "text", required: true, interchangeableWith: [] }];
  danglingAnswer.subQuestions[0].slotAnswers = [{ slotId: "slot-b", blocks: [{ kind: "text", text: "4" }] }];
  expect(buildContent(danglingAnswer).problems.join("；")).toContain("答案引用了不存在的作答位置");

  const danglingScoring = form();
  danglingScoring.subQuestions[0].slots = [{ id: "slot-a", label: "第一空", kind: "text", required: true, interchangeableWith: [] }];
  danglingScoring.subQuestions[0].scoring = [{ description: "两空正确", score: "5", slotIds: ["slot-b"] }];
  expect(buildContent(danglingScoring).problems.join("；")).toContain("评分点引用了不存在的作答位置");
});
