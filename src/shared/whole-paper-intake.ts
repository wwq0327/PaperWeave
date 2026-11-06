import type { AiFigureRef, AiSourceAnchor } from "./ai";
import type { AnswerStatus, ReviewStatus } from "./question";

export const wholePaperIntakeStatuses = ["created", "duplicate", "failed", "skipped", "revised"] as const;
export type WholePaperIntakeStatus = (typeof wholePaperIntakeStatuses)[number];

export const wholePaperIssueCodes = [
  "uncertain",
  "new_tag",
  "answer_missing",
  "score_missing",
  "material_pending",
  "material_scope",
  "duplicate",
  "failed",
] as const;
export type WholePaperIssueCode = (typeof wholePaperIssueCodes)[number];

export interface WholePaperIssue {
  code: WholePaperIssueCode;
  message: string;
}

export const wholePaperQualities = ["auto_passed", "needs_attention", "resolved", "excluded"] as const;
export type WholePaperQuality = (typeof wholePaperQualities)[number];

export interface WholePaperMaterialSummary {
  materialId: string;
  versionId: string;
  title: string;
  status: ReviewStatus;
}

export interface WholePaperIntakeSummary {
  created: number;
  duplicates: number;
  failed: number;
  existing: number;
  materials: number;
  needsAttention: number;
}

export interface WholePaperEvidence {
  anchors: AiSourceAnchor[];
  materialAnchors: AiSourceAnchor[];
  figures: AiFigureRef[];
  answerSources: string[];
}

export interface WholePaperIntakeItem {
  id: string;
  batchIndex: number;
  questionIndex: number;
  memberKeys: string[];
  evidence: WholePaperEvidence;
  originalNumber: string;
  page: number;
  status: WholePaperIntakeStatus;
  quality: WholePaperQuality;
  issues: WholePaperIssue[];
  message: string;
  questionId: string | null;
  versionId: string | null;
  contentStatus: ReviewStatus | null;
  answerStatus: AnswerStatus | null;
  preview: string;
  problems: string[];
  materialIds: string[];
  materials: WholePaperMaterialSummary[];
}

export interface WholePaperApprovalResult {
  approved: number;
  rejected: { id: string; reason: string }[];
}
