import type { AiMaterialSuggestion, AiQuestion } from "./ai";
import { blankSubQuestion, type IntakeBlock, type IntakeForm, type IntakeSubQuestion } from "./intake";
import type { Classification } from "./question";

export interface AiIntakeResult {
  form: IntakeForm;
  uncertain: string[];
  materials: AiMaterialSuggestion[];
}

const textBlock = (text: string): IntakeBlock[] => text.trim() ? [{ kind: "text", text }] : [];

function partSub(part: NonNullable<AiQuestion["parts"]>[number], index: number): IntakeSubQuestion {
  const label = part.label.trim() || `(${index + 1})`;
  return {
    ...blankSubQuestion(),
    originalLabel: label,
    prompt: textBlock(part.prompt),
    answer: textBlock(part.answer),
    explanation: textBlock(part.explanation),
    options: part.options.join("\n"),
    originalScore: part.score === null ? "" : String(part.score),
  };
}

/** AI 结构化题映射到录题表单；不确定项与材料建议单独返回，由界面确认后再写入。 */
export function aiQuestionToIntake(
  question: AiQuestion,
  classification: Classification,
  section: string,
): AiIntakeResult {
  const parts = question.parts ?? [];
  const legacy = parts.length === 0 && question.subquestions.length > 0;
  const single = parts.length === 0 && question.subquestions.length === 0;
  let subs: IntakeSubQuestion[];
  if (parts.length > 0) {
    subs = parts.map(partSub);
  } else if (legacy) {
    subs = question.subquestions.map((prompt, index) => ({
      ...blankSubQuestion(),
      originalLabel: `(${index + 1})`,
      prompt: textBlock(prompt),
      options: index === 0 ? question.options.join("\n") : "",
    }));
  } else {
    subs = [{ ...blankSubQuestion(), prompt: textBlock(question.stem) }];
  }
  const knowledgePoints = [...new Set([
    ...classification.knowledgePoints,
    ...question.tags,
    ...(question.knowledgePoints ?? []),
  ].map((point) => point.trim()).filter(Boolean))];
  const uncertain = [
    ...question.uncertain,
    ...parts.flatMap((part) => part.uncertain.map((item) => `第${part.label || "?"}小问：${item}`)),
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
  };
}
