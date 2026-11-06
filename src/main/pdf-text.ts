import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
// 在 Node/Electron 主进程中启用同线程 worker，避免运行时再去加载 pdf.worker.mjs 文件。
import "pdfjs-dist/legacy/build/pdf.worker.mjs";

export interface PdfTextBlock {
  /** 页内 Unicode 码点偏移，右端不包含。 */
  start: number;
  end: number;
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PdfTextPage {
  page: number;
  text: string;
  blocks: PdfTextBlock[];
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
      const parts: { text: string; hasEOL: boolean; x: number; y: number; width: number; height: number }[] = [];
      for (const item of content.items) {
        if (!("str" in item)) continue;
        parts.push({ text: item.str, hasEOL: item.hasEOL, x: item.transform[4], y: item.transform[5], width: item.width, height: item.height });
      }
      const raw = parts.map((part) => part.text + (part.hasEOL ? "\n" : "")).join("");
      const text = raw.trim();
      const leading = [...raw].length - [...raw.trimStart()].length;
      const chars = [...text];
      const blocks: PdfTextBlock[] = [];
      let cursor = 0;
      let lineStart = 0;
      let lineText = "";
      let line: { x: number; y: number; right: number; height: number } | undefined;
      const flushLine = () => {
        if (!line || lineText === "") return;
        const start = lineStart - leading;
        const end = cursor - leading;
        if (end > 0 && start < chars.length) {
          const from = Math.max(0, start);
          const to = Math.min(chars.length, end);
          if (to > from) blocks.push({ start: from, end: to, text: chars.slice(from, to).join(""), x: line.x, y: line.y, width: line.right - line.x, height: line.height });
        }
        lineText = "";
        line = undefined;
      };
      for (const part of parts) {
        if (lineText === "" && part.text !== "") lineStart = cursor;
        if (part.text !== "" && line === undefined) line = { x: part.x, y: part.y, right: part.x + part.width, height: part.height };
        lineText += part.text;
        cursor += [...part.text].length;
        if (line !== undefined) {
          line.right = Math.max(line.right, part.x + part.width);
          line.height = Math.max(line.height, part.height);
        }
        if (part.hasEOL) {
          flushLine();
          cursor += 1;
        }
      }
      flushLine();
      pages.push({ page, text, blocks });
    }
    return { pages, hasText: pages.some((page) => page.text.length > 0) };
  } finally {
    await loading.destroy().catch(() => undefined);
  }
}
