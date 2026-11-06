import { originalFileKind } from "../shared/ai";
import { AttachmentStore } from "./attachments";
import { planWholePaperAnswerBatches, planWholePaperBatches, type WholePaperAnswerFile, type WholePaperPageImage } from "../shared/whole-paper-batches";
import { createWholePaperRun } from "../shared/whole-paper-runner";
import { extractDocxText } from "./docx";
import type { ExamStore } from "./exams";
import { extractPdfText } from "./pdf-text";
import type { WholePaperStore, WholePaperTask } from "./whole-paper-store";

interface PageImageInput {
  fileId?: string;
  page: number;
  dataUrl: string;
  width: number;
  height: number;
}

function pageImageInputs(value: unknown, allowed: Set<string>): PageImageInput[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 2000) throw new Error("页面图像列表无效");
  return value.map((item: unknown) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) throw new Error("页面图像格式无效");
    const entry = item as Record<string, unknown>;
    if (!Object.keys(entry).every((key) => ["fileId", "page", "dataUrl", "width", "height"].includes(key))) throw new Error("页面图像包含未知字段");
    if (entry.fileId !== undefined && (typeof entry.fileId !== "string" || !allowed.has(entry.fileId))) throw new Error("页面图像不属于该考试");
    if (!Number.isInteger(entry.page) || (entry.page as number) < 1 || (entry.page as number) > 2000) throw new Error("页面图像页码无效");
    if (typeof entry.dataUrl !== "string" || entry.dataUrl.length > 10 * 1024 * 1024) throw new Error("页面图像数据无效");
    if (!Number.isInteger(entry.width) || (entry.width as number) < 1 || (entry.width as number) > 20000 || !Number.isInteger(entry.height) || (entry.height as number) < 1 || (entry.height as number) > 20000) throw new Error("页面图像尺寸无效");
    return {
      ...(entry.fileId === undefined ? {} : { fileId: entry.fileId as string }),
      page: entry.page as number,
      dataUrl: entry.dataUrl,
      width: entry.width as number,
      height: entry.height as number,
    };
  });
}

function groupImages(images: PageImageInput[], fileId: string | undefined, emptyPages: Set<number>, fileLabel: string, attachments: AttachmentStore): WholePaperPageImage[] {
  const grouped = images.filter((image) => image.fileId === fileId);
  const seen = new Set<number>();
  return grouped.map((image) => {
    if (!emptyPages.has(image.page)) throw new Error(`${fileLabel}第 ${image.page} 页有可提取文字，不接受页面图像`);
    if (seen.has(image.page)) throw new Error(`${fileLabel}页面图像页码重复`);
    seen.add(image.page);
    return { page: image.page, attachmentId: attachments.saveDataUrl(image.dataUrl).id, width: image.width, height: image.height };
  });
}

/** 本机准备任务，不发送原卷；页面/段落无文字不等于空白，后续必须复核。 */
export async function prepareWholePaper(exams: ExamStore, tasks: WholePaperStore, attachments: AttachmentStore, examId: string, sectionId: string, fileId: string, pageImages?: unknown): Promise<WholePaperTask> {
  const exam = exams.getExam(examId);
  if (!exam.sections.some((section) => section.id === sectionId)) throw new Error("考试分部不存在");
  const source = exam.files.find((file) => file.id === fileId && file.role === "paper");
  if (source === undefined) throw new Error("原卷不属于该考试");
  const sourceKind = originalFileKind(source.originalName);
  if (sourceKind === "docx" && pageImages !== undefined) throw new Error("DOCX 原卷不接受页面图像");
  const answerFiles = exam.files.filter((file) => file.role === "answer" || file.role === "rubric");
  const allowedFiles = new Set(answerFiles.map((file) => file.id));
  const images = pageImageInputs(pageImages, allowedFiles);
  const { data } = exams.readFile(fileId);
  if (sourceKind === "docx") {
    const extracted = extractDocxText(data);
    if (!extracted.hasText) throw new Error("原卷没有可提取文字；请检查 DOCX 内容");
    // DOCX 没有版式分页，用文档段落序号作为来源定位，避免把段落当页码。
    const plan = planWholePaperBatches(extracted.units.map((unit) => ({ page: unit.unit, text: unit.text })), undefined, "docx");
    plan.docxImages = extracted.media.map((media) => {
      const base = { unit: media.unit, start: media.start, end: media.end, name: media.name };
      if (media.mime === null || media.data === undefined) return { ...base, note: media.problem ?? "图片无法自动提取" };
      try {
        return { ...base, attachmentId: attachments.save(media.data).id };
      } catch (error) {
        return { ...base, note: `图片无法写入附件池：${error instanceof Error ? error.message : String(error)}` };
      }
    });
    return tasks.create(examId, sectionId, createWholePaperRun(plan), fileId);
  }
  const extracted = await extractPdfText(new Uint8Array(data));
  const emptyPages = extracted.pages.filter((page) => !page.text.trim()).map((page) => page.page);
  const paperImages = groupImages(images, undefined, new Set(emptyPages), "原卷", attachments);
  const paperImagesByPage = new Map(paperImages.map((image) => [image.page, image]));
  const missing = emptyPages.filter((page) => !paperImagesByPage.has(page));
  if (missing.length > 0) throw new Error(`原卷第 ${missing.join("、")} 页没有可提取文字，且缺少页面图像`);
  const plan = planWholePaperBatches(extracted.pages, undefined, "pdf", { scanPages: paperImages });
  plan.answerFiles = [];
  for (const file of answerFiles) {
    const answer: WholePaperAnswerFile = { fileId: file.id, role: file.role as "answer" | "rubric", name: file.originalName };
    if (originalFileKind(file.originalName) !== "pdf") throw new Error(`答案文件「${file.originalName}」仅支持 PDF`);
    const answerData = exams.readFile(file.id).data;
    const answerExtracted = await extractPdfText(new Uint8Array(answerData));
    const answerEmpty = new Set(answerExtracted.pages.filter((page) => !page.text.trim()).map((page) => page.page));
    const answerImages = groupImages(images, file.id, answerEmpty, `答案文件「${file.originalName}」`, attachments);
    const answerBatches = planWholePaperAnswerBatches(answerExtracted.pages, answerImages, undefined, answer);
    for (const batch of answerBatches) {
      batch.reviewBoundaryBefore = plan.batches.length > 0;
      plan.batches.push(batch);
    }
    plan.answerFiles.push(answer);
  }
  return tasks.create(examId, sectionId, createWholePaperRun(plan), fileId);
}
