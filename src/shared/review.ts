import {
  classificationProblem,
  hasContent,
  type Classification,
  type QuestionContent,
  type ReviewStatus,
} from "./question";

export interface ReviewMaterial {
  versionId: string;
  title: string;
  status: ReviewStatus;
}

export interface ReviewQuestionInput {
  content: QuestionContent;
  classification: Classification | undefined;
  materials: ReviewMaterial[];
}

/** 内容审核前必须解决的问题；空数组表示可以标记为已审核。 */
export function contentReviewProblems(input: ReviewQuestionInput): string[] {
  const problems: string[] = [];
  const classificationIssue = input.classification === undefined ? "分类缺失" : classificationProblem(input.classification);
  if (classificationIssue !== null) problems.push(`分类未完善：${classificationIssue}`);
  for (const sub of input.content.subQuestions) {
    if (!hasContent(sub.prompt)) problems.push(`小问「${sub.originalLabel || sub.id}」缺少题干`);
  }
  const materials = new Map(input.materials.map((material) => [material.versionId, material]));
  for (const ref of input.content.materials) {
    const material = materials.get(ref.versionId);
    if (material === undefined) problems.push(`材料「${ref.materialId}」缺失`);
    else if (material.status !== "approved") problems.push(`材料「${material.title}」尚未审核`);
  }
  return problems;
}
