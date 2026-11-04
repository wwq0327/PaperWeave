import { expect, test } from "vitest";
import { contentReviewProblems } from "../../../src/shared/review";
import type { Classification } from "../../../src/shared/question";
import { math, paragraph, readingGroup } from "../fixtures/questions";

const classification: Classification = {
  stage: "初中",
  subject: "数学",
  grade: "九年级",
  examType: "单元测",
  year: "2026",
  sourceName: "自制样题",
  questionType: "解答题",
  knowledgePoints: ["一元二次方程"],
};

test("分类完整、题干齐全且无材料时可以直接通过内容审核", () => {
  expect(contentReviewProblems({ content: math(), classification, materials: [] })).toEqual([]);
});

test("缺少分类或分类无效时阻止内容审核", () => {
  expect(contentReviewProblems({ content: math(), classification: undefined, materials: [] })).toContain("分类未完善：分类缺失");
  const problems = contentReviewProblems({ content: math(), classification: { ...classification, subject: "" }, materials: [] });
  expect(problems.some((problem) => problem.startsWith("分类未完善"))).toBe(true);
});

test("小问题干为空时逐一列出小问号", () => {
  const content = math();
  content.subQuestions[1].prompt = [paragraph("   ")];
  const problems = contentReviewProblems({ content, classification, materials: [] });
  expect(problems).toContain("小问「(2)」缺少题干");
  expect(problems).not.toContain("小问「(1)」缺少题干");
});

test("引用材料未审核或缺失时阻止内容审核", () => {
  const content = readingGroup();
  const pending = contentReviewProblems({
    content,
    classification: { ...classification, subject: "语文" },
    materials: [{ versionId: "material-a-v1", title: "阅读材料", status: "pending" }],
  });
  expect(pending).toContain("材料「阅读材料」尚未审核");
  const missing = contentReviewProblems({ content, classification: { ...classification, subject: "语文" }, materials: [] });
  expect(missing).toContain("材料「material-a」缺失");
});
