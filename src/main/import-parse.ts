import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { imageMime } from "./attachments";
import type { Inline } from "../shared/document";
import type { QuestionBlock } from "../shared/question";

export type FrontmatterValue = string | string[] | null;

export interface Frontmatter {
  data: Record<string, FrontmatterValue>;
  body: string;
  problem: string | null;
}

export interface ParsedImage {
  id: string;
  path: string;
  alt: string;
}

export interface BlockParseResult {
  blocks: QuestionBlock[];
  images: ParsedImage[];
  problems: string[];
}

export const sha256 = (data: Buffer | string): string => createHash("sha256").update(data).digest("hex");

/** 支持标量、内联列表与缩进 `-` 列表；未知字段原样保留。 */
export function parseFrontmatter(text: string): Frontmatter {
  const normalized = text.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return { data: {}, body: normalized, problem: "缺少 frontmatter" };
  const end = normalized.indexOf("\n---", 4);
  if (end === -1) return { data: {}, body: normalized, problem: "frontmatter 未闭合" };
  const rawHead = normalized.slice(4, end);
  const body = normalized.slice(end + 4).replace(/^\n+/, "");
  const data: Record<string, FrontmatterValue> = {};
  const lines = rawHead.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^([^\s:#][^:]*):\s*(.*)$/.exec(lines[index]);
    if (!match) continue;
    const key = match[1].trim();
    const rest = match[2].trim();
    if (rest === "") {
      const items: string[] = [];
      while (index + 1 < lines.length && /^\s+-\s+/.test(lines[index + 1])) {
        index += 1;
        items.push(cleanScalar(lines[index].replace(/^\s+-\s+/, "")));
      }
      data[key] = items.length > 0 ? items : null;
      continue;
    }
    if (rest === "[]") { data[key] = []; continue; }
    if (rest === "null" || rest === "~") { data[key] = null; continue; }
    if (rest.startsWith("[") && rest.endsWith("]")) {
      data[key] = rest.slice(1, -1).split(",").map((item) => cleanScalar(item)).filter((item) => item !== "");
      continue;
    }
    data[key] = cleanScalar(rest);
  }
  return { data, body, problem: null };
}

function cleanScalar(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function textValue(value: FrontmatterValue | undefined): string {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return value.join(" ").trim();
  return "";
}

export function listValue(value: FrontmatterValue | undefined): string[] {
  if (Array.isArray(value)) return value.map((item) => item.trim()).filter(Boolean);
  if (typeof value === "string") return value.split(/[,，、]/).map((item) => item.trim()).filter(Boolean);
  return [];
}

/** 按 `## 标题` 分节；标题名去空白，同名后出现的节覆盖前者。 */
export function splitSections(body: string): Map<string, string> {
  const sections = new Map<string, string>();
  let current: string | null = null;
  let lines: string[] = [];
  const flush = () => { if (current !== null) sections.set(current, lines.join("\n").trim()); };
  for (const line of body.replace(/\r\n/g, "\n").split("\n")) {
    const match = /^##\s+(.+?)\s*$/.exec(line);
    if (match) {
      flush();
      current = match[1].trim();
      lines = [];
    } else if (current !== null) {
      lines.push(line);
    }
  }
  flush();
  return sections;
}

/** `$...$` 拆为行内公式；未配对的 `$` 按普通文字保留。 */
export function inlineRuns(text: string): Inline[] {
  const runs: Inline[] = [];
  let index = 0;
  const pattern = /\$([^$\n]+)\$/g;
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    if (match.index > index) runs.push({ type: "text", text: text.slice(index, match.index), style: "普通" });
    runs.push({ type: "formula", latex: match[1] });
    index = match.index + match[0].length;
  }
  if (index < text.length) runs.push({ type: "text", text: text.slice(index), style: "普通" });
  return runs.filter((run) => run.type !== "text" || run.text !== "");
}

export type ImageResolver = (raw: string) => { path: string } | { problem: string };

/** 逐行转块：图片单独成块，其余文字成段；缺图与格式问题逐条返回。 */
export function markdownBlocks(text: string, resolve: ImageResolver): BlockParseResult {
  const blocks: QuestionBlock[] = [];
  const images: ParsedImage[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const rawLine of text.replace(/\r\n/g, "\n").split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const matches = [...line.matchAll(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)];
    const withoutImages = line.replace(/!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, "").trim();
    if (withoutImages) {
      const runs = inlineRuns(withoutImages);
      if (runs.length > 0) blocks.push({ type: "paragraph", runs });
    }
    for (const match of matches) {
      const rawPath = match[2];
      if (/^[a-z]+:\/\//i.test(rawPath)) { problems.push(`远程图片不导入：${rawPath}`); continue; }
      const resolved = resolve(rawPath);
      if ("problem" in resolved) { problems.push(resolved.problem); continue; }
      let data: Buffer;
      try {
        if (!statSync(resolved.path).isFile()) throw new Error("not file");
        data = readFileSync(resolved.path);
      } catch {
        problems.push(`缺图：${rawPath}`);
        continue;
      }
      if (data.length === 0 || data.length > 5 * 1024 * 1024) { problems.push(`图片为空或超过 5 MiB：${rawPath}`); continue; }
      if (imageMime(data) === undefined) { problems.push(`图片格式不支持：${rawPath}`); continue; }
      const id = sha256(data);
      if (!seen.has(id)) {
        seen.add(id);
        images.push({ id, path: resolved.path, alt: match[1] });
      }
      blocks.push({ type: "image", id, alt: match[1] });
    }
  }
  return { blocks, images, problems };
}

export interface SubSegment {
  number: number | null;
  lines: string[];
}

/** 第一个 `（1）` 前的文字归题组指令；无小问标签时整段作唯一小问。 */
export function splitSubLabels(text: string): { stem: string[]; segments: SubSegment[] } {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const stem: string[] = [];
  const segments: SubSegment[] = [];
  let current: SubSegment | null = null;
  for (const line of lines) {
    const match = /^\s*[（(]\s*(\d+)\s*[）)]\s*(.*)$/.exec(line);
    if (match) {
      if (current) segments.push(current);
      current = { number: Number(match[1]), lines: match[2] ? [match[2]] : [] };
    } else if (current) {
      current.lines.push(line);
    } else {
      stem.push(line);
    }
  }
  if (current) segments.push(current);
  if (segments.length === 0) return { stem: [], segments: [{ number: 1, lines }] };
  return { stem, segments };
}

/** 提取并移除 `（N分）`；同一小问只取第一处。 */
export function extractScore(lines: string[]): { lines: string[]; score: number | null } {
  let score: number | null = null;
  const cleaned = lines.map((line) => {
    if (score !== null) return line;
    const match = /[（(]\s*(\d+(?:\.\d+)?)\s*分\s*[）)]/.exec(line);
    if (!match) return line;
    score = Number(match[1]);
    return line.replace(match[0], "").trim();
  });
  return { lines: cleaned, score };
}

/** 连续 A、B… 选项行从题干移出；少于两项时不当作选项。 */
export function extractOptions(lines: string[]): { lines: string[]; options: { label: string; text: string }[] } {
  const matches = lines.map((line) => /^\s*([A-H])[.．、]\s*(.*)$/.exec(line));
  const found = matches.flatMap((match) => match ? [match] : []);
  if (found.length < 2) return { lines, options: [] };
  const labels = found.map((match) => match[1]);
  const expected = labels.map((_, index) => String.fromCharCode(65 + index));
  if (labels.join("") !== expected.join("")) return { lines, options: [] };
  const kept: string[] = [];
  const options: { label: string; text: string }[] = [];
  lines.forEach((line, index) => {
    const match = matches[index];
    if (match) options.push({ label: match[1], text: match[2] });
    else kept.push(line);
  });
  return { lines: kept, options };
}

export function blocksText(blocks: QuestionBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.type === "paragraph") {
      for (const run of block.runs) {
        if (run.type === "text") parts.push(run.text);
        else if (run.type === "formula") parts.push(run.latex);
        else parts.push(run.fallback);
      }
    } else if (block.type === "formula") parts.push(block.latex);
    else if (block.type === "image") parts.push(block.alt);
    else parts.push(block.rows.flat().join(" "));
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

export function normaliseNumber(value: string): string {
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return String(Number(trimmed));
  const digits = /(\d+)(?!.*\d)/.exec(trimmed);
  return digits ? String(Number(digits[1])) : "";
}
