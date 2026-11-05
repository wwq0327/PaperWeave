import { planWholePaperBatches } from "../shared/whole-paper-batches";
import { createWholePaperRun } from "../shared/whole-paper-runner";
import type { ExamStore } from "./exams";
import { extractPdfText } from "./pdf-text";
import type { WholePaperStore, WholePaperTask } from "./whole-paper-store";

/** 本机准备任务，不发送原卷；页面无文字不等于空白页，后续必须复核。 */
export async function prepareWholePaperPdf(exams: ExamStore, tasks: WholePaperStore, examId: string, sectionId: string, fileId: string): Promise<WholePaperTask> {
  const exam = exams.getExam(examId);
  if (!exam.sections.some((section) => section.id === sectionId)) throw new Error("考试分部不存在");
  if (!exam.files.some((file) => file.id === fileId && file.role === "paper")) throw new Error("原卷不属于该考试");
  const { data } = exams.readFile(fileId);
  const extracted = await extractPdfText(new Uint8Array(data));
  if (!extracted.hasText) throw new Error("原卷没有可提取文字；扫描页的整卷识读尚未支持");
  const plan = planWholePaperBatches(extracted.pages);
  return tasks.create(examId, sectionId, createWholePaperRun(plan), fileId);
}
