import type { AiFigureRef, AiMaterialSuggestion, AiQuestion, AiSourceAnchor } from "./ai";
import { blankOption, blankSubQuestion, type IntakeBlock, type IntakeForm, type IntakeSubQuestion } from "./intake";
import type { Classification } from "./question";

export interface AiIntakeEvidence {
  anchors: AiSourceAnchor[];
  materialAnchors: AiSourceAnchor[];
  figures: AiFigureRef[];
  answerSources: string[];
}

export interface AiIntakeResult {
  form: IntakeForm;
  uncertain: string[];
  materials: AiMaterialSuggestion[];
  newTags: string[];
  evidence: AiIntakeEvidence;
}

export const aiSlotHint = "作答位置需手工录入：AI 不生成空位，请在表单中补录。";
const textBlock = (text: string): IntakeBlock[] => text.trim() ? [{ kind: "text", text }] : [];

function partSub(part: NonNullable<AiQuestion["parts"]>[number], index: number): IntakeSubQuestion {
  const label = part.label.trim() || `(${index + 1})`;
  return {
    ...blankSubQuestion(),
    originalLabel: label,
    prompt: textBlock(part.prompt),
    answer: textBlock(part.answer),
    explanation: textBlock(part.explanation),
    options: part.options.map((option) => blankOption(option)),
    originalScore: part.score === null ? "" : String(part.score),
  };
}

/** AI 结构化题映射到录题表单；不确定项、新材料与新标签单独返回，由教师确认后再写入。 */
export function aiQuestionToIntake(
  question: AiQuestion,
  classification: Classification,
  section: string,
  tagCandidates: string[] = [],
): AiIntakeResult {
  const parts = question.parts ?? [];
  const legacy = parts.length === 0 && question.subquestions.length > 0;
  const single = parts.length === 0 && question.subquestions.length === 0;
  const topAnswer = question.answer?.trim() ?? "";
  const answerNotes: string[] = [];
  if (topAnswer && legacy) answerNotes.push(`整题答案未能对应到具体小问，请核对：${topAnswer}`);
  let subs: IntakeSubQuestion[];
  if (parts.length > 0) {
    subs = parts.map(partSub);
    if (topAnswer) {
      const answered = parts.filter((part) => part.answer.trim()).length;
      if (parts.length === 1 && answered === 0) {
        subs[0] = { ...subs[0], answer: textBlock(topAnswer) };
      } else if (answered === 0) {
        answerNotes.push(`整题答案未能对应到具体小问，请核对：${topAnswer}`);
      } else {
        answerNotes.push(`模型同时返回整题答案和小问答案，请核对：${topAnswer}`);
      }
    }
  } else if (legacy) {
    subs = question.subquestions.map((prompt, index) => ({
      ...blankSubQuestion(),
      originalLabel: `(${index + 1})`,
      prompt: textBlock(prompt),
      options: index === 0 ? question.options.map((option) => blankOption(option)) : [],
    }));
  } else {
    subs = [{ ...blankSubQuestion(), prompt: textBlock(question.stem), answer: textBlock(topAnswer) }];
  }
  const candidates = new Set(tagCandidates.map((point) => point.trim()).filter(Boolean));
  const knowledgePoints = [...new Set(classification.knowledgePoints.map((point) => point.trim()).filter(Boolean))];
  const newTags: string[] = [];
  for (const tag of [...question.tags, ...(question.knowledgePoints ?? [])].map((point) => point.trim()).filter(Boolean)) {
    if (knowledgePoints.includes(tag) || newTags.includes(tag)) continue;
    if (candidates.has(tag)) knowledgePoints.push(tag);
    else newTags.push(tag);
  }
  const evidence: AiIntakeEvidence = {
    anchors: question.sourceAnchors ?? [],
    materialAnchors: (question.materials ?? []).flatMap((material) => material.sourceAnchors ?? []),
    figures: question.figures ?? [],
    answerSources: [
      ...(question.answerSource?.trim() ? [`整题：${question.answerSource.trim()}`] : []),
      ...parts.flatMap((part) => part.answerSource?.trim() ? [`${part.label.trim() || "?"}：${part.answerSource.trim()}`] : []),
    ],
  };
  const uncertain = [
    ...question.uncertain,
    ...answerNotes,
    ...parts.flatMap((part) => part.uncertain.map((item) => `第${part.label || "?"}小问：${item}`)),
    ...(question.figures ?? []).map((figure) => `题图引用待裁切：第 ${figure.page} 页（${figure.kind}）。`),
    ...(question.fieldUncertain ?? []).map((entry) => `字段待核（${entry.field}）：${entry.note}`),
    aiSlotHint,
  ];
  return {
    form: {
      stem: single ? [] : textBlock(question.stem),
      subQuestions: subs,
      materials: [],
      selection: { mode: "all" },
      source: {
        section,
        pdfPage: String(question.page),
        originalNumber: question.originalNumber?.trim() ?? "",
      },
      classification: {
        ...classification,
        questionType: question.questionType?.trim() || classification.questionType,
        knowledgePoints,
      },
    },
    uncertain,
    materials: question.materials ?? [],
    newTags,
    evidence,
  };
}
