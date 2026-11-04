import { expect, test } from "vitest";
import { buildContent, contentToForm, newIntakeForm } from "../../../src/shared/intake";
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

test("含引用或答案变体的题目拒绝在录题工作台编辑，避免静默丢失", () => {
  const referenced: QuestionContent = {
    stem: [{ type: "paragraph", runs: [{ type: "reference", kind: "material", targetId: "material-a", fallback: "材料甲" }] }],
    subQuestions: [{ id: "sub-a", originalLabel: "(1)", prompt: [], explanation: [], options: [], slots: [], answers: [], scoring: [], originalScore: null, materialIds: [], dependsOn: [] }],
    materials: [{ materialId: "material-a", versionId: "material-version-a" }],
    selection: { mode: "all" },
    source: { section: "全卷", pdfPage: 1, originalNumber: "1" },
  };
  expect(contentToForm(referenced, classification).problem).toContain("引用");
  const variant = structuredClone(referenced);
  variant.stem = [];
  variant.materials = [];
  variant.subQuestions[0].answers = [{ slotId: null, blocks: [], variants: ["另一种写法"] }];
  expect(contentToForm(variant, classification).problem).toContain("答案变体");
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
