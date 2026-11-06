import type { Block } from "./document";
import type { Stage } from "./question";

export const AI_LIMITS = {
  textChars: 8000,
  imageCount: 4,
  imageBytes: 5 * 1024 * 1024,
  imageTotalBytes: 15 * 1024 * 1024,
  timeoutMs: 120000,
  tagCount: 20,
  contextChars: 100,
} as const;

/** 整卷来源类型：PDF 按页定位，DOCX 按文档段落定位。 */
export type AiSourceKind = "pdf" | "docx";

export function originalFileKind(originalName: string): AiSourceKind {
  return originalName.toLowerCase().endsWith(".docx") ? "docx" : "pdf";
}

/** 来源位置文案；DOCX 的编号是文档段落序号，不是 Word 分页。 */
export function sourceUnitLabel(kind: AiSourceKind, unit: number): string {
  return kind === "docx" ? `第 ${unit} 段` : `第 ${unit} 页`;
}

/** 生成草稿时随请求发送的科目信息；标签候选由主进程按题库补充。 */
export interface AiContext {
  stage: Stage;
  subject: string;
  grade: string;
  questionType: string;
}

/** AI 草稿与本次请求实际使用的标签候选一起返回，供采纳时区分新标签。 */
export interface AiDraftResult {
  draft: AiDraft;
  tagCandidates: string[];
}

export interface AiPart {
  label: string;
  prompt: string;
  options: string[];
  answer: string;
  explanation: string;
  score: number | null;
  uncertain: string[];
}

export interface AiMaterialSuggestion {
  title: string;
  content: string;
  source: string;
  /** 材料所属小问标签；缺省表示模型未标明归属。 */
  appliesTo?: string[];
}

export interface AiQuestion {
  stem: string;
  subquestions: string[];
  options: string[];
  tags: string[];
  uncertain: string[];
  page: number;
  answer?: string;
  parts?: AiPart[];
  materials?: AiMaterialSuggestion[];
  questionType?: string;
  knowledgePoints?: string[];
  originalNumber?: string;
}

export interface AiDraft {
  questions: AiQuestion[];
  notes: string[];
}

const questionKeys = new Set(["stem", "subquestions", "options", "tags", "uncertain", "page", "answer", "parts", "materials", "questionType", "knowledgePoints", "originalNumber"]);
const partKeys = new Set(["label", "prompt", "options", "answer", "explanation", "score", "uncertain"]);
const materialKeys = new Set(["title", "content", "source", "appliesTo"]);
const text = (x: unknown, max = 8000): x is string => typeof x === "string" && x.length <= max;
const textList = (x: unknown, maxItems = 30, max = 8000): x is string[] =>
  Array.isArray(x) && x.length <= maxItems && x.every((item) => text(item, max));

function isPart(value: unknown): value is AiPart {
  if (typeof value !== "object" || value === null) return false;
  const part = value as Record<string, unknown>;
  if (!Object.keys(part).every((key) => partKeys.has(key))) return false;
  if (!text(part.label, 20) || !text(part.prompt) || !part.prompt.trim()) return false;
  if (!textList(part.options, 26) || !text(part.answer) || !text(part.explanation) || !textList(part.uncertain, 30, 2000)) return false;
  if (part.score !== null && (typeof part.score !== "number" || !Number.isFinite(part.score) || part.score < 0 || part.score > 1000)) return false;
  return true;
}

function isMaterialSuggestion(value: unknown): value is AiMaterialSuggestion {
  if (typeof value !== "object" || value === null) return false;
  const material = value as Record<string, unknown>;
  if (!Object.keys(material).every((key) => materialKeys.has(key))) return false;
  if (material.appliesTo !== undefined && (!Array.isArray(material.appliesTo) || material.appliesTo.length > 30 || !material.appliesTo.every((label) => typeof label === "string" && label.trim() !== "" && label.length <= 20))) return false;
  return text(material.title, 200) && material.title.trim() !== "" && text(material.content) && material.content.trim() !== "" && text(material.source, 500);
}

/** 模型返回只接受约定的纯文本结构；未知字段或不合法分页直接拒绝。 */
export function isAiDraft(value: unknown): value is AiDraft {
  if (typeof value !== "object" || value === null) return false;
  const draft = value as Record<string, unknown>;
  if (!Array.isArray(draft.questions) || draft.questions.length < 1 || draft.questions.length > 20) return false;
  if (!textList(draft.notes, 20, 2000)) return false;
  return draft.questions.every((question: unknown) => {
    if (typeof question !== "object" || question === null) return false;
    const q = question as Record<string, unknown>;
    if (!Object.keys(q).every((key) => questionKeys.has(key))) return false;
    if (!text(q.stem) || !q.stem.trim()) return false;
    if (!textList(q.subquestions) || !textList(q.options) || !textList(q.tags, 30, 200) || !textList(q.uncertain, 30, 2000)) return false;
    if (typeof q.page !== "number" || !Number.isInteger(q.page) || q.page < 1 || q.page > 2000) return false;
    if (q.answer !== undefined && !text(q.answer)) return false;
    if (q.parts !== undefined && (!Array.isArray(q.parts) || q.parts.length > 30 || !q.parts.every(isPart))) return false;
    if (q.materials !== undefined && (!Array.isArray(q.materials) || q.materials.length > 10 || !q.materials.every(isMaterialSuggestion))) return false;
    if (q.questionType !== undefined && !text(q.questionType, 200)) return false;
    if (q.knowledgePoints !== undefined && !textList(q.knowledgePoints, 30, 100)) return false;
    if (q.originalNumber !== undefined && !text(q.originalNumber, 20)) return false;
    return true;
  });
}

export function checkText(value: string): string | null {
  if (!value.trim()) return "请输入或提取待处理的文字";
  if ([...value].length > AI_LIMITS.textChars) return `文字超过 ${AI_LIMITS.textChars} 个字符，请按题或按页分批提交`;
  return null;
}

export function checkImages(images: { bytes: number }[]): string | null {
  if (images.length === 0) return "请至少选择一张裁图";
  if (images.length > AI_LIMITS.imageCount) return `最多提交 ${AI_LIMITS.imageCount} 张裁图，请分批处理`;
  if (images.some((image) => image.bytes > AI_LIMITS.imageBytes)) return "单张裁图不能超过 5 MiB，请压缩或缩小选区";
  if (images.reduce((total, image) => total + image.bytes, 0) > AI_LIMITS.imageTotalBytes) return "裁图合计超过 15 MiB，请分批提交";
  return null;
}

export type AiInput =
  | { mode: "text"; text: string; pages: number[]; sourceKind?: AiSourceKind; context?: AiContext }
  | { mode: "images"; images: { dataUrl: string; page: number }[]; note?: string; context?: AiContext };

const pageList = (x: unknown): x is number[] =>
  Array.isArray(x) && x.length >= 1 && x.length <= 50 && x.every((page) => typeof page === "number" && Number.isInteger(page) && page >= 1 && page <= 2000);

function parseContext(value: unknown): { ok: true; context?: AiContext } | { ok: false; error: string } {
  if (value === undefined) return { ok: true };
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { ok: false, error: "科目信息格式无效" };
  const context = value as Record<string, unknown>;
  if (!Object.keys(context).every((key) => ["stage", "subject", "grade", "questionType"].includes(key))) {
    return { ok: false, error: "科目信息包含未知字段" };
  }
  if (context.stage !== "小学" && context.stage !== "初中" && context.stage !== "高中") return { ok: false, error: "科目信息学段无效" };
  for (const key of ["subject", "grade", "questionType"] as const) {
    if (typeof context[key] !== "string" || context[key].length > AI_LIMITS.contextChars) return { ok: false, error: "科目信息字段无效" };
  }
  const subject = (context.subject as string).trim();
  const grade = (context.grade as string).trim();
  if (!subject || !grade) return { ok: false, error: "科目信息缺少学科或年级" };
  return {
    ok: true,
    context: { stage: context.stage, subject, grade, questionType: (context.questionType as string).trim() },
  };
}

export function base64Bytes(dataUrl: string): number {
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

/** 提交前统一校验输入，渲染层与主进程使用同一规则。 */
export function normalizeAiInput(value: unknown): { ok: true; input: AiInput } | { ok: false; error: string } {
  if (typeof value !== "object" || value === null) return { ok: false, error: "AI 输入格式无效" };
  const input = value as Record<string, unknown>;
  if (input.mode === "text") {
    if (typeof input.text !== "string" || !pageList(input.pages)) return { ok: false, error: "文字或页码无效" };
    if (input.sourceKind !== undefined && input.sourceKind !== "pdf" && input.sourceKind !== "docx") return { ok: false, error: "来源类型无效" };
    const error = checkText(input.text);
    if (error) return { ok: false, error };
    const parsed = parseContext(input.context);
    if (!parsed.ok) return parsed;
    return {
      ok: true,
      input: {
        mode: "text",
        text: input.text,
        pages: input.pages,
        ...(input.sourceKind === undefined ? {} : { sourceKind: input.sourceKind as AiSourceKind }),
        context: parsed.context,
      },
    };
  }
  if (input.mode === "images") {
    if (!Array.isArray(input.images)) return { ok: false, error: "裁图格式无效" };
    const images = input.images as unknown[];
    if (!images.every((image) => typeof image === "object" && image !== null &&
      typeof (image as Record<string, unknown>).dataUrl === "string" &&
      /^data:image\/(png|jpeg);base64,/.test((image as Record<string, unknown>).dataUrl as string) &&
      typeof (image as Record<string, unknown>).page === "number" && Number.isInteger((image as Record<string, unknown>).page) && ((image as Record<string, unknown>).page as number) >= 1 && ((image as Record<string, unknown>).page as number) <= 2000)) {
      return { ok: false, error: "裁图格式无效" };
    }
    const typed = images as { dataUrl: string; page: number }[];
    const error = checkImages(typed.map((image) => ({ bytes: base64Bytes(image.dataUrl) })));
    if (error) return { ok: false, error };
    if (input.note !== undefined && (typeof input.note !== "string" || input.note.length > 2000)) return { ok: false, error: "说明不能超过 2000 字符" };
    const parsed = parseContext(input.context);
    if (!parsed.ok) return parsed;
    return { ok: true, input: { mode: "images", images: typed, note: input.note as string | undefined, context: parsed.context } };
  }
  return { ok: false, error: "未知的输入方式" };
}

export function questionToBlocks(question: AiQuestion): { blocks: Block[]; answer: string } {
  const blocks: Block[] = [];
  const append = (value: string) => {
    if (value.trim()) blocks.push({ type: "paragraph", runs: [{ type: "text", text: value, style: "普通" }] });
  };
  append(question.stem);
  const subquestions = question.subquestions.length > 0
    ? question.subquestions
    : (question.parts ?? []).map((part) => `${part.label ? `${part.label} ` : ""}${part.prompt}`);
  for (const sub of subquestions) append(sub);
  const options = question.options.length > 0 ? question.options : (question.parts ?? []).flatMap((part) => part.options);
  options.forEach((option, index) => append(`${index < 26 ? String.fromCharCode(65 + index) : index + 1}. ${option}`));
  const answer = question.answer
    ?? (question.parts ?? []).map((part) => part.answer).filter((value) => value.trim()).join("\n");
  return { blocks, answer };
}
