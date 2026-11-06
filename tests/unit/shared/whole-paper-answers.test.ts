import { expect, test } from "vitest";
import { matchWholePaperAnswers, normalizeWholePaperAnswerLabel } from "../../../src/shared/whole-paper-answers";

const target = (key: string, originalNumber: string, labels: string[], filled: boolean[] = labels.map(() => false)) => ({ key, originalNumber, labels, filled });
const entry = (key: string, originalNumber: string, label: string, answer = "4") => ({ key, originalNumber, label, answer, page: 1 });

test("小问号规范化：全角括号与空白不影响唯一匹配", () => {
  expect(normalizeWholePaperAnswerLabel(" （ 1 ） ")).toBe("(1)");
  const result = matchWholePaperAnswers([entry("0:0", "1", "（1）")], [target("t1", "1", ["(1)"])]);
  expect(result.summary).toEqual({ total: 1, matched: 1, ambiguous: 0, unmatched: 0 });
  expect(result.fills).toEqual([{ targetKey: "t1", index: 0, entryKey: "0:0", answer: "4" }]);
  expect(result.matchedKeys).toEqual(["0:0"]);
});

test("整题答案 label 为空时匹配唯一小问", () => {
  const result = matchWholePaperAnswers([entry("0:0", "1", "")], [target("t1", "1", ["(1)"])]);
  expect(result.summary.matched).toBe(1);
  expect(result.fills).toHaveLength(1);
});

test("整题答案面对多个小问时记为歧义，不填入", () => {
  const result = matchWholePaperAnswers([entry("0:0", "1", "")], [target("t1", "1", ["(1)", "(2)"])]);
  expect(result.summary).toEqual({ total: 1, matched: 0, ambiguous: 1, unmatched: 0 });
  expect(result.fills).toEqual([]);
  expect(result.issues).toEqual([{ targetKey: "t1", code: "answer_ambiguous", message: expect.any(String) }]);
});

test("同一小问有多条答案时全部记为歧义，不填入", () => {
  const result = matchWholePaperAnswers([entry("0:0", "1", "(1)", "A"), entry("0:1", "1", "(1)", "B")], [target("t1", "1", ["(1)"])]);
  expect(result.summary).toEqual({ total: 2, matched: 0, ambiguous: 2, unmatched: 0 });
  expect(result.fills).toEqual([]);
  expect(result.ambiguousKeys).toEqual(["0:0", "0:1"]);
});

test("同一条答案命中两道同号题时两题都记为歧义", () => {
  const result = matchWholePaperAnswers([entry("0:0", "1", "(1)")], [target("t1", "1", ["(1)"]), target("t2", "1", ["(1)"])]);
  expect(result.summary.ambiguous).toBe(1);
  expect(result.fills).toEqual([]);
  expect(result.issues.map((issue) => issue.targetKey).sort()).toEqual(["t1", "t2"]);
});

test("题号不存在时答案记为未匹配且不产生题目异常", () => {
  const result = matchWholePaperAnswers([entry("0:0", "99", "(1)")], [target("t1", "1", ["(1)"])]);
  expect(result.summary).toEqual({ total: 1, matched: 0, ambiguous: 0, unmatched: 1 });
  expect(result.unmatchedKeys).toEqual(["0:0"]);
  expect(result.issues).toEqual([]);
});

test("题号存在但小问号对不上时在对应题上记未匹配", () => {
  const result = matchWholePaperAnswers([entry("0:0", "1", "(3)")], [target("t1", "1", ["(1)"])]);
  expect(result.summary.unmatched).toBe(1);
  expect(result.issues).toEqual([{ targetKey: "t1", code: "answer_unmatched", message: expect.any(String) }]);
});

test("已有答案的小问不被覆盖，但答案仍计为匹配", () => {
  const result = matchWholePaperAnswers([entry("0:0", "1", "(1)")], [target("t1", "1", ["(1)"], [true])]);
  expect(result.summary.matched).toBe(1);
  expect(result.fills).toEqual([]);
});
