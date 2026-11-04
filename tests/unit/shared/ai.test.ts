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

test("AI 输入可选携带科目上下文，非法学段、未知字段与超长字段被拒绝", () => {
  const context = { stage: "初中" as const, subject: "语文", grade: "九年级", questionType: "阅读题" };
  const ok = normalizeAiInput({ mode: "text", text: "题干", pages: [1], context });
  expect(ok.ok && ok.input.context).toEqual(context);
  expect(normalizeAiInput({ mode: "text", text: "题干", pages: [1], context: { ...context, stage: "大学" } }).ok).toBe(false);
  expect(normalizeAiInput({ mode: "text", text: "题干", pages: [1], context: { ...context, extra: "x" } }).ok).toBe(false);
  expect(normalizeAiInput({ mode: "text", text: "题干", pages: [1], context: { ...context, subject: "字".repeat(101) } }).ok).toBe(false);
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

test("结构化小问、材料建议与知识点严格校验", () => {
  const question = {
    stem: "题干",
    subquestions: ["(1) 小问"],
    options: [],
    tags: ["标签"],
    uncertain: [],
    page: 2,
    parts: [{ label: "(1)", prompt: "求值。", options: ["甲", "乙"], answer: "4", explanation: "代入计算。", score: 4, uncertain: [] }],
    materials: [{ title: "材料一", content: "材料正文", source: "自制" }],
    questionType: "解答题",
    knowledgePoints: ["一元二次方程"],
  };
  expect(isAiDraft({ questions: [question], notes: [] })).toBe(true);
  expect(isAiDraft({ questions: [{ ...question, parts: [{ ...question.parts[0], score: -1 }] }], notes: [] })).toBe(false);
  expect(isAiDraft({ questions: [{ ...question, parts: [{ ...question.parts[0], extra: 1 }] }], notes: [] })).toBe(false);
  expect(isAiDraft({ questions: [{ ...question, materials: [{ title: "", content: "正文", source: "" }] }], notes: [] })).toBe(false);
  expect(isAiDraft({ questions: [{ ...question, knowledgePoints: ["知识点".repeat(60)] }], notes: [] })).toBe(false);
});

test("旧格式没有结构化小问时仍可采纳为文字草稿", () => {
  const result = questionToBlocks({ stem: "题干", subquestions: [], options: [], tags: [], uncertain: [], page: 1, parts: [{ label: "(1)", prompt: "求值。", options: ["甲"], answer: "4", explanation: "", score: 4, uncertain: [] }] });
  expect(result.blocks).toEqual([
    { type: "paragraph", runs: [{ type: "text", text: "题干", style: "普通" }] },
    { type: "paragraph", runs: [{ type: "text", text: "(1) 求值。", style: "普通" }] },
    { type: "paragraph", runs: [{ type: "text", text: "A. 甲", style: "普通" }] },
  ]);
  expect(result.answer).toBe("4");
});
