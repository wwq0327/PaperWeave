export type TextStyle = "普通" | "粗体" | "斜体" | "下划线" | "上标" | "下标";
export type Inline = { type: "text"; text: string; style: TextStyle } | { type: "formula"; latex: string };
export type Block =
  | { type: "paragraph"; runs: Inline[] }
  | { type: "formula"; latex: string }
  | { type: "image"; id: string; alt: string }
  | { type: "table"; rows: string[][] };
export interface DraftSource {
  pages: number[];
  uncertain: string[];
}
export type Draft = { version: 3; blocks: Block[]; teacherAnswer: string; sources: DraftSource[] };
export type StoredDraft = Draft | { version: 2; blocks: Block[]; teacherAnswer: string } | { version: 1; blocks: Block[] };
export const emptyDraft = (): Draft => ({ version: 3, teacherAnswer: "", sources: [], blocks: [{ type: "paragraph", runs: [{ type: "text", text: "", style: "普通" }] }] });
const styles = new Set(["普通", "粗体", "斜体", "下划线", "上标", "下标"]);
const object = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const keys = (x: Record<string, unknown>, allowed: string[]) => Object.keys(x).every((k) => allowed.includes(k));
const str = (x: unknown, max = 20000): x is string => typeof x === "string" && x.length <= max;
const pageList = (x: unknown): x is number[] => Array.isArray(x) && x.length >= 1 && x.length <= 50 && x.every((page) => typeof page === "number" && Number.isInteger(page) && page >= 1 && page <= 2000);
const textList = (x: unknown, maxItems: number, max: number): x is string[] => Array.isArray(x) && x.length <= maxItems && x.every((item) => str(item, max));
const isSource = (x: unknown): x is DraftSource => object(x) && keys(x, ["pages", "uncertain"]) && pageList(x.pages) && textList(x.uncertain, 30, 2000);

/** 行内内容只允许文本与公式；题目引用在题目层扩展。 */
export function isInline(value: unknown): value is Inline {
  if (!object(value)) return false;
  return (value.type === "text" && keys(value, ["type", "text", "style"]) && str(value.text) && typeof value.style === "string" && styles.has(value.style))
    || (value.type === "formula" && keys(value, ["type", "latex"]) && str(value.latex, 4000));
}

/** 内容块是编辑器、题目与材料的共同单位；结构不认识时直接拒绝。 */
export function isBlock(value: unknown): value is Block {
  if (!object(value)) return false;
  if (value.type === "paragraph") return keys(value, ["type", "runs"]) && Array.isArray(value.runs) && value.runs.length <= 500 && value.runs.every(isInline);
  if (value.type === "formula") return keys(value, ["type", "latex"]) && str(value.latex, 4000);
  if (value.type === "image") return keys(value, ["type", "id", "alt"]) && typeof value.id === "string" && /^[a-f0-9]{64}$/.test(value.id) && str(value.alt, 1000);
  if (value.type === "table") return keys(value, ["type", "rows"]) && Array.isArray(value.rows) && value.rows.length > 0 && value.rows.length <= 30 && value.rows.every((row: unknown) => Array.isArray(row) && row.length > 0 && row.length <= 10 && row.every((cell: unknown) => str(cell, 4000))) && value.rows.every((row: string[]) => row.length === (value.rows as string[][])[0].length);
  return false;
}

export function isBlockList(value: unknown): value is Block[] {
  return Array.isArray(value) && value.length <= 500 && value.every(isBlock);
}

/** 不认识的结构直接拒绝，避免读取或保存时静默丢失内容。 */
export function isDraft(x: unknown): x is StoredDraft {
  if (!object(x) || !isBlockList(x.blocks)) return false;
  if (x.version === 1) { if (!keys(x, ["version", "blocks"])) return false; }
  else if (x.version === 2) { if (!keys(x, ["version", "blocks", "teacherAnswer"]) || !str(x.teacherAnswer)) return false; }
  else if (x.version === 3) {
    if (!keys(x, ["version", "blocks", "teacherAnswer", "sources"]) || !str(x.teacherAnswer)) return false;
    if (!Array.isArray(x.sources) || x.sources.length > 100 || !x.sources.every(isSource)) return false;
  }
  else return false;
  return true;
}

/** 旧草稿只在读取时转换，直到用户保存才写回；旧版没有来源信息，补空列表。 */
export function upgradeDraft(draft: StoredDraft): Draft {
  if (draft.version === 3) return draft;
  if (draft.version === 2) return { version: 3, blocks: draft.blocks, teacherAnswer: draft.teacherAnswer, sources: [] };
  return { version: 3, blocks: draft.blocks, teacherAnswer: "", sources: [] };
}
