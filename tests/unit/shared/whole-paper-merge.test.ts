import { expect, test } from "vitest";
import type { AiQuestion } from "../../../src/shared/ai";
import { mergeWholePaperQuestions } from "../../../src/shared/whole-paper-merge";

const base = (number: string, page: number, extra: Partial<AiQuestion> = {}): AiQuestion => ({
  stem: `第 ${number} 题`, subquestions: [], options: [], tags: [], uncertain: [], page, originalNumber: number, ...extra,
});
const part = (label: string, prompt: string, extra: Partial<NonNullable<AiQuestion["parts"]>[number]> = {}) => ({
  label, prompt, options: [], answer: "", explanation: "", score: null, uncertain: [], ...extra,
});

test("相邻批次的同题号合并为一条，保留全部锚点与小问", () => {
  const first = base("5", 1, {
    parts: [part("(1)", "第一问", { answer: "A", score: 2 })],
    sourceAnchors: [{ page: 1, start: 10, end: 40 }],
  });
  const second = base("5", 2, {
    stem: "第 5 题（续）",
    parts: [part("(2)", "第二问", { answer: "B", score: 3 })],
    sourceAnchors: [{ page: 2, start: 0, end: 20 }],
  });
  const groups = mergeWholePaperQuestions([
    { batchIndex: 0, questionIndex: 3, question: first },
    { batchIndex: 1, questionIndex: 0, question: second },
  ]);
  expect(groups).toHaveLength(1);
  expect(groups[0].members.map((member) => `${member.batchIndex}:${member.questionIndex}`)).toEqual(["0:3", "1:0"]);
  expect(groups[0].question.sourceAnchors).toEqual([{ page: 1, start: 10, end: 40 }, { page: 2, start: 0, end: 20 }]);
  expect(groups[0].question.parts?.map((entry) => entry.label)).toEqual(["(1)", "(2)"]);
  expect(groups[0].question.parts?.map((entry) => entry.answer)).toEqual(["A", "B"]);
});

test("同小问跨批补齐答案、分值与较长题干", () => {
  const first = base("6", 1, { parts: [part("(1)", "求值。", { score: null })], sourceAnchors: [{ page: 1, start: 0, end: 6 }] });
  const second = base("6", 2, { parts: [part("(1)", "求值并说明理由。", { answer: "4", score: 5 })], sourceAnchors: [{ page: 2, start: 0, end: 8 }] });
  const [group] = mergeWholePaperQuestions([
    { batchIndex: 0, questionIndex: 0, question: first },
    { batchIndex: 1, questionIndex: 0, question: second },
  ]);
  expect(group.question.parts).toHaveLength(1);
  expect(group.question.parts?.[0]).toMatchObject({ prompt: "求值并说明理由。", answer: "4", score: 5 });
});

test("非相邻批次或不同题号不合并", () => {
  const groups = mergeWholePaperQuestions([
    { batchIndex: 0, questionIndex: 0, question: base("7", 1) },
    { batchIndex: 1, questionIndex: 0, question: base("8", 2) },
    { batchIndex: 2, questionIndex: 0, question: base("7", 3) },
  ]);
  expect(groups).toHaveLength(3);
  expect(groups.map((group) => group.question.originalNumber)).toEqual(["7", "8", "7"]);
});
