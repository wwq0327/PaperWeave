import { readFileSync } from "node:fs";
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

test("clean 固定响应与黄金样本一致", async () => {
  const golden = JSON.parse(readFileSync("tests/fixtures/golden/text-paper.json", "utf8")) as {
    questions: { originalNumber: string; stem: string; answer: string; score: number; anchor: { page: number; start: number; end: number } }[];
  };
  const draft = await fakeAiDraft("clean", input);
  expect(draft.questions.map((question) => ({
    originalNumber: question.originalNumber,
    stem: question.stem,
    answer: question.parts?.[0].answer,
    score: question.parts?.[0].score,
    anchor: question.sourceAnchors?.[0],
  }))).toEqual(golden.questions);
});

test("clean 场景按 DOCX 输入段落逐段返回稳定题目", async () => {
  const docx = {
    mode: "text" as const,
    text: "\n[原卷第 1 段]\n甲\n[原卷第 2 段]\n[公式]\n[原卷第 3 段]\n[图片：pic.png]\n[原卷第 5 段]\n表",
    pages: [1, 2, 3, 5],
  };
  const draft = await fakeAiDraft("clean", docx);
  expect(draft.questions.map((question) => question.originalNumber)).toEqual(["1", "2", "3", "4"]);
  expect(draft.questions.map((question) => question.page)).toEqual([1, 2, 3, 5]);
  expect(draft.questions.every((question) => question.sourceAnchors?.length === 1)).toBe(true);
});
