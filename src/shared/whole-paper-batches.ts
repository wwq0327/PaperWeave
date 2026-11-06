import { AI_LIMITS, sourceUnitLabel, type AiSourceKind } from "./ai";

export interface WholePaperBlock {
  /** 页内 Unicode 码点偏移，右端不包含。 */
  start: number;
  end: number;
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WholePaperPage {
  page: number;
  text: string;
  blocks?: WholePaperBlock[];
}

export interface WholePaperFragment {
  page: number;
  /** Unicode 字符偏移，右端不包含；用于回查原页文字。 */
  start: number;
  end: number;
  text: string;
  blocks?: WholePaperBlock[];
}

export interface WholePaperPageImage {
  page: number;
  /** 附件池中的 PNG/JPEG 标识。 */
  attachmentId: string;
  width: number;
  height: number;
}

export interface WholePaperAnswerFile {
  fileId: string;
  role: "answer" | "rubric";
  name: string;
}

/** 扫描整页或答案页的批次类型；缺省 kind 为文字页，兼容旧任务。 */
export type WholePaperBatchKind = "text" | "scan" | "answer-text" | "answer-scan";

export interface WholePaperBatch {
  kind?: WholePaperBatchKind;
  fragments: WholePaperFragment[];
  pages: number[];
  text: string;
  /** 纯空白文字批次只用于回查，不可发送模型；扫描批次无文字但可发送。 */
  sendable: boolean;
  /** 分批不能证明题目完整，任何相邻批次边界都需结合识别结果复核。 */
  reviewBoundaryBefore: boolean;
  /** 扫描页整页图；kind 为 scan/answer-scan 时必填。 */
  image?: WholePaperPageImage;
  /** 答案／评分文件来源；kind 为 answer-* 时必填。 */
  answer?: WholePaperAnswerFile;
}

export interface WholePaperDocxImage {
  /** DOCX 段落序号。 */
  unit: number;
  /** 占位符在段落文字中的码点区间，右端不包含。 */
  start: number;
  end: number;
  name: string;
  /** PNG/JPEG 已写入附件池时的标识；缺省表示需人工裁切。 */
  attachmentId?: string;
  /** 无法自动提取时的待核原因。 */
  note?: string;
}

export interface WholePaperBatchPlan {
  /** 缺省视为 PDF 页；旧任务数据没有此字段。 */
  sourceKind?: AiSourceKind;
  batches: WholePaperBatch[];
  emptyPages: number[];
  /** DOCX 内嵌媒体定位；旧任务或 PDF 任务没有此字段。 */
  docxImages?: WholePaperDocxImage[];
  /** 本次任务读取的答案／评分文件；旧任务没有此字段。 */
  answerFiles?: WholePaperAnswerFile[];
}

/** 向模型发送时标明每段来源位置；原始文本和页内偏移保持不变。 */
export function wholePaperRequestText(batch: WholePaperBatch, sourceKind: AiSourceKind = "pdf"): string {
  if (batch.image !== undefined) throw new Error("扫描批次没有可发送文字");
  return batch.fragments.map((part) => `\n[原卷${sourceUnitLabel(sourceKind, part.page)}]\n${part.text}`).join("");
}

interface PlanOptions {
  /** 文字批次类型；扫描页自动对应 scan 或 answer-scan。 */
  kind: "text" | "answer-text";
  answer?: WholePaperAnswerFile;
  scanPages?: WholePaperPageImage[];
  /** 答案文件的空页必须提供扫描图，不能像原卷一样留空。 */
  emptyPolicy: "report" | "error";
}

function planPages(pages: WholePaperPage[], limit: number, sourceKind: AiSourceKind, options: PlanOptions): { batches: WholePaperBatch[]; emptyPages: number[] } {
  if (!Number.isInteger(limit) || limit < 20 || limit > AI_LIMITS.textChars) throw new Error("分批字符上限无效");
  if (sourceKind !== "pdf" && sourceKind !== "docx") throw new Error("来源类型无效");
  const scanMap = new Map<number, WholePaperPageImage>();
  for (const image of options.scanPages ?? []) {
    if (!Number.isInteger(image.page) || image.page < 1 || image.page > 2000) throw new Error("扫描页页码无效");
    if (scanMap.has(image.page)) throw new Error("扫描页页码重复");
    scanMap.set(image.page, image);
  }
  const pageByNumber = new Map(pages.map((page) => [page.page, page]));
  for (const page of scanMap.keys()) {
    const source = pageByNumber.get(page);
    if (source === undefined) throw new Error(`扫描页第 ${page} 页在原卷中不存在`);
    if (source.text.trim()) throw new Error(`扫描页第 ${page} 页必须对应空文字页`);
  }
  const batches: WholePaperBatch[] = [];
  const emptyPages: number[] = [];
  let fragments: WholePaperFragment[] = [];
  let size = 0;
  const scanKind = options.kind === "answer-text" ? "answer-scan" : "scan";
  const flush = () => {
    if (!fragments.length) return;
    batches.push({
      kind: options.kind,
      fragments, pages: [...new Set(fragments.map((part) => part.page))],
      text: fragments.map((part) => part.text).join(""),
      sendable: fragments.some((part) => part.text.trim().length > 0),
      reviewBoundaryBefore: batches.length > 0,
      ...(options.answer === undefined ? {} : { answer: options.answer }),
    });
    fragments = [];
    size = 0;
  };
  let lastPage = 0;
  for (const page of pages) {
    if (!Number.isInteger(page.page) || page.page <= lastPage || page.page > 2000 || typeof page.text !== "string") throw new Error("原卷页码或文字无效");
    lastPage = page.page;
    const scan = scanMap.get(page.page);
    if (scan !== undefined) {
      flush();
      batches.push({
        kind: scanKind,
        fragments: [],
        pages: [page.page],
        text: "",
        sendable: true,
        reviewBoundaryBefore: batches.length > 0,
        image: { ...scan },
        ...(options.answer === undefined ? {} : { answer: options.answer }),
      });
      continue;
    }
    const chars = [...page.text];
    if (!page.text.trim()) {
      // 空白文字同样保留，供准确回查；答案文件的空页必须明确提供扫描图。
      if (options.emptyPolicy === "error") throw new Error(`答案文件第 ${page.page} 页没有可提取文字，且缺少页面图像`);
      emptyPages.push(page.page);
      if (!chars.length) continue;
    }
    let start = 0;
    while (start < chars.length) {
      const headerSize = [...`\n[原卷第 ${page.page} 页]\n`].length;
      if (size + headerSize >= limit || (fragments.length > 0 && new Set(fragments.map((part) => part.page)).size === 50)) flush();
      const end = Math.min(start + limit - size - headerSize, chars.length);
      const part = chars.slice(start, end).join("");
      const partBlocks = page.blocks?.filter((block) => block.end > start && block.start < end).map((block) => ({ ...block }));
      fragments.push({ page: page.page, start, end, text: part, ...(partBlocks === undefined ? {} : { blocks: partBlocks }) });
      size += headerSize + end - start;
      start = end;
    }
  }
  flush();
  return { batches, emptyPages };
}

/** 按原页顺序无损切分文字；空页单独报告，扫描页按序插入。 */
export function planWholePaperBatches(pages: WholePaperPage[], limit: number = AI_LIMITS.textChars, sourceKind: AiSourceKind = "pdf", options: { scanPages?: WholePaperPageImage[] } = {}): WholePaperBatchPlan {
  const planned = planPages(pages, limit, sourceKind, { kind: "text", scanPages: options.scanPages, emptyPolicy: "report" });
  return { sourceKind, batches: planned.batches, emptyPages: planned.emptyPages };
}

/** 答案／评分 PDF 的文字页与扫描页分别生成答案批次。 */
export function planWholePaperAnswerBatches(pages: WholePaperPage[], scanPages: WholePaperPageImage[], limit: number, answer: WholePaperAnswerFile): WholePaperBatch[] {
  if (answer.role !== "answer" && answer.role !== "rubric") throw new Error("答案文件角色无效");
  return planPages(pages, limit, "pdf", { kind: "answer-text", answer, scanPages, emptyPolicy: "error" }).batches;
}
