import { lstatSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { ImportCandidate } from "./import-candidate";
import {
  blocksText,
  extractOptions,
  extractScore,
  inside,
  listValue,
  markdownBlocks,
  normaliseNumber,
  parseFrontmatter,
  sha256,
  splitSections,
  splitSubLabels,
  textValue,
  walk,
  type ParsedImage,
} from "./import-parse";
import type { Classification, QuestionBlock, QuestionContent, SubQuestion } from "../shared/question";

const MATH_DEFAULT: Classification = {
  stage: "初中",
  subject: "数学",
  grade: "九年级",
  examType: "",
  year: "",
  sourceName: "",
  questionType: "",
  knowledgePoints: [],
};

const PROOFREAD_KEY = "M2023-NCZK-025";
const NON_TYPE_DIRECTORIES = new Set(["by-topic", "by-year", "archive", "manifests", "templates", "references", "passages", "images"]);

function groupSection(text: string): Map<number, string[]> {
  const { stem, segments } = splitSubLabels(text);
  const lines = new Map<number, string[]>();
  for (const segment of segments) {
    const key = segment.number ?? 1;
    lines.set(key, [...(lines.get(key) ?? []), ...segment.lines]);
  }
  const extra = stem.map((line) => line.trim()).filter(Boolean);
  if (extra.length > 0) lines.set(1, [...extra, ...(lines.get(1) ?? [])]);
  return lines;
}

function emptyCandidate(sourceKey: string, reason: string): ImportCandidate {
  return {
    sourceKey,
    sourceHash: sha256(`failed:${sourceKey}`),
    title: sourceKey,
    section: "未识别",
    pdfPage: 1,
    originalNumber: "",
    classification: { ...MATH_DEFAULT },
    preview: "",
    reasons: [reason],
    blocked: true,
    needsProofread: false,
    images: [],
    materials: [],
  };
}

/** 同一题号可能同时出现在题型目录、by-topic 与 by-year；题型目录优先。 */
function filePriority(wiki: string, file: string): number {
  const parts = file.slice(wiki.length + 1).split("/");
  const first = parts[0];
  if (first === "by-year") return 3;
  if (first === "by-topic") return 2;
  if (NON_TYPE_DIRECTORIES.has(first)) return 4;
  return 1;
}

export function scanMathVault(root: string): ImportCandidate[] {
  let stats;
  try { stats = lstatSync(root); } catch { throw new Error("mathVault 根目录不存在"); }
  if (!stats.isDirectory()) throw new Error("mathVault 根目录无效");
  const wiki = join(root, "wiki");
  const files = walk(wiki, (name) => /^M.*\.md$/.test(name));
  if (files.length === 0) throw new Error("未找到 mathVault 题目（wiki/**/M*.md）");
  const byName = new Map<string, string>();
  for (const file of files.sort((left, right) => filePriority(wiki, left) - filePriority(wiki, right))) {
    const name = basename(file);
    if (!byName.has(name)) byName.set(name, file);
  }
  return [...byName.values()].map((file) => {
    try {
      return parseQuestion(wiki, file);
    } catch (error) {
      return emptyCandidate(`mathvault:${basename(file, ".md")}`, `解析失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }).sort((left, right) => left.sourceKey.localeCompare(right.sourceKey));
}

function parseQuestion(wiki: string, file: string): ImportCandidate {
  const bytes = readFileSync(file);
  const frontmatter = parseFrontmatter(bytes.toString("utf8"));
  const fallbackId = basename(file, ".md");
  if (frontmatter.problem) return emptyCandidate(`mathvault:${fallbackId}`, `解析失败：${frontmatter.problem}`);
  const id = textValue(frontmatter.data["题目编号"]) || fallbackId;
  const sourceKey = `mathvault:${id}`;
  const reasons: string[] = ["页码待补（按第 1 页）"];
  const problems: string[] = [];
  const images: ParsedImage[] = [];
  const imageIds = new Set<string>();
  const resolveImage = (raw: string) => {
    const direct = resolve(dirname(file), raw);
    if (inside(wiki, direct)) return { path: direct };
    const fallback = join(wiki, "images", basename(raw));
    if (inside(wiki, fallback)) return { path: fallback };
    return { problem: `图片越出 mathVault 目录：${raw}` };
  };
  const addImages = (found: ParsedImage[]) => {
    for (const image of found) {
      if (imageIds.has(image.id)) continue;
      imageIds.add(image.id);
      images.push(image);
    }
  };
  const parseBlocks = (value: string): QuestionBlock[] => {
    const result = markdownBlocks(value, resolveImage);
    addImages(result.images);
    problems.push(...result.problems);
    return result.blocks;
  };

  const sections = splitSections(frontmatter.body);
  const bodyText = sections.get("题目正文")?.trim() ?? "";
  if (!bodyText) return { ...emptyCandidate(sourceKey, "解析失败：缺少题目正文"), legacyStatus: textValue(frontmatter.data["审核状态"]) || undefined };

  const questionType = textValue(frontmatter.data["题型"]);
  const grade = textValue(frontmatter.data["年级"]) || "九年级";
  const stageValue = textValue(frontmatter.data["学段"]);
  const stage = stageValue === "小学" || stageValue === "高中" ? stageValue : "初中";
  const section = textValue(frontmatter.data["板块"]) || questionType || "数学";
  const classification: Classification = {
    ...MATH_DEFAULT,
    stage,
    grade,
    examType: questionType,
    year: textValue(frontmatter.data["年份"]),
    sourceName: textValue(frontmatter.data["来源"]),
    questionType,
    knowledgePoints: [...new Set([
      ...listValue(frontmatter.data["知识点一级"]),
      ...listValue(frontmatter.data["知识点二级"]),
      ...listValue(frontmatter.data["核心素养"]),
    ].filter(Boolean))],
  };

  const bodyLines = bodyText.split("\n");
  let numberMatch: RegExpExecArray | null = null;
  for (let index = 0; index < bodyLines.length; index += 1) {
    const match = /^\s*(\d+)[.．、]\s*(.*)$/.exec(bodyLines[index]);
    if (match) { numberMatch = match; bodyLines[index] = match[2]; break; }
    if (bodyLines[index].trim()) break;
  }
  const originalNumber = numberMatch ? String(Number(numberMatch[1])) : normaliseNumber(id);
  if (!originalNumber) problems.push("缺少原题号（正文首行与题目编号都没有数字）");

  const stemGroup = splitSubLabels(bodyLines.join("\n"));
  const stemBlocks = stemGroup.stem.length > 0 ? parseBlocks(stemGroup.stem.join("\n")) : [];
  const answers = groupSection(sections.get("答案") ?? "");
  const explanations = groupSection(sections.get("解析") ?? "");
  for (const key of answers.keys()) if (key > stemGroup.segments.length) problems.push(`答案小问号不匹配：（${key}）`);
  for (const key of explanations.keys()) if (key > stemGroup.segments.length) problems.push(`解析小问号不匹配：（${key}）`);

  const subQuestions: SubQuestion[] = stemGroup.segments.map((segment, index) => {
    const scored = extractScore(segment.lines);
    if (scored.score === null) reasons.push(`第（${segment.number ?? index + 1}）问分值待补`);
    const optioned = extractOptions(scored.lines);
    return {
      id: `sub-${index + 1}`,
      originalLabel: `（${segment.number ?? index + 1}）`,
      prompt: parseBlocks(optioned.lines.join("\n")),
      explanation: parseBlocks((explanations.get(index + 1) ?? []).join("\n")),
      options: optioned.options.map((option) => ({ label: option.label, content: parseBlocks(option.text) })),
      slots: [],
      answers: (() => {
        const blocks = parseBlocks((answers.get(index + 1) ?? []).join("\n"));
        return blocks.length > 0 ? [{ slotId: null, blocks, variants: [] }] : [];
      })(),
      scoring: [],
      originalScore: scored.score,
      materialIds: [],
      dependsOn: [],
    };
  });

  const seenFigures = new Set(imageIds);
  const figureBlocks: QuestionBlock[] = [];
  for (const raw of listValue(frontmatter.data["配图"])) {
    const resolved = resolveFigure(wiki, raw);
    if ("problem" in resolved) { problems.push(resolved.problem); continue; }
    let data: Buffer;
    try { data = readFileSync(resolved.path); } catch { problems.push(`缺图：${raw}`); continue; }
    if (data.length === 0 || data.length > 5 * 1024 * 1024) { problems.push(`图片为空或超过 5 MiB：${raw}`); continue; }
    const idValue = sha256(data);
    if (seenFigures.has(idValue)) continue;
    seenFigures.add(idValue);
    const block: QuestionBlock = { type: "image", id: idValue, alt: `配图：${basename(raw)}` };
    images.push({ id: idValue, path: resolved.path, alt: block.alt });
    figureBlocks.push(block);
  }
  if (figureBlocks.length > 0 && subQuestions[0]) subQuestions[0].prompt.push(...figureBlocks);

  const preview = [blocksText(stemBlocks), blocksText(subQuestions[0]?.prompt ?? [])].filter(Boolean).join(" ").slice(0, 120);
  const content: QuestionContent = {
    stem: stemBlocks,
    subQuestions,
    materials: [],
    selection: { mode: "all" },
    source: { section: section || "数学", pdfPage: 1, originalNumber: originalNumber || "1" },
  };
  const needsProofread = id === PROOFREAD_KEY && !proofreadSatisfied(bodyText);
  if (needsProofread) reasons.push("待校勘：缺少「直线 KD」排除条件或第（3）问未要求探究定值并说明理由");
  const sourceHash = sha256([bytes, ...images.map((image) => `image:${image.id}`)].join("\n"));
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
    needsProofread,
    content,
    images,
    materials: [],
  };
}

function resolveFigure(wiki: string, raw: string): { path: string } | { problem: string } {
  const cleaned = raw.replace(/^["']|["']$/g, "").trim();
  if (!cleaned) return { problem: "配图路径为空" };
  const candidates = cleaned.startsWith("images/")
    ? [join(wiki, cleaned)]
    : cleaned.includes("/")
      ? [join(wiki, cleaned), join(wiki, "images", basename(cleaned))]
      : [join(wiki, "images", cleaned)];
  for (const candidate of candidates) {
    if (inside(wiki, candidate)) return { path: candidate };
  }
  return { problem: `配图越出 mathVault 目录：${raw}` };
}

/** 第 25 题校勘：排除条件与探究定值设问必须同时存在。 */
function proofreadSatisfied(text: string): boolean {
  const exclusion = /直线\s*KD/.test(text);
  const explore = /探究/.test(text) && /定值/.test(text) && /理由/.test(text);
  return exclusion && explore;
}
