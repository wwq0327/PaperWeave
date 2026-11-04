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
    { description: "列式正确", score: "2" },
    { description: "求得结果", score: "3" },
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
  score.subQuestions[0].scoring = [{ description: "列式", score: "" }];
  expect(buildContent(score).problems.join("；")).toContain("评分");
});

test("含引用或作答位置的题目拒绝在录题工作台编辑，避免静默丢失", () => {
  const referenced: QuestionContent = {
    stem: [{ type: "paragraph", runs: [{ type: "reference", kind: "material", targetId: "material-a", fallback: "材料甲" }] }],
    subQuestions: [{ id: "sub-a", originalLabel: "(1)", prompt: [], explanation: [], options: [], slots: [], answers: [], scoring: [], originalScore: null, materialIds: [], dependsOn: [] }],
    materials: [{ materialId: "material-a", versionId: "material-version-a" }],
    selection: { mode: "all" },
    source: { section: "全卷", pdfPage: 1, originalNumber: "1" },
  };
  expect(contentToForm(referenced, classification).problem).toContain("引用");
  const slotted = structuredClone(referenced);
  slotted.stem = [];
  slotted.materials = [];
  slotted.subQuestions[0].slots = [{ id: "slot-a", label: "答案", kind: "text", required: true, interchangeableWith: [] }];
  expect(contentToForm(slotted, classification).problem).toContain("作答位置");
});
