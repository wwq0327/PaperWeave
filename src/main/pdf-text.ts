import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
// 在 Node/Electron 主进程中启用同线程 worker，避免运行时再去加载 pdf.worker.mjs 文件。
import "pdfjs-dist/legacy/build/pdf.worker.mjs";

export interface PdfTextPage {
  page: number;
  text: string;
}

export interface PdfTextResult {
  pages: PdfTextPage[];
  hasText: boolean;
}

/** 在 Node 端提取 PDF 文字；扫描件返回空页文字，由界面引导改走裁图。 */
export async function extractPdfText(data: Uint8Array): Promise<PdfTextResult> {
  const loading = getDocument({ data, useSystemFonts: true, disableFontFace: true });
  let document;
  try {
    document = await loading.promise;
  } catch (error) {
    console.error("PDF 文字提取失败", error);
    await loading.destroy().catch(() => undefined);
    throw new Error("无法读取 PDF，请确认文件未损坏");
  }
  try {
    const pages: PdfTextPage[] = [];
    for (let page = 1; page <= document.numPages; page++) {
      const content = await (await document.getPage(page)).getTextContent();
      const text = content.items
        .map((item) => ("str" in item ? item.str + (item.hasEOL ? "\n" : "") : ""))
        .join("")
        .trim();
      pages.push({ page, text });
    }
    return { pages, hasText: pages.some((page) => page.text.length > 0) };
  } finally {
    await loading.destroy().catch(() => undefined);
  }
}
