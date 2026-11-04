import { expect, test } from "vitest";
import { diffImportContent, type ImportDiffSide } from "../../../src/shared/import-diff";
import type { Classification, QuestionBlock, QuestionContent } from "../../../src/shared/question";

const classification: Classification = {
  stage: "初中",
  subject: "数学",
  grade: "九年级",
  examType: "单元测",
  year: "2026",
  sourceName: "自制样题",
  questionType: "解答题",
  knowledgePoints: ["一元二次方程"],
};

function textBlocks(text: string): QuestionBlock[] {
  return text ? [{ type: "paragraph", runs: [{ type: "text", text, style: "普通" }] }] : [];
}

function content(options: { stem?: string; prompt?: string; answer?: string; explanation?: string; images?: { id: string; alt: string }[] } = {}): QuestionContent {
  return {
    stem: textBlocks(options.stem ?? ""),
    subQuestions: [{
      id: "sub-1",
      originalLabel: "（1）",
      prompt: [...textBlocks(options.prompt ?? ""), ...(options.images ?? []).map((image) => ({ type: "image" as const, ...image }))],
      explanation: textBlocks(options.explanation ?? ""),
      options: [],
      slots: [],
      answers: options.answer ? [{ slotId: null, blocks: textBlocks(options.answer), variants: [] }] : [],
      scoring: [],
      originalScore: null,
      materialIds: [],
      dependsOn: [],
    }],
    materials: [],
    selection: { mode: "all" },
    source: { section: "测试", pdfPage: 1, originalNumber: "1" },
  };
}

function side(options: Parameters<typeof content>[0] & { number?: string; classification?: Classification; materials?: ImportDiffSide["materials"] } = {}): ImportDiffSide {
  return {
    number: options.number ?? "1",
    classification: options.classification ?? classification,
    content: content(options),
    materials: options.materials ?? [],
  };
}

test("字段差异只列出变化项，并标注新增、删除与修改", () => {
  const before = side({
    stem: "旧题干",
    answer: "旧答案",
    images: [{ id: "a".repeat(64), alt: "旧图" }],
  });
  const after = side({
    number: "2",
    classification: { ...classification, subject: "语文" },
    stem: "新题干",
    explanation: "新解析",
    materials: [{ title: "新材料", blocks: textBlocks("材料正文") }],
  });
  const diff = diffImportContent(before, after);
  expect(diff.map((item) => `${item.field}:${item.change}`)).toEqual([
    "题号:modified",
    "分类:modified",
    "题干:modified",
    "答案:removed",
    "解析:added",
    "材料:added",
    "图片:removed",
  ]);
  expect(diff.find((item) => item.field === "题号")).toMatchObject({ before: "1", after: "2" });
  expect(diff.find((item) => item.field === "分类")?.after).toContain("语文");
  expect(diff.find((item) => item.field === "题干")).toMatchObject({ before: "旧题干", after: "新题干" });
  expect(diff.find((item) => item.field === "答案")).toMatchObject({ before: "（1）旧答案", after: "（无）" });
  expect(diff.find((item) => item.field === "解析")).toMatchObject({ before: "（无）", after: "（1）新解析" });
  expect(diff.find((item) => item.field === "材料")).toMatchObject({ before: "（无）", after: "新材料：材料正文" });
  expect(diff.find((item) => item.field === "图片")).toMatchObject({ before: "旧图（aaaaaaaa）", after: "（无）" });
});

test("内容未变化时不产生差异，材料正文变化即使标题相同也计为修改", () => {
  const base = side({ stem: "题干", answer: "答案", materials: [{ title: "材料", blocks: textBlocks("原正文") }] });
  expect(diffImportContent(base, side({ stem: "题干", answer: "答案", materials: [{ title: "材料", blocks: textBlocks("原正文") }] }))).toEqual([]);
  const changed = diffImportContent(base, side({ stem: "题干", answer: "答案", materials: [{ title: "材料", blocks: textBlocks("修改后的正文") }] }));
  expect(changed).toEqual([{ field: "材料", change: "modified", before: "材料：原正文", after: "材料：修改后的正文" }]);
});

test("小问题干归入题干差异，长文本截断显示", () => {
  const before = side({ stem: "旧".repeat(200), prompt: "旧小问", answer: "" });
  const after = side({ stem: "新".repeat(200), prompt: "新小问", answer: "" });
  const diff = diffImportContent(before, after);
  expect(diff).toHaveLength(1);
  expect(diff[0].field).toBe("题干");
  expect(diff[0].change).toBe("modified");
  expect(diff[0].before.length).toBeLessThanOrEqual(161);
  expect(diff[0].before.endsWith("…")).toBe(true);
  expect(diff[0].after.length).toBeLessThanOrEqual(161);
});
