import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
// 在主线程注册 worker，避免 file:// 页面再加载独立 worker 文件。
import "pdfjs-dist/legacy/build/pdf.worker.mjs";

export interface ScanPageImage {
  /** 答案／评分文件的标识；原卷图片不带此字段。 */
  fileId?: string;
  page: number;
  dataUrl: string;
  width: number;
  height: number;
}

const isPdf = (name: string): boolean => name.toLowerCase().endsWith(".pdf");

async function renderPages(fileId: string, pages: number[]): Promise<ScanPageImage[]> {
  if (pages.length === 0) return [];
  const { data } = await window.paperweave.getExamFile(fileId);
  const loading = getDocument({ data });
  try {
    const document = await loading.promise;
    const result: ScanPageImage[] = [];
    for (const pageNumber of pages) {
      if (pageNumber < 1 || pageNumber > document.numPages) throw new Error(`页码 ${pageNumber} 超出原卷页数`);
      const page = await document.getPage(pageNumber);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.max(1, Math.min(2, 2400 / Math.max(base.width, base.height)));
      const viewport = page.getViewport({ scale });
      const canvas = window.document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) throw new Error("无法创建页面画布");
      await page.render({ canvas, canvasContext: context, viewport }).promise;
      result.push({ page: pageNumber, dataUrl: canvas.toDataURL("image/jpeg", 0.85), width: canvas.width, height: canvas.height });
    }
    return result;
  } finally {
    await loading.destroy().catch(() => undefined);
  }
}

/**
 * 只渲染没有文字层的页：原卷图片用于扫描识读，答案／评分图片用于答案抽取。
 * 原卷图片不携带 fileId；答案图片携带对应文件 id，主进程据此分组。
 */
export async function collectScanPageImages(examId: string, paperFileId: string): Promise<ScanPageImage[]> {
  const { files } = await window.paperweave.getExam(examId);
  const paper = files.find((file) => file.id === paperFileId && file.role === "paper");
  if (paper === undefined) throw new Error("原卷不属于该考试");
  if (!isPdf(paper.originalName)) return [];
  const sources = [
    { file: paper, attachId: false },
    ...files.filter((file) => file.role === "answer" || file.role === "rubric").filter((file) => isPdf(file.originalName)).map((file) => ({ file, attachId: true })),
  ];
  const images: ScanPageImage[] = [];
  for (const source of sources) {
    const { pages } = await window.paperweave.getExamFileText(source.file.id);
    const empty = pages.filter((page) => !page.text.trim()).map((page) => page.page);
    const rendered = await renderPages(source.file.id, empty);
    for (const image of rendered) images.push(source.attachId ? { ...image, fileId: source.file.id } : image);
  }
  return images;
}
