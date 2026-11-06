import { expect, test } from "vitest";
import { aiQuestionToIntake } from "../../../src/shared/ai-intake";
import type { AiQuestion } from "../../../src/shared/ai";
import type { Classification } from "../../../src/shared/question";

const classification: Classification = {
  stage: "初中",
  subject: "数学",
  grade: "九年级",
  examType: "单元测",
  year: "2026",
  sourceName: "自制样题",
  questionType: "",
  knowledgePoints: ["原有知识点"],
};

function structured(): AiQuestion {
  return {
    stem: "阅读材料，完成各题。",
    subquestions: ["(1) 求值。", "(2) 说明理由。"],
    options: ["甲", "乙"],
    tags: ["函数"],
    uncertain: ["整体待核"],
    page: 3,
    originalNumber: "19",
    parts: [
      { label: "(1)", prompt: "求 $x^2$ 的值。", options: ["甲", "乙"], answer: "4", explanation: "代入计算。", score: 4, uncertain: ["公式待核"] },
      { label: "(2)", prompt: "说明理由。", options: [], answer: "因为……", explanation: "", score: 6, uncertain: [] },
    ],
    materials: [{ title: "材料一", content: "材料正文", source: "自制" }],
    questionType: "解答题",
    knowledgePoints: ["一元二次方程"],
  };
}

test("结构化 AI 题映射为录题表单：小问、选项、答案、原分值与来源", () => {
  const result = aiQuestionToIntake(structured(), classification, "数学·解答题");
  expect(result.form.classification.knowledgePoints).toEqual(["原有知识点"]);
  expect(result.newTags).toEqual(["函数", "一元二次方程"]);
  expect(result.form.classification.questionType).toBe("解答题");
  expect(result.form.source).toEqual({ section: "数学·解答题", pdfPage: "3", originalNumber: "19" });
  expect(result.form.subQuestions).toHaveLength(2);
  expect(result.form.subQuestions[0]).toMatchObject({
    originalLabel: "(1)",
    prompt: [{ kind: "text", text: "求 $x^2$ 的值。" }],
    answer: [{ kind: "text", text: "4" }],
    explanation: [{ kind: "text", text: "代入计算。" }],
    originalScore: "4",
  });
  expect(result.form.subQuestions[0].options.map((option) => option.blocks)).toEqual([
    [{ kind: "text", text: "甲" }],
    [{ kind: "text", text: "乙" }],
  ]);
  expect(result.form.subQuestions[1].originalScore).toBe("6");
  expect(result.uncertain).toEqual(["整体待核", "第(1)小问：公式待核", "作答位置需手工录入：AI 不生成空位，请在表单中补录。"]);
  expect(result.materials).toEqual([{ title: "材料一", content: "材料正文", source: "自制" }]);
});

test("候选标签并入知识点，候选外标签只作建议等待教师确认", () => {
  const inside = aiQuestionToIntake(structured(), classification, "数学·解答题", ["函数", "一元二次方程"]);
  expect(inside.form.classification.knowledgePoints).toEqual(["原有知识点", "函数", "一元二次方程"]);
  expect(inside.newTags).toEqual([]);

  const outside = aiQuestionToIntake(structured(), classification, "数学·解答题", ["函数"]);
  expect(outside.form.classification.knowledgePoints).toEqual(["原有知识点", "函数"]);
  expect(outside.newTags).toEqual(["一元二次方程"]);
  expect(outside.uncertain).toContain("作答位置需手工录入：AI 不生成空位，请在表单中补录。");
});

test("旧格式没有 parts 时按小问文字降级，选项归入第一小问", () => {
  const legacy: AiQuestion = {
    stem: "题干",
    subquestions: ["(1) 小问一", "(2) 小问二"],
    options: ["甲", "乙"],
    tags: [],
    uncertain: [],
    page: 2,
    answer: "参考答案",
  };
  const result = aiQuestionToIntake(legacy, classification, "数学·解答题");
  expect(result.form.stem).toEqual([{ kind: "text", text: "题干" }]);
  expect(result.form.subQuestions.map((sub) => sub.prompt)).toEqual([
    [{ kind: "text", text: "(1) 小问一" }],
    [{ kind: "text", text: "(2) 小问二" }],
  ]);
  expect(result.form.subQuestions[0].options.map((option) => option.blocks)).toEqual([
    [{ kind: "text", text: "甲" }],
    [{ kind: "text", text: "乙" }],
  ]);
  expect(result.form.subQuestions[0].originalScore).toBe("");
  expect(result.uncertain).toEqual(["整题答案未能对应到具体小问，请核对。", "作答位置需手工录入：AI 不生成空位，请在表单中补录。"]);
});

test("只有题干没有小问时作为单小问录入，避免空题干", () => {
  const result = aiQuestionToIntake({ stem: "单独一题。", subquestions: [], options: [], tags: [], uncertain: [], page: 1 }, classification, "数学");
  expect(result.form.stem).toEqual([]);
  expect(result.form.subQuestions).toHaveLength(1);
  expect(result.form.subQuestions[0].prompt).toEqual([{ kind: "text", text: "单独一题。" }]);
  expect(result.form.source.originalNumber).toBe("");
});

test("顶层答案在单小问题中保留；旧格式与结构化题无法对应时标待核", () => {
  const single = aiQuestionToIntake({ stem: "单独一题。", subquestions: [], options: [], tags: [], uncertain: [], page: 1, answer: "参考答案" }, classification, "数学");
  expect(single.form.subQuestions[0].answer).toEqual([{ kind: "text", text: "参考答案" }]);

  const legacy: AiQuestion = { stem: "题干", subquestions: ["(1) 小问一"], options: [], tags: [], uncertain: [], page: 2, answer: "参考答案" };
  expect(aiQuestionToIntake(legacy, classification, "数学").uncertain).toContain("整题答案未能对应到具体小问，请核对。");

  const both = structured();
  both.answer = "整题答案";
  expect(aiQuestionToIntake(both, classification, "数学").uncertain).toContain("模型同时返回整题答案和小问答案，请核对。");
});

test("材料建议保留 appliesTo 小问归属", () => {
  const question = structured();
  question.materials = [{ title: "材料一", content: "材料正文", source: "自制", appliesTo: ["(1)"] }];
  expect(aiQuestionToIntake(question, classification, "数学").materials).toEqual([{ title: "材料一", content: "材料正文", source: "自制", appliesTo: ["(1)"] }]);
});
