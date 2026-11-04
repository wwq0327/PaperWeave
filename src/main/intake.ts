import { answerPresent, type SaveIntakeResult } from "../shared/intake";
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
      questionId: latest.questionId,
      versionId: latest.id,
      version: latest.version,
      contentStatus: latest.contentStatus,
      answerStatus: latest.answerStatus,
    };
  }
}
