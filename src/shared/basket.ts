import { hasContent, selectionDependencies, type QuestionContent } from "./question";

export interface BasketSelection {
  subQuestionIds: string[];
  materialIds: string[];
  wholeGroup: boolean;
  reasons: string[];
}

const union = (values: string[]) => [...new Set(values)];
const allSubQuestionIds = (content: QuestionContent) => content.subQuestions.map((item) => item.id);
const allMaterialIds = (content: QuestionContent) => union(content.subQuestions.flatMap((item) => item.materialIds));

/** 入篮前计算必须带入的小问与原因；组选答与共用题干强制整组。 */
export function basketSelection(content: QuestionContent, subQuestionId: string | null): BasketSelection {
  if (subQuestionId === null) {
    return { subQuestionIds: allSubQuestionIds(content), materialIds: allMaterialIds(content), wholeGroup: true, reasons: ["整题加入"] };
  }
  if (!content.subQuestions.some((item) => item.id === subQuestionId)) throw new Error("小问不存在");
  const reasons: string[] = [];
  if (hasContent(content.stem)) reasons.push("题组共用题干");
  if (content.selection.mode === "choose" && content.selection.candidates.includes(subQuestionId)) reasons.push("组选答候选项");
  if (reasons.length > 0) {
    return { subQuestionIds: allSubQuestionIds(content), materialIds: allMaterialIds(content), wholeGroup: true, reasons };
  }
  const dependencies = selectionDependencies(content, subQuestionId);
  if (dependencies.directPrevious.length > 0) reasons.push(`直接前问：${dependencies.directPrevious.join("、")}`);
  const transitive = dependencies.previous.filter((id) => !dependencies.directPrevious.includes(id));
  if (transitive.length > 0) reasons.push(`传递前问：${transitive.join("、")}`);
  if (reasons.length === 0) reasons.push("独立小问");
  const selected = new Set([...dependencies.previous, subQuestionId]);
  return {
    subQuestionIds: content.subQuestions.filter((item) => selected.has(item.id)).map((item) => item.id),
    materialIds: union(content.subQuestions.filter((item) => selected.has(item.id)).flatMap((item) => item.materialIds)),
    wholeGroup: false,
    reasons,
  };
}
