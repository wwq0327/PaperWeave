import type { ImportFieldDiff } from "./import-diff";
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
  problems?: string[];
  target?: ImportTarget;
  incoming?: QuestionContent;
  canRevise: boolean;
  needsProofread?: boolean;
  legacyStatus?: string;
  diff?: ImportFieldDiff[];
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

export type ImportCorrectionAction = "attachImage" | "dropProblem";

export type ImportCorrectionResult = { status: "canceled" } | { status: "corrected"; row: ImportRow };

export type ImportProblemKind = "image" | "material" | "other";

/** 可在应用内修正的阻断项：图片可补入或确认不带，失链材料可确认移除。 */
export function importProblemKind(problem: string): ImportProblemKind {
  if (/^(缺图|远程图片|图片|配图)/.test(problem)) return "image";
  if (problem.startsWith("材料失链")) return "material";
  return "other";
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
