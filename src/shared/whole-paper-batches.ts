import { AI_LIMITS } from "./ai";

export interface WholePaperPage {
  page: number;
  text: string;
}

export interface WholePaperFragment {
  page: number;
  /** Unicode 字符偏移，右端不包含；用于回查原页文字。 */
  start: number;
  end: number;
  text: string;
}

export interface WholePaperBatch {
  fragments: WholePaperFragment[];
  pages: number[];
  text: string;
  /** 纯空白批次只用于回查，不可发送模型。 */
  sendable: boolean;
  /** 分批不能证明题目完整，任何相邻批次边界都需结合识别结果复核。 */
  reviewBoundaryBefore: boolean;
}

export interface WholePaperBatchPlan {
  batches: WholePaperBatch[];
  emptyPages: number[];
}

/** 向模型发送时标明每段原页；原始文本和页内偏移保持不变。 */
export function wholePaperRequestText(batch: WholePaperBatch): string {
  return batch.fragments.map((part) => `\n[原卷第 ${part.page} 页]\n${part.text}`).join("");
}

/** 按原页顺序无损切分文字；空页单独报告，不能假定空页没有题目。 */
export function planWholePaperBatches(pages: WholePaperPage[], limit: number = AI_LIMITS.textChars): WholePaperBatchPlan {
  if (!Number.isInteger(limit) || limit < 20 || limit > AI_LIMITS.textChars) throw new Error("分批字符上限无效");
  let lastPage = 0;
  const batches: WholePaperBatch[] = [];
  const emptyPages: number[] = [];
  let fragments: WholePaperFragment[] = [];
  let size = 0;
  const flush = () => {
    if (!fragments.length) return;
    batches.push({ fragments, pages: [...new Set(fragments.map((part) => part.page))], text: fragments.map((part) => part.text).join(""), sendable: fragments.some((part) => part.text.trim().length > 0), reviewBoundaryBefore: batches.length > 0 });
    fragments = [];
    size = 0;
  };
  for (const page of pages) {
    if (!Number.isInteger(page.page) || page.page <= lastPage || page.page > 2000 || typeof page.text !== "string") throw new Error("原卷页码或文字无效");
    lastPage = page.page;
    const chars = [...page.text];
    if (!page.text.trim()) {
      // 空白文字同样保留，供准确回查；纯空白批次标记为不可发送。
      emptyPages.push(page.page);
      if (!chars.length) continue;
    }
    let start = 0;
    while (start < chars.length) {
      const headerSize = [...`\n[原卷第 ${page.page} 页]\n`].length;
      if (size + headerSize >= limit || (fragments.length > 0 && new Set(fragments.map((part) => part.page)).size === 50)) flush();
      const end = Math.min(start + limit - size - headerSize, chars.length);
      const part = chars.slice(start, end).join("");
      fragments.push({ page: page.page, start, end, text: part });
      size += headerSize + end - start;
      start = end;
    }
  }
  flush();
  return { batches, emptyPages };
}
