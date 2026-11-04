import { answerPresent, type SaveIntakeResult } from "../shared/intake";
import { classificationProblem, questionContentProblem, type QuestionContent } from "../shared/question";
import type { ExamStore } from "./exams";
import type { QuestionBank } from "./question-bank";

const inputKeys = ["examId", "sectionId", "questionId", "content", "classification", "submit"];

const text = (value: unknown, name: string): string => {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name}无效`);
  return value.trim();
};

/** 录题保存入口：新建或追加版本后关联考试分部；提交待核时按内容推进审核状态。 */
export class Intake {
  constructor(private readonly exams: ExamStore, private readonly bank: QuestionBank) {}

  save(input: unknown): SaveIntakeResult {
    if (typeof input !== "object" || input === null || Array.isArray(input)) throw new Error("录入内容无效");
    const value = input as Record<string, unknown>;
    if (!Object.keys(value).every((key) => inputKeys.includes(key))) throw new Error("录入内容包含未知字段");
    const examId = text(value.examId, "考试标识");
    const sectionId = text(value.sectionId, "考试分部");
    const exam = this.exams.getExam(examId);
    if (!exam.sections.some((section) => section.id === sectionId)) throw new Error("考试分部不存在");
    const submit = value.submit === true;
    if (value.questionId === undefined) {
      const contentProblem = questionContentProblem(value.content);
      if (contentProblem !== null) throw new Error(`题目结构无效：${contentProblem}`);
      const classificationIssue = value.classification === undefined ? null : classificationProblem(value.classification);
      if (classificationIssue !== null) throw new Error(classificationIssue);
      const duplicate = this.exams.findDuplicate(examId, sectionId, (value.content as QuestionContent).source.originalNumber);
      if (duplicate !== undefined) {
        return {
          saved: false,
          duplicate: {
            questionId: duplicate.questionId,
            versionId: duplicate.versionId,
            version: duplicate.version,
            contentStatus: duplicate.contentStatus,
            answerStatus: duplicate.answerStatus,
            preview: duplicate.preview,
            source: duplicate.source,
          },
        };
      }
    }
    let record;
    if (value.questionId !== undefined) {
      const questionId = text(value.questionId, "题目标识");
      record = this.bank.saveQuestionVersionWithClassification(questionId, value.content, value.classification);
    } else {
      record = this.bank.createQuestion(value.content, value.classification);
    }
    this.exams.linkQuestion(record.questionId, examId, sectionId);
    let latest = this.bank.getQuestionVersion(record.id) ?? record;
    if (submit) {
      if (latest.contentStatus === "draft") this.bank.setContentStatus(latest.id, "pending");
      if (latest.answerStatus === "missing" && answerPresent(latest.content)) this.bank.setAnswerStatus(latest.id, "pending");
      latest = this.bank.getQuestionVersion(record.id) ?? latest;
    }
    return {
      saved: true,
      questionId: latest.questionId,
      versionId: latest.id,
      version: latest.version,
      contentStatus: latest.contentStatus,
      answerStatus: latest.answerStatus,
    };
  }
}
