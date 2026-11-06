import { originalFileKind } from "../shared/ai";
import { planWholePaperBatches } from "../shared/whole-paper-batches";
import { createWholePaperRun } from "../shared/whole-paper-runner";
import { extractDocxText } from "./docx";
import type { ExamStore } from "./exams";
import { extractPdfText } from "./pdf-text";
import type { WholePaperStore, WholePaperTask } from "./whole-paper-store";

/** 本机准备任务，不发送原卷；页面/段落无文字不等于空白，后续必须复核。 */
export async function prepareWholePaper(exams: ExamStore, tasks: WholePaperStore, examId: string, sectionId: string, fileId: string): Promise<WholePaperTask> {
  const exam = exams.getExam(examId);
  if (!exam.sections.some((section) => section.id === sectionId)) throw new Error("考试分部不存在");
  const source = exam.files.find((file) => file.id === fileId && file.role === "paper");
  if (source === undefined) throw new Error("原卷不属于该考试");
  const { data } = exams.readFile(fileId);
  const sourceKind = originalFileKind(source.originalName);
  if (sourceKind === "docx") {
    const extracted = extractDocxText(data);
    if (!extracted.hasText) throw new Error("原卷没有可提取文字；请检查 DOCX 内容");
    // DOCX 没有版式分页，用文档段落序号作为来源定位，避免把段落当页码。
    const plan = planWholePaperBatches(extracted.units.map((unit) => ({ page: unit.unit, text: unit.text })), undefined, "docx");
    return tasks.create(examId, sectionId, createWholePaperRun(plan), fileId);
  }
  const extracted = await extractPdfText(new Uint8Array(data));
  if (!extracted.hasText) throw new Error("原卷没有可提取文字；扫描页的整卷识读尚未支持");
  const plan = planWholePaperBatches(extracted.pages, undefined, "pdf");
  return tasks.create(examId, sectionId, createWholePaperRun(plan), fileId);
}
