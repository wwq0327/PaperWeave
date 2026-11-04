import type { Classification, QuestionContent, ReviewStatus } from "./question";

export type ImportKind = "tiku" | "mathvault";
export type ImportStatus = "importable" | "duplicate" | "changed" | "target_modified" | "blocked";
export type ImportDecision = "import" | "revise" | "skip";

export interface ImportTarget {
  questionId: string;
  versionId: string;
  version: number;
  preview: string;
  contentStatus: ReviewStatus;
}

export interface ImportRow {
  sourceKey: string;
  sourceHash: string;
  status: ImportStatus;
  title: string;
  section: string;
  pdfPage: number;
  originalNumber: string;
  classification: Classification;
  preview: string;
  reasons: string[];
  target?: ImportTarget;
  incoming?: QuestionContent;
  canRevise: boolean;
  needsProofread?: boolean;
  legacyStatus?: string;
}

export interface ImportSummary {
  importable: number;
  duplicate: number;
  changed: number;
  target_modified: number;
  blocked: number;
}

export interface ImportScanView {
  scanId: string;
  kind: ImportKind;
  rows: ImportRow[];
  summary: ImportSummary;
}

export interface ImportApplyRow {
  sourceKey: string;
  action: ImportDecision;
  acknowledgeProofread?: boolean;
}

export interface ImportApplyResult {
  batchId: string;
  imported: number;
  revised: number;
  skipped: number;
}

export interface ImportBatchView {
  id: string;
  kind: ImportKind;
  rootName: string;
  createdAt: string;
  summary: { imported?: number; revised?: number; skipped?: number; materials?: number };
}

const statuses = new Set(["importable", "duplicate", "changed", "target_modified", "blocked"]);
const decisions = new Set(["import", "revise", "skip"]);

export function isImportKind(value: unknown): value is ImportKind {
  return value === "tiku" || value === "mathvault";
}

export function isImportStatus(value: unknown): value is ImportStatus {
  return typeof value === "string" && statuses.has(value);
}

export function isImportDecision(value: unknown): value is ImportDecision {
  return typeof value === "string" && decisions.has(value);
}

export function emptyImportSummary(): ImportSummary {
  return { importable: 0, duplicate: 0, changed: 0, target_modified: 0, blocked: 0 };
}
