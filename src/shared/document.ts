export type TextStyle = "普通" | "粗体" | "斜体" | "下划线" | "上标" | "下标";
export type Inline = { type: "text"; text: string; style: TextStyle } | { type: "formula"; latex: string };
export type Block =
  | { type: "paragraph"; runs: Inline[] }
  | { type: "formula"; latex: string }
  | { type: "image"; id: string; alt: string }
  | { type: "table"; rows: string[][] };
export type Draft = { version: 1; blocks: Block[] };
export const emptyDraft = (): Draft => ({ version: 1, blocks: [{ type: "paragraph", runs: [{ type: "text", text: "", style: "普通" }] }] });
const styles = new Set(["普通", "粗体", "斜体", "下划线", "上标", "下标"]);
const object = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const keys = (x: Record<string, unknown>, allowed: string[]) => Object.keys(x).every((k) => allowed.includes(k));
const str = (x: unknown, max = 20000): x is string => typeof x === "string" && x.length <= max;

/** 不认识的结构直接拒绝，避免读取或保存时静默丢失内容。 */
export function isDraft(x: unknown): x is Draft {
  if (!object(x) || !keys(x, ["version", "blocks"]) || x.version !== 1 || !Array.isArray(x.blocks) || x.blocks.length > 500) return false;
  return x.blocks.every((b: unknown) => {
    if (!object(b)) return false;
    if (b.type === "paragraph") return keys(b, ["type", "runs"]) && Array.isArray(b.runs) && b.runs.length <= 500 && b.runs.every((r: unknown) => object(r) && ((r.type === "text" && keys(r, ["type", "text", "style"]) && str(r.text) && typeof r.style === "string" && styles.has(r.style)) || (r.type === "formula" && keys(r, ["type", "latex"]) && str(r.latex, 4000))));
    if (b.type === "formula") return keys(b, ["type", "latex"]) && str(b.latex, 4000);
    if (b.type === "image") return keys(b, ["type", "id", "alt"]) && typeof b.id === "string" && /^[a-f0-9]{64}$/.test(b.id) && str(b.alt, 1000);
    if (b.type === "table") return keys(b, ["type", "rows"]) && Array.isArray(b.rows) && b.rows.length > 0 && b.rows.length <= 30 && b.rows.every((row: unknown) => Array.isArray(row) && row.length > 0 && row.length <= 10 && row.every((cell: unknown) => str(cell, 4000))) && b.rows.every((row: string[]) => row.length === (b.rows as string[][])[0].length);
    return false;
  });
}
