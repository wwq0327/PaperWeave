import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import {
  blocksText,
  extractOptions,
  extractScore,
  listValue,
  markdownBlocks,
  normaliseNumber,
  parseFrontmatter,
  sha256,
  splitSections,
  splitSubLabels,
  textValue,
  type FrontmatterValue,
  type ParsedImage,
} from "./import-parse";
import type { Classification, QuestionBlock, QuestionContent, SubQuestion } from "../shared/question";

export interface ImportMaterialSpec {
  key: string;
  placeholderId: string;
  title: string;
  content: QuestionBlock[];
  source: string;
  hash: string;
}

export interface TikuCandidate {
  sourceKey: string;
  sourceHash: string;
  title: string;
  section: string;
  pdfPage: number;
  originalNumber: string;
  classification: Classification;
  preview: string;
  reasons: string[];
  legacyStatus?: string;
  blocked: boolean;
  content?: QuestionContent;
  images: ParsedImage[];
  materials: ImportMaterialSpec[];
}

const KNOWLEDGE_DEFAULT: Classification = {
  stage: "初中",
  subject: "语文",
  grade: "九年级",
  examType: "",
  year: "",
  sourceName: "",
  questionType: "",
  knowledgePoints: [],
};

function walk(directory: string, match: (name: string) => boolean): string[] {
  const files: string[] = [];
  let entries;
  try { entries = readdirSync(directory, { withFileTypes: true }); } catch { return files; }
  for (const entry of entries) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(full, match));
    else if (entry.isFile() && match(entry.name)) files.push(full);
  }
  return files;
}

function inside(root: string, path: string): boolean {
  const base = resolve(root);
  const target = resolve(path);
  return target === base || target.startsWith(base + sep);
}

function passageNames(value: FrontmatterValue | undefined): string[] {
  const raw = Array.isArray(value) ? value.join("\n") : typeof value === "string" ? value : "";
  const names: string[] = [];
  for (const match of raw.matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g)) names.push(match[1].trim());
  if (names.length === 0) {
    for (const item of listValue(value)) {
      const cleaned = item.replace(/^\[\[|\]\]$/g, "").trim();
      if (cleaned && cleaned !== "null") names.push(cleaned);
    }
  }
  return [...new Set(names.filter(Boolean))];
}

interface GroupedSection {
  lines: Map<number, string[]>;
  extra: string[];
}

/** 答案／解析按小问号分组；没有标签时整段归第 1 小问。 */
function groupSection(text: string): GroupedSection {
  const { stem, segments } = splitSubLabels(text);
  const lines = new Map<number, string[]>();
  for (const segment of segments) {
    const key = segment.number ?? 1;
    lines.set(key, [...(lines.get(key) ?? []), ...segment.lines]);
  }
  const extra = stem.map((line) => line.trim()).filter(Boolean);
  if (extra.length > 0) lines.set(1, [...extra, ...(lines.get(1) ?? [])]);
  return { lines, extra };
}

function emptyCandidate(sourceKey: string, reason: string): TikuCandidate {
  return {
    sourceKey,
    sourceHash: sha256(`failed:${sourceKey}`),
    title: sourceKey,
    section: "未识别",
    pdfPage: 1,
    originalNumber: "",
    classification: { ...KNOWLEDGE_DEFAULT },
    preview: "",
    reasons: [reason],
    blocked: true,
    images: [],
    materials: [],
  };
}

export function scanTiku(root: string): TikuCandidate[] {
  let stats;
  try { stats = lstatSync(root); } catch { throw new Error("Tiku 根目录不存在"); }
  if (!stats.isDirectory()) throw new Error("Tiku 根目录无效");
  const wiki = join(root, "wiki");
  const byType = join(wiki, "by-type");
  const questionFiles = walk(byType, (name) => /^Q.*\.md$/.test(name));
  if (questionFiles.length === 0) throw new Error("未找到 Tiku 题目（wiki/by-type/**/Q*.md）");
  const passages = new Map<string, string>();
  for (const file of walk(join(wiki, "passages"), (name) => name.endsWith(".md"))) {
    const key = basename(file, ".md");
    if (!passages.has(key)) passages.set(key, file);
  }
  const candidates = questionFiles.map((file) => {
    try {
      return parseQuestion(wiki, file, passages);
    } catch (error) {
      return emptyCandidate(basename(file, ".md"), `解析失败：${error instanceof Error ? error.message : String(error)}`);
    }
  });
  return candidates.sort((left, right) => left.sourceKey.localeCompare(right.sourceKey));
}

function parseQuestion(wiki: string, file: string, passages: Map<string, string>): TikuCandidate {
  const bytes = readFileSync(file);
  const text = bytes.toString("utf8");
  const frontmatter = parseFrontmatter(text);
  const fallbackKey = basename(file, ".md");
  if (frontmatter.problem) return emptyCandidate(fallbackKey, `解析失败：${frontmatter.problem}`);
  const sourceKey = textValue(frontmatter.data["题目编号"]) || fallbackKey;
  const reasons: string[] = ["页码待补（按第 1 页）"];
  const problems: string[] = [];
  const images: ParsedImage[] = [];
  const resolveImage = (raw: string) => {
    const target = resolve(dirname(file), raw);
    if (!inside(wiki, target)) return { problem: `图片越出 Tiku 目录：${raw}` };
    return { path: target };
  };
  const parseBlocks = (value: string): QuestionBlock[] => {
    const result = markdownBlocks(value, resolveImage);
    images.push(...result.images);
    problems.push(...result.problems);
    return result.blocks;
  };

  const sections = splitSections(frontmatter.body);
  const bodyText = sections.get("题目正文")?.trim() ?? "";
  if (!bodyText) return { ...emptyCandidate(sourceKey, "解析失败：缺少题目正文"), legacyStatus: textValue(frontmatter.data["审核状态"]) || undefined };

  const relative = file.slice(wiki.length + 1).split(sep);
  const typeFolder = relative[0] === "by-type" ? relative[1] : relative[0];
  const section = textValue(frontmatter.data["板块"]) || typeFolder?.replace(/^\d+-/, "") || "Tiku";
  const questionType = textValue(frontmatter.data["题型"]);
  const knowledgePoints = [
    ...listValue(frontmatter.data["知识点一级"]),
    ...listValue(frontmatter.data["知识点二级"]),
    ...listValue(frontmatter.data["tags"]),
  ].filter(Boolean);
  const classification: Classification = {
    ...KNOWLEDGE_DEFAULT,
    examType: questionType,
    year: textValue(frontmatter.data["年份"]),
    sourceName: textValue(frontmatter.data["来源"]),
    questionType,
    knowledgePoints: [...new Set(knowledgePoints)],
  };

  const bodyLines = bodyText.split("\n");
  let numberMatch: RegExpExecArray | null = null;
  for (let index = 0; index < bodyLines.length; index += 1) {
    const match = /^\s*(\d+)[.．、]\s*(.*)$/.exec(bodyLines[index]);
    if (match) { numberMatch = match; bodyLines[index] = match[2]; break; }
    if (bodyLines[index].trim()) break;
  }
  const originalNumber = numberMatch ? String(Number(numberMatch[1])) : normaliseNumber(sourceKey);
  if (!originalNumber) problems.push("缺少原题号（正文首行与题目编号都没有数字）");

  const stemGroup = splitSubLabels(bodyLines.join("\n"));
  const stemBlocks = stemGroup.stem.length > 0 ? parseBlocks(stemGroup.stem.join("\n")) : [];

  const answers = groupSection(sections.get("答案") ?? "");
  const explanations = groupSection(sections.get("解析") ?? "");
  for (const key of answers.lines.keys()) if (key > stemGroup.segments.length) problems.push(`答案小问号不匹配：（${key}）`);
  for (const key of explanations.lines.keys()) if (key > stemGroup.segments.length) problems.push(`解析小问号不匹配：（${key}）`);

  const materials: ImportMaterialSpec[] = [];
  const materialRefs: { materialId: string; versionId: string }[] = [];
  for (const name of passageNames(frontmatter.data["关联Passage"])) {
    const passageFile = passages.get(name);
    if (!passageFile) { problems.push(`材料失链：${name}`); continue; }
    const passageBytes = readFileSync(passageFile);
    const passageText = passageBytes.toString("utf8");
    const passageFrontmatter = parseFrontmatter(passageText);
    const passageImages: ParsedImage[] = [];
    const passageProblems: string[] = [];
    const passageBlocks = markdownBlocks(passageFrontmatter.body, (raw) => {
      const target = resolve(dirname(passageFile), raw);
      if (!inside(wiki, target)) return { problem: `图片越出 Tiku 目录：${raw}` };
      return { path: target };
    });
    passageImages.push(...passageBlocks.images);
    passageProblems.push(...passageBlocks.problems);
    images.push(...passageImages);
    problems.push(...passageProblems);
    const placeholderId = `mat-${sha256(`tiku:${name}`).slice(0, 24)}`;
    const title = textValue(passageFrontmatter.data["passage_title"]) || name;
    const hash = sha256([passageBytes, ...passageImages.map((image) => image.id)].join("\n"));
    materials.push({ key: name, placeholderId, title, content: passageBlocks.blocks, source: `Tiku passages/${name}.md`, hash });
    materialRefs.push({ materialId: placeholderId, versionId: placeholderId });
  }

  const subQuestions: SubQuestion[] = stemGroup.segments.map((segment, index) => {
    const scored = extractScore(segment.lines);
    const optioned = extractOptions(scored.lines);
    const prompt = parseBlocks(optioned.lines.join("\n"));
    const options = optioned.options.map((option) => ({ label: option.label, content: parseBlocks(option.text) }));
    const answerLines = answers.lines.get(index + 1) ?? [];
    const answerBlocks = parseBlocks(answerLines.join("\n"));
    const explanationBlocks = parseBlocks((explanations.lines.get(index + 1) ?? []).join("\n"));
    return {
      id: `sub-${index + 1}`,
      originalLabel: `（${segment.number ?? index + 1}）`,
      prompt,
      explanation: explanationBlocks,
      options,
      slots: [],
      answers: answerBlocks.length > 0 ? [{ slotId: null, blocks: answerBlocks, variants: [] }] : [],
      scoring: [],
      originalScore: scored.score,
      materialIds: materialRefs.map((ref) => ref.materialId),
      dependsOn: [],
    };
  });

  const preview = [blocksText(stemBlocks), blocksText(subQuestions[0]?.prompt ?? [])].filter(Boolean).join(" ").slice(0, 120);
  const content: QuestionContent = {
    stem: stemBlocks,
    subQuestions,
    materials: materialRefs,
    selection: { mode: "all" },
    source: { section: section || "Tiku", pdfPage: 1, originalNumber: originalNumber || "1" },
  };
  const sourceHash = sha256([
    bytes,
    ...materials.map((material) => `material:${material.key}:${material.hash}`),
    ...images.map((image) => `image:${image.id}`),
  ].join("\n"));
  reasons.push(...problems);
  return {
    sourceKey,
    sourceHash,
    title: `${section} 第 ${originalNumber || "?"} 题 · ${preview.slice(0, 40)}`,
    section,
    pdfPage: 1,
    originalNumber,
    classification,
    preview,
    reasons,
    legacyStatus: textValue(frontmatter.data["审核状态"]) || undefined,
    blocked: problems.length > 0,
    content,
    images,
    materials,
  };
}
