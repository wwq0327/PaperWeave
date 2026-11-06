import { expect, test } from "vitest";
import { isAiDraft } from "../../../src/shared/ai";
import { fakeAiDraft } from "../../../src/main/ai-fake";

const input = { mode: "text" as const, text: "\n[原卷第 1 页]\n甲乙\n[原卷第 2 页]\n丙丁", pages: [1, 2] };

test("固定响应携带页内锚点并通过协议校验", async () => {
  const draft = await fakeAiDraft("ok", input);
  expect(isAiDraft(draft)).toBe(true);
  const anchors = draft.questions.map((question) => question.sourceAnchors);
  expect(anchors[0]).toEqual([{ page: 1, start: 0, end: 2 }]);
  expect(anchors[1]).toEqual([{ page: 2, start: 0, end: 2 }]);
});

test("黄金样本场景无待核项，可用于一键自动通过回归", async () => {
  const draft = await fakeAiDraft("clean", input);
  expect(isAiDraft(draft)).toBe(true);
  expect(draft.questions).toHaveLength(2);
  for (const question of draft.questions) {
    expect(question.uncertain).toEqual([]);
    expect(question.tags).toEqual([]);
    expect(question.materials).toBeUndefined();
    expect(question.sourceAnchors).toHaveLength(1);
    expect(question.answer).toBeUndefined();
    expect(question.parts?.[0].answer).not.toBe("");
    expect(question.parts?.[0].score).toBeGreaterThan(0);
  }
  expect(draft.questions.map((question) => question.originalNumber)).toEqual(["1", "2"]);
});
