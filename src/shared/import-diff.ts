import type { Classification, QuestionBlock, QuestionContent, QuestionInline } from "./question";

export type ImportDiffChange = "added" | "removed" | "modified";
export type ImportDiffField = "题号" | "分类" | "题干" | "答案" | "解析" | "材料" | "图片";

export interface ImportFieldDiff {
  field: ImportDiffField;
  change: ImportDiffChange;
  before: string;
  after: string;
}

export interface ImportDiffMaterial {
  title: string;
  blocks: QuestionBlock[];
}

/** 一侧的题目快照：题库当前版本，或本次扫描到的来源内容。 */
export interface ImportDiffSide {
  number: string;
  classification: Classification;
  content: QuestionContent;
  materials: ImportDiffMaterial[];
}

const NO_VALUE = "（无）";
const MAX_CHARS = 160;

function inlineText(run: QuestionInline): string {
  if (run.type === "text") return run.text;
  if (run.type === "formula") return run.latex;
  return run.fallback;
}

/** 差异只比较可读文字；图片由图片字段单独比较。 */
function textOf(blocks: QuestionBlock[]): string {
  return blocks.map((block) => {
    if (block.type === "paragraph") return block.runs.map(inlineText).join("");
    if (block.type === "formula") return block.latex;
    if (block.type === "table") return block.rows.map((row) => row.join(" ")).join(" ");
    return "";
  }).filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
}

function stemText(content: QuestionContent): string {
  const parts = [textOf(content.stem)];
  for (const sub of content.subQuestions) {
    const prompt = textOf(sub.prompt);
    if (prompt) parts.push(`${sub.originalLabel}${prompt}`);
    for (const option of sub.options) {
      const value = textOf(option.content);
      if (value) parts.push(`${option.label}.${value}`);
    }
  }
  return parts.filter(Boolean).join(" ");
}

function answerText(content: QuestionContent): string {
  const parts: string[] = [];
  for (const sub of content.subQuestions) {
    for (const answer of sub.answers) {
      const value = textOf(answer.blocks);
      if (!value) continue;
      const variants = answer.variants.filter(Boolean).join("、");
      parts.push(`${sub.originalLabel}${value}${variants ? `（变体：${variants}）` : ""}`);
    }
  }
  return parts.join("；");
}

function explanationText(content: QuestionContent): string {
  return content.subQuestions.map((sub) => {
    const value = textOf(sub.explanation);
    return value ? `${sub.originalLabel}${value}` : "";
  }).filter(Boolean).join("；");
}

function imageLabels(content: QuestionContent): string[] {
  const labels: string[] = [];
  const collect = (blocks: QuestionBlock[]) => {
    for (const block of blocks) if (block.type === "image") labels.push(`${block.alt || "图"}（${block.id.slice(0, 8)}）`);
  };
  collect(content.stem);
  for (const sub of content.subQuestions) {
    collect(sub.prompt);
    for (const option of sub.options) collect(option.content);
    for (const answer of sub.answers) collect(answer.blocks);
    collect(sub.explanation);
  }
  return labels;
}

function materialText(materials: ImportDiffMaterial[]): string {
  return materials.map((material) => {
    const text = textOf(material.blocks);
    const images = material.blocks.filter((block) => block.type === "image").map((block) => block.alt || "图");
    const extras = [text, images.length > 0 ? `图：${images.join("、")}` : ""].filter(Boolean).join(" ");
    return extras ? `${material.title}：${extras}` : material.title;
  }).join(" | ");
}

function classificationText(classification: Classification): string {
  const basics = [
    classification.stage,
    classification.subject,
    classification.grade,
    classification.examType || "未填",
    classification.year || "未填",
    classification.sourceName || "未填",
    classification.questionType || "未填",
  ];
  const points = classification.knowledgePoints.length > 0 ? classification.knowledgePoints.join("、") : "无知识点";
  return `${basics.join("·")}·${points}`;
}

function display(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return NO_VALUE;
  return trimmed.length > MAX_CHARS ? `${trimmed.slice(0, MAX_CHARS)}…` : trimmed;
}

function field(field: ImportDiffField, before: string, after: string): ImportFieldDiff[] {
  const rawBefore = before.trim() || NO_VALUE;
  const rawAfter = after.trim() || NO_VALUE;
  if (rawBefore === rawAfter) return [];
  const change: ImportDiffChange = rawBefore === NO_VALUE ? "added" : rawAfter === NO_VALUE ? "removed" : "modified";
  return [{ field, change, before: display(rawBefore), after: display(rawAfter) }];
}

/** 来源变化时的字段级差异，只返回实际变化的字段。 */
export function diffImportContent(before: ImportDiffSide, after: ImportDiffSide): ImportFieldDiff[] {
  return [
    ...field("题号", before.number, after.number),
    ...field("分类", classificationText(before.classification), classificationText(after.classification)),
    ...field("题干", stemText(before.content), stemText(after.content)),
    ...field("答案", answerText(before.content), answerText(after.content)),
    ...field("解析", explanationText(before.content), explanationText(after.content)),
    ...field("材料", materialText(before.materials), materialText(after.materials)),
    ...field("图片", imageLabels(before.content).join("、"), imageLabels(after.content).join("、")),
  ];
}
