import { expect, test } from "vitest";
import { isDraft, upgradeDraft } from "../../../src/shared/document";

test("旧草稿读取时保留内容，增加独立教师答案与来源字段", () => {
  const old = { version: 1, blocks: [{ type: "paragraph", runs: [{ type: "text", text: "原题", style: "普通" }] }] };
  expect(isDraft(old)).toBe(true);
  if (!isDraft(old)) throw new Error("旧草稿无效");
  expect(upgradeDraft(old)).toEqual({ version: 3, blocks: old.blocks, teacherAnswer: "", sources: [] });
});

test("版本 2 草稿升级时补空来源列表", () => {
  const v2 = { version: 2, blocks: [], teacherAnswer: "答案" };
  expect(isDraft(v2)).toBe(true);
  if (!isDraft(v2)) throw new Error("版本 2 草稿无效");
  expect(upgradeDraft(v2)).toEqual({ version: 3, blocks: [], teacherAnswer: "答案", sources: [] });
});

test("版本 3 草稿保存原卷页与待核项，非法来源被拒绝", () => {
  const draft = { version: 3, blocks: [], teacherAnswer: "", sources: [{ pages: [3, 4], uncertain: ["固定响应待核点"] }] };
  expect(isDraft(draft)).toBe(true);
  expect(isDraft({ version: 3, blocks: [], teacherAnswer: "" })).toBe(false);
  expect(isDraft({ ...draft, sources: [{ pages: [], uncertain: [] }] })).toBe(false);
  expect(isDraft({ ...draft, sources: [{ pages: [0], uncertain: [] }] })).toBe(false);
  expect(isDraft({ ...draft, sources: [{ pages: [3], uncertain: [], extra: true }] })).toBe(false);
  expect(isDraft({ ...draft, sources: [{ pages: [3], uncertain: ["字".repeat(2001)] }] })).toBe(false);
  expect(isDraft({ ...draft, extra: true })).toBe(false);
});

test("拒绝未知字段和无效答案", () => {
  expect(isDraft({ version: 2, blocks: [], teacherAnswer: "答案", extra: "无法识别" })).toBe(false);
  expect(isDraft({ version: 2, blocks: [], teacherAnswer: { html: "答案" } })).toBe(false);
});
