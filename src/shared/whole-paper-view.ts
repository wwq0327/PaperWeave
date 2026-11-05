import type { BatchStatus } from "./whole-paper-runner";

export interface WholePaperTaskView {
  id: string;
  sectionId: string;
  revision: number;
  sourceFileId?: string;
  createdAt: string;
  emptyPages: number[];
  batches: { pages: number[]; status: BatchStatus; reviewBoundaryBefore: boolean }[];
}
