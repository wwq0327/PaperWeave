import { selectionScore, type QuestionBlock, type QuestionContent, type ScoringPoint } from "./question";

/** 卷内评分数据；needsAdjustment 由卷内分值与评分数据推导，不落库。 */
export type PaperScoring =
  | { mode: "original" }
  | { mode: "adjusted"; points: ScoringPoint[] }
  | { mode: "answerOnly"; note?: string };

export type PaperScoringState = "original" | "needsAdjustment" | "adjusted" | "answerOnly";

export type BlankSpace = "none" | "small" | "medium" | "large";

export interface PaperDefaultScore {
  score: number;
  conflict: string | null;
}

export interface ScoreConflict {
  /** 冲突所在小问；题组题干为 null。 */
  subQuestionId: string | null;
  value: number;
  text: string;
  key: string;
}

export type PendingCheckKind = "textReference" | "imageScore";

/** 定稿前需教师逐项确认的待核项；key 含内容指纹，内容或卷内分值变化后旧确认失效。 */
export interface PendingCheck {
  kind: PendingCheckKind;
  /** 所在小问；题组题干、材料与整题项为 null。 */
  subQuestionId: string | null;
  text: string;
  key: string;
}

export interface PendingMaterial {
  materialId: string;
  content: QuestionBlock[];
}

const roundScore = (value: number) => Math.round(value * 100) / 100;

/** 整题取组选答后的 selectionScore；小问集合取所选小问原分值合计，缺失要求补填。 */
export function paperDefaultScore(content: QuestionContent, subQuestionIds: string[]): PaperDefaultScore {
  const allSelected =
    subQuestionIds.length === content.subQuestions.length && content.subQuestions.every((sub) => subQuestionIds.includes(sub.id));
  if (allSelected) {
    const summary = selectionScore(content);
    return { score: summary.total, conflict: summary.conflict };
  }
  let total = 0;
  for (const id of subQuestionIds) {
    const sub = content.subQuestions.find((item) => item.id === id);
    if (!sub) return { score: 0, conflict: "小问不存在" };
    if (sub.originalScore === null) return { score: 0, conflict: "原分值缺失，请补填" };
    total += sub.originalScore;
  }
  return { score: roundScore(total), conflict: null };
}

export function paperScoringState(score: number, defaultScore: number, scoring: PaperScoring): PaperScoringState {
  if (scoring.mode === "answerOnly") return "answerOnly";
  if (scoring.mode === "adjusted") {
    const total = roundScore(scoring.points.reduce((sum, point) => sum + point.score, 0));
    return total === score ? "adjusted" : "needsAdjustment";
  }
  return score === defaultScore ? "original" : "needsAdjustment";
}

function blockText(block: QuestionBlock): string[] {
  if (block.type === "paragraph") return block.runs.map((run) => (run.type === "text" ? run.text : run.type === "reference" ? run.fallback : ""));
  if (block.type === "table") return block.rows.flat();
  if (block.type === "image") return block.alt ? [block.alt] : [];
  return [];
}

function subQuestionBlocks(sub: QuestionContent["subQuestions"][number]): QuestionBlock[] {
  return [
    ...sub.prompt,
    ...sub.options.flatMap((option) => option.content),
    ...sub.answers.flatMap((answer) => answer.blocks),
    ...sub.explanation,
  ];
}

/** 扫描题组题干与所选小问文字中的「N 分」，命中题库原分值且不等于卷内分值时列为冲突。 */
export function scoreConflicts(content: QuestionContent, subQuestionIds: string[], score: number): ScoreConflict[] {
  const selected = content.subQuestions.filter((sub) => subQuestionIds.includes(sub.id));
  const conflicts: ScoreConflict[] = [];
  const seen = new Set<string>();
  const scan = (blocks: QuestionBlock[], originals: Set<number>, subQuestionId: string | null) => {
    for (const text of blocks.flatMap(blockText)) {
      for (const match of text.matchAll(/(\d+(?:\.\d+)?)\s*分/g)) {
        const value = Number(match[1]);
        if (!originals.has(value) || value === score) continue;
        const key = `${subQuestionId ?? "item"}|${value}|${match[0]}`;
        if (seen.has(key)) continue;
        seen.add(key);
        conflicts.push({ subQuestionId, value, text: match[0], key });
      }
    }
  };

  if (content.stem.length > 0) {
    const originals = new Set<number>();
    for (const sub of selected) if (sub.originalScore !== null) originals.add(sub.originalScore);
    const summary = paperDefaultScore(content, subQuestionIds);
    if (summary.conflict === null && summary.score > 0) originals.add(summary.score);
    if (originals.size > 0) scan(content.stem, originals, null);
  }
  for (const sub of selected) {
    if (sub.originalScore === null) continue;
    scan(subQuestionBlocks(sub), new Set([sub.originalScore]), sub.id);
  }
  return conflicts;
}

/** 题号、图号、材料号的文字引用样式；结构化 reference 节点不走此扫描。 */
const textReferencePattern = /第\s*[（(]?\s*\d+\s*[）)]?\s*(?:小)?问|第\s*\d+\s*题|[（(]\s*\d+\s*[）)]\s*[中内]|(?:如|见|由|根据)\s*[上下左右]?\s*图\s*\d*|[上下左右]\s*图\s*\d*|图\s*\d+|材料\s*(?:[一二三四五六七八九十]+|\d+)/g;

function textRuns(blocks: QuestionBlock[]): string[] {
  const texts: string[] = [];
  for (const block of blocks) {
    if (block.type === "paragraph") {
      for (const run of block.runs) if (run.type === "text") texts.push(run.text);
    } else if (block.type === "table") {
      texts.push(...block.rows.flat());
    }
  }
  return texts;
}

/** 内容指纹只用于让确认记录随内容或卷内分值变化失效，不需要密码学强度。 */
function contentFingerprint(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/** 收集未结构化的文字引用，以及含图题改分后的图片旧分值人工核对项。 */
export function pendingChecks(content: QuestionContent, subQuestionIds: string[], score: number, materials: PendingMaterial[] = []): PendingCheck[] {
  const selected = content.subQuestions.filter((sub) => subQuestionIds.includes(sub.id));
  const fingerprint = contentFingerprint(JSON.stringify({
    score,
    stem: content.stem,
    subQuestions: selected.map((sub) => ({
      id: sub.id,
      label: sub.originalLabel,
      prompt: sub.prompt,
      options: sub.options,
      answers: sub.answers,
      explanation: sub.explanation,
    })),
    materials: materials.map((material) => ({ id: material.materialId, content: material.content })),
  }));
  const checks: PendingCheck[] = [];
  const seen = new Set<string>();
  const scan = (blocks: QuestionBlock[], subQuestionId: string | null, scope: string) => {
    for (const text of textRuns(blocks)) {
      for (const match of text.matchAll(textReferencePattern)) {
        const key = `ref|${fingerprint}|${scope}|${match[0]}`;
        if (seen.has(key)) continue;
        seen.add(key);
        checks.push({ kind: "textReference", subQuestionId, text: match[0], key });
      }
    }
  };

  scan(content.stem, null, "item");
  for (const sub of selected) {
    for (const blocks of [sub.prompt, ...sub.options.map((option) => option.content), ...sub.answers.map((answer) => answer.blocks), sub.explanation]) {
      scan(blocks, sub.id, sub.id);
    }
  }
  for (const material of materials) scan(material.content, null, `material:${material.materialId}`);

  const hasImage = [...content.stem, ...selected.flatMap(subQuestionBlocks)].some((block) => block.type === "image");
  if (hasImage && score !== paperDefaultScore(content, subQuestionIds).score) {
    checks.push({ kind: "imageScore", subQuestionId: null, text: "图片中的旧分值需人工核对", key: `image|${fingerprint}` });
  }
  return checks;
}
