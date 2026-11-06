import type { AiMaterialSuggestion, AiQuestion, AiSourceAnchor } from "./ai";

export interface WholePaperCandidate {
  batchIndex: number;
  questionIndex: number;
  question: AiQuestion;
}

export interface WholePaperGroup {
  members: WholePaperCandidate[];
  question: AiQuestion;
}

const unique = <T>(items: T[]): T[] => [...new Set(items)];
const anchorKey = (anchor: AiSourceAnchor) => `${anchor.page}:${anchor.start}:${anchor.end}`;
const anchorsOf = (question: AiQuestion): AiSourceAnchor[] => question.sourceAnchors ?? [];
const partLabel = (part: NonNullable<AiQuestion["parts"]>[number], index: number) => part.label.trim() || `(${index + 1})`;
const chooseText = (first: string, second: string): { text: string; conflict: boolean } => {
  const a = first.trim();
  const b = second.trim();
  if (!b || a === b) return { text: first, conflict: false };
  if (!a) return { text: second, conflict: false };
  if (a.includes(b)) return { text: first, conflict: false };
  if (b.includes(a)) return { text: second, conflict: false };
  return { text: a.length >= b.length ? first : second, conflict: true };
};

function mergeMaterials(first: AiMaterialSuggestion[], second: AiMaterialSuggestion[]): AiMaterialSuggestion[] {
  const merged = new Map<string, AiMaterialSuggestion>();
  for (const material of [...first, ...second]) {
    const key = `${material.title.trim()}|${material.content.trim()}`;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, { ...material });
      continue;
    }
    existing.appliesTo = unique([...(existing.appliesTo ?? []), ...(material.appliesTo ?? [])]);
    existing.sourceAnchors = [...new Map([...(existing.sourceAnchors ?? []), ...(material.sourceAnchors ?? [])].map((anchor) => [anchorKey(anchor), anchor])).values()];
    existing.source = existing.source || material.source;
  }
  return [...merged.values()];
}

function mergeQuestion(first: AiQuestion, second: AiQuestion): AiQuestion {
  const notes: string[] = [];
  const stem = chooseText(first.stem, second.stem);
  if (stem.conflict) notes.push("跨批题面已合并，请核对。");
  const firstParts = first.parts ?? [];
  const secondParts = second.parts ?? [];
  const labels: string[] = [];
  const parts = new Map<string, NonNullable<AiQuestion["parts"]>[number]>();
  [...firstParts, ...secondParts].forEach((part, index) => {
    const label = partLabel(part, index);
    const existing = parts.get(label);
    if (!existing) {
      labels.push(label);
      parts.set(label, { ...part, label });
      return;
    }
    const prompt = chooseText(existing.prompt, part.prompt);
    if (prompt.conflict) notes.push(`跨批小问 ${label} 题干已合并，请核对。`);
    const answer = chooseText(existing.answer, part.answer);
    if (answer.conflict) notes.push(`跨批小问 ${label} 答案不一致，请核对。`);
    const explanation = chooseText(existing.explanation, part.explanation);
    const score = existing.score !== null && part.score !== null && existing.score !== part.score ? null : (existing.score ?? part.score);
    if (existing.score !== null && part.score !== null && existing.score !== part.score) notes.push(`跨批小问 ${label} 原分值不一致，请核对。`);
    parts.set(label, {
      ...existing,
      prompt: prompt.text,
      answer: answer.text,
      explanation: explanation.text,
      score,
      options: unique([...existing.options, ...part.options]),
      uncertain: unique([...existing.uncertain, ...part.uncertain]),
      answerSource: existing.answerSource || part.answerSource,
    });
  });
  const answer = chooseText(first.answer ?? "", second.answer ?? "");
  if (answer.conflict) notes.push("跨批答案不一致，请核对。");
  const figures = [...new Map([...(first.figures ?? []), ...(second.figures ?? [])].map((figure) => [`${figure.page}:${figure.start}:${figure.end}:${figure.kind}`, figure])).values()];
  const scanAreas = [...new Map([...(first.scanAreas ?? []), ...(second.scanAreas ?? [])].map((area) => [`${area.page}:${area.rect.x}:${area.rect.y}:${area.rect.width}:${area.rect.height}`, area])).values()];
  const fieldNotes = [...new Map([...(first.fieldUncertain ?? []), ...(second.fieldUncertain ?? [])].map((entry) => [`${entry.field}:${entry.note}`, entry])).values()];
  return {
    ...first,
    stem: stem.text,
    page: Math.min(first.page, second.page),
    options: unique([...first.options, ...second.options]),
    subquestions: unique([...first.subquestions, ...second.subquestions]),
    tags: unique([...first.tags, ...second.tags]),
    knowledgePoints: unique([...(first.knowledgePoints ?? []), ...(second.knowledgePoints ?? [])]),
    uncertain: unique([...first.uncertain, ...second.uncertain, ...notes]),
    parts: labels.length > 0 ? labels.map((label) => parts.get(label) as NonNullable<AiQuestion["parts"]>[number]) : undefined,
    materials: mergeMaterials(first.materials ?? [], second.materials ?? []),
    answer: answer.text || undefined,
    answerSource: first.answerSource || second.answerSource,
    sourceAnchors: [...new Map([...anchorsOf(first), ...anchorsOf(second)].map((anchor) => [anchorKey(anchor), anchor])).values()],
    figures: figures.length > 0 ? figures : undefined,
    scanAreas: scanAreas.length > 0 ? scanAreas : undefined,
    fieldUncertain: fieldNotes.length > 0 ? fieldNotes : undefined,
    questionType: first.questionType || second.questionType,
  };
}

/** 只合并相邻批次且题号相同的候选；非相邻重复题号留给覆盖对账报告为重号异常。 */
export function mergeWholePaperQuestions(candidates: WholePaperCandidate[]): WholePaperGroup[] {
  const groups: WholePaperGroup[] = [];
  for (const candidate of candidates) {
    const previous = groups[groups.length - 1];
    const number = candidate.question.originalNumber?.trim();
    const previousNumber = previous?.question.originalNumber?.trim();
    const last = previous?.members[previous.members.length - 1];
    if (previous && last && number && number === previousNumber && last.batchIndex + 1 === candidate.batchIndex) {
      previous.members.push(candidate);
      previous.question = mergeQuestion(previous.question, candidate.question);
      continue;
    }
    groups.push({ members: [candidate], question: structuredClone(candidate.question) });
  }
  return groups;
}
