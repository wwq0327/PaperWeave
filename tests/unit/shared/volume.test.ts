import { expect, test } from "vitest";
import type { Draft } from "../../../src/shared/document";
import { volumeSections } from "../../../src/shared/volume";

const draft: Draft = {
  version: 3,
  blocks: [{ type: "paragraph", runs: [{ type: "text", text: "小明有几个苹果？", style: "普通" }] }],
  teacherAnswer: "参考答案：3 个苹果。",
  sources: [],
};

test("学生卷只含题目字段，答案不出现在任何字段中", () => {
  const student = volumeSections(draft, "student");
  expect(student).toEqual({ blocks: draft.blocks, answer: null });
  expect(JSON.stringify(student)).not.toContain("参考答案");
});

test("教师卷含题目字段与参考答案", () => {
  expect(volumeSections(draft, "teacher")).toEqual({ blocks: draft.blocks, answer: "参考答案：3 个苹果。" });
});

test("空白答案视为无答案，不生成空答案节", () => {
  expect(volumeSections({ ...draft, teacherAnswer: "  \n " }, "teacher").answer).toBeNull();
});
