import type { AnswerStatus, ReviewStatus } from "./question";

export const wholePaperIntakeStatuses = ["created", "duplicate", "failed", "skipped", "revised"] as const;
export type WholePaperIntakeStatus = (typeof wholePaperIntakeStatuses)[number];

export interface WholePaperIntakeSummary {
  created: number;
  duplicates: number;
  failed: number;
  existing: number;
  materials: number;
}

export interface WholePaperIntakeItem {
  id: string;
  batchIndex: number;
  questionIndex: number;
  originalNumber: string;
  page: number;
  status: WholePaperIntakeStatus;
  message: string;
  questionId: string | null;
  versionId: string | null;
  contentStatus: ReviewStatus | null;
  answerStatus: AnswerStatus | null;
  preview: string;
  problems: string[];
  materialIds: string[];
}
