import { expect, test } from "vitest";
import { paperDefaultScore, paperScoringState, scoreConflicts, type PaperScoring } from "../../../src/shared/paper";
import { exercise, math, paragraph } from "../fixtures/questions";

const points = (score: number) => [{ id: "p1", description: "要点", score, slotIds: [] }];

test("整题默认分值取组选答后的 selectionScore", () => {
  expect(paperDefaultScore(exercise(), ["task-a", "task-b"]).score).toBe(30);
  expect(paperDefaultScore(math(), ["part-1", "part-2"]).score).toBe(10);
});

test("小问集合默认分值取原分值合计，缺失时要求补填", () => {
  expect(paperDefaultScore(math(), ["part-2"]).score).toBe(6);
  const missing = math();
  missing.subQuestions[1].originalScore = null;
  expect(paperDefaultScore(missing, ["part-2"])).toEqual({ score: 0, conflict: "原分值缺失，请补填" });
  expect(paperDefaultScore(math(), ["missing"])).toEqual({ score: 0, conflict: "小问不存在" });
});

test("评分状态由卷内分值与评分数据推导", () => {
  const original: PaperScoring = { mode: "original" };
  expect(paperScoringState(6, 6, original)).toBe("original");
  expect(paperScoringState(4, 6, original)).toBe("needsAdjustment");
  expect(paperScoringState(4, 6, { mode: "adjusted", points: points(4) })).toBe("adjusted");
  expect(paperScoringState(4, 6, { mode: "adjusted", points: points(6) })).toBe("needsAdjustment");
  expect(paperScoringState(4, 6, { mode: "answerOnly" })).toBe("answerOnly");
});

test("扫描所选小问题干、选项与答案中的旧分值，忽略其他小问", () => {
  const content = math();
  content.subQuestions[0].originalScore = 6;
  content.subQuestions[0].prompt = [paragraph("求值。（6 分）")];
  content.subQuestions[0].options = [{ label: "A", content: [paragraph("6 分即可")] }];
  content.subQuestions[0].answers = [{ slotId: null, blocks: [paragraph("答案按 6 分给出")], variants: [] }];
  content.subQuestions[1].prompt = [paragraph("另一问（6 分）")];

  const conflicts = scoreConflicts(content, ["part-1"], 4);
  expect(conflicts).toHaveLength(1);
  expect(conflicts[0]).toEqual({ subQuestionId: "part-1", value: 6, text: "6 分", key: "part-1|6|6 分" });
  expect(scoreConflicts(content, ["part-1"], 6)).toEqual([]);
  expect(scoreConflicts(content, ["part-2"], 4)).toEqual([
    { subQuestionId: "part-2", value: 6, text: "6 分", key: "part-2|6|6 分" },
  ]);
});

test("没有原分值的小问不产生旧分值冲突", () => {
  const content = math();
  content.subQuestions[0].prompt = [paragraph("（6 分）")];
  content.subQuestions[0].originalScore = null;
  expect(scoreConflicts(content, ["part-1"], 4)).toEqual([]);
});
