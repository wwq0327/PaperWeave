import { expect, test } from "vitest";
import { checkImages, checkText, isAiDraft, questionToBlocks, normalizeAiInput, base64Bytes, AI_LIMITS } from "../../../src/shared/ai";

test("文字限额按 Unicode 码点计算，超限给出拆分提示", () => {
  expect(checkText("字".repeat(AI_LIMITS.textChars))).toBeNull();
  expect(checkText("字".repeat(AI_LIMITS.textChars + 1))).toContain("分批");
  expect(checkText("")).toContain("请输入");
});

test("裁图限额检查张数、单张与合计大小", () => {
  const mib = 1024 * 1024;
  expect(checkImages([{ bytes: mib }])).toBeNull();
  expect(checkImages([])).toContain("至少");
  expect(checkImages(Array.from({ length: AI_LIMITS.imageCount + 1 }, () => ({ bytes: 1 })))).toContain("张");
  expect(checkImages([{ bytes: AI_LIMITS.imageBytes + 1 }])).toContain("5 MiB");
  expect(checkImages(Array.from({ length: 4 }, () => ({ bytes: 4 * mib })))).toContain("合计");
});

test("AI 草稿结构严格校验，拒绝脚本结构以外的未知字段", () => {
  const valid = { questions: [{ stem: "题干", subquestions: ["(1) 小问"], options: ["A"], tags: ["标签"], uncertain: [], page: 3 }], notes: [] };
  expect(isAiDraft(valid)).toBe(true);
  expect(isAiDraft({ ...valid, questions: [{ ...valid.questions[0], extra: 1 }] })).toBe(false);
  expect(isAiDraft({ ...valid, questions: [{ ...valid.questions[0], page: 0 }] })).toBe(false);
  expect(isAiDraft({ ...valid, questions: [{ ...valid.questions[0], stem: 1 }] })).toBe(false);
  expect(isAiDraft({ questions: [], notes: [] })).toBe(false);
});

test("采纳题目时按顺序生成段落，答案单独进入教师答案", () => {
  const result = questionToBlocks({ stem: "题干", subquestions: ["(1) 小问"], options: ["选项一", "选项二"], tags: ["标签"], uncertain: ["公式待核"], page: 3, answer: "参考答案" });
  expect(result.blocks).toEqual([
    { type: "paragraph", runs: [{ type: "text", text: "题干", style: "普通" }] },
    { type: "paragraph", runs: [{ type: "text", text: "(1) 小问", style: "普通" }] },
    { type: "paragraph", runs: [{ type: "text", text: "A. 选项一", style: "普通" }] },
    { type: "paragraph", runs: [{ type: "text", text: "B. 选项二", style: "普通" }] },
  ]);
  expect(result.answer).toBe("参考答案");
});

test("文字输入校验页码与长度，返回规范化后的数据", () => {
  const ok = normalizeAiInput({ mode: "text", text: "第一题题干", pages: [3] });
  expect(ok).toEqual({ ok: true, input: { mode: "text", text: "第一题题干", pages: [3] } });
  expect(normalizeAiInput({ mode: "text", text: "  ", pages: [3] }).ok).toBe(false);
  expect(normalizeAiInput({ mode: "text", text: "题干", pages: [] }).ok).toBe(false);
  expect(normalizeAiInput({ mode: "text", text: "题干", pages: [0] }).ok).toBe(false);
  expect(normalizeAiInput({ mode: "text", text: "字".repeat(AI_LIMITS.textChars + 1), pages: [1] }).ok).toBe(false);
  expect(normalizeAiInput({ mode: "chat", text: "题干", pages: [1] }).ok).toBe(false);
});

test("裁图输入只接受 png/jpeg data URL，并按解码后大小计算限额", () => {
  const png = "data:image/png;base64," + Buffer.alloc(1024, 1).toString("base64");
  expect(base64Bytes(png)).toBe(1024);
  const ok = normalizeAiInput({ mode: "images", images: [{ dataUrl: png, page: 2 }] });
  expect(ok.ok).toBe(true);
  expect(normalizeAiInput({ mode: "images", images: [{ dataUrl: "data:image/svg+xml;base64,PHN2Zz4=", page: 2 }] }).ok).toBe(false);
  expect(normalizeAiInput({ mode: "images", images: [{ dataUrl: "https://example.com/a.png", page: 2 }] }).ok).toBe(false);
  expect(normalizeAiInput({ mode: "images", images: [] }).ok).toBe(false);
  expect(normalizeAiInput({ mode: "images", images: [{ dataUrl: png, page: 0 }] }).ok).toBe(false);
});
