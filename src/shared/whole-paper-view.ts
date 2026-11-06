import type { AiSourceKind } from "./ai";
import type { BatchStatus } from "./whole-paper-runner";

export interface WholePaperTaskView {
  id: string;
  sectionId: string;
  revision: number;
  sourceFileId?: string;
  /** PDF 按页、DOCX 按文档段落显示来源。 */
  sourceKind: AiSourceKind;
  createdAt: string;
  emptyPages: number[];
  batches: { pages: number[]; status: BatchStatus; reviewBoundaryBefore: boolean }[];
}

export interface WholePaperTaskDetail extends WholePaperTaskView {
  results: ({ questions: import("./ai").AiQuestion[]; notes: string[] } | null)[];
}
