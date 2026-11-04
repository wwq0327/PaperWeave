import { expect, test } from "vitest";
import { isDraft, upgradeDraft } from "../../../src/shared/document";

test("旧草稿读取时保留内容，增加独立教师答案字段", () => {
  const old = { version: 1, blocks: [{ type: "paragraph", runs: [{ type: "text", text: "原题", style: "普通" }] }] };
  expect(isDraft(old)).toBe(true);
  if (!isDraft(old)) throw new Error("旧草稿无效");
  expect(upgradeDraft(old)).toEqual({ version: 2, blocks: old.blocks, teacherAnswer: "" });
});

test("拒绝未知字段和无效答案", () => {
  expect(isDraft({ version: 2, blocks: [], teacherAnswer: "答案", extra: "无法识别" })).toBe(false);
  expect(isDraft({ version: 2, blocks: [], teacherAnswer: { html: "答案" } })).toBe(false);
});
