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
  expect(result.form.classification.knowledgePoints).toEqual(["原有知识点", "函数", "一元二次方程"]);
  expect(result.form.classification.questionType).toBe("解答题");
  expect(result.form.source).toEqual({ section: "数学·解答题", pdfPage: "3", originalNumber: "19" });
  expect(result.form.subQuestions).toHaveLength(2);
  expect(result.form.subQuestions[0]).toMatchObject({
    originalLabel: "(1)",
    prompt: [{ kind: "text", text: "求 $x^2$ 的值。" }],
    options: "甲\n乙",
    answer: [{ kind: "text", text: "4" }],
    explanation: [{ kind: "text", text: "代入计算。" }],
    originalScore: "4",
  });
  expect(result.form.subQuestions[1].originalScore).toBe("6");
  expect(result.uncertain).toEqual(["整体待核", "第(1)小问：公式待核"]);
  expect(result.materials).toEqual([{ title: "材料一", content: "材料正文", source: "自制" }]);
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
  expect(result.form.subQuestions[0].options).toBe("甲\n乙");
  expect(result.form.subQuestions[0].originalScore).toBe("");
  expect(result.uncertain).toEqual([]);
});

test("只有题干没有小问时作为单小问录入，避免空题干", () => {
  const result = aiQuestionToIntake({ stem: "单独一题。", subquestions: [], options: [], tags: [], uncertain: [], page: 1 }, classification, "数学");
  expect(result.form.stem).toEqual([]);
  expect(result.form.subQuestions).toHaveLength(1);
  expect(result.form.subQuestions[0].prompt).toEqual([{ kind: "text", text: "单独一题。" }]);
  expect(result.form.source.originalNumber).toBe("");
});
