import type { Block } from "./document";

export const AI_LIMITS = {
  textChars: 8000,
  imageCount: 4,
  imageBytes: 5 * 1024 * 1024,
  imageTotalBytes: 15 * 1024 * 1024,
  timeoutMs: 120000,
} as const;

export interface AiQuestion {
  stem: string;
  subquestions: string[];
  options: string[];
  tags: string[];
  uncertain: string[];
  page: number;
  answer?: string;
}

export interface AiDraft {
  questions: AiQuestion[];
  notes: string[];
}

const questionKeys = new Set(["stem", "subquestions", "options", "tags", "uncertain", "page", "answer"]);
const text = (x: unknown, max = 8000): x is string => typeof x === "string" && x.length <= max;
const textList = (x: unknown, maxItems = 30, max = 8000): x is string[] =>
  Array.isArray(x) && x.length <= maxItems && x.every((item) => text(item, max));

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
  | { mode: "text"; text: string; pages: number[] }
  | { mode: "images"; images: { dataUrl: string; page: number }[]; note?: string };

const pageList = (x: unknown): x is number[] =>
  Array.isArray(x) && x.length >= 1 && x.length <= 50 && x.every((page) => typeof page === "number" && Number.isInteger(page) && page >= 1 && page <= 2000);

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
    const error = checkText(input.text);
    return error ? { ok: false, error } : { ok: true, input: { mode: "text", text: input.text, pages: input.pages } };
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
    return { ok: true, input: { mode: "images", images: typed, note: input.note as string | undefined } };
  }
  return { ok: false, error: "未知的输入方式" };
}

export function questionToBlocks(question: AiQuestion): { blocks: Block[]; answer: string } {
  const blocks: Block[] = [];
  const append = (value: string) => {
    if (value.trim()) blocks.push({ type: "paragraph", runs: [{ type: "text", text: value, style: "普通" }] });
  };
  append(question.stem);
  for (const sub of question.subquestions) append(sub);
  question.options.forEach((option, index) => append(`${index < 26 ? String.fromCharCode(65 + index) : index + 1}. ${option}`));
  return { blocks, answer: question.answer ?? "" };
}
