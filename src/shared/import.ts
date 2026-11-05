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
  /** 来源文件相对旧库根目录的路径；不可在应用内修正时用于定位源文件。 */
  sourcePath?: string;
  /** 题内小问数量；调整答案／解析小问号时选择目标。 */
  subQuestionCount?: number;
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

export type ImportCorrectionAction = "attachImage" | "dropProblem" | "setOriginalNumber" | "moveSubLabel";

export interface ImportCorrectionInput {
  scanId: string;
  sourceKey: string;
  action: ImportCorrectionAction;
  problem: string;
  /** 补填的原题号。 */
  value?: string;
  /** 1 起的小问序号，把多余答案／解析并入该小问。 */
  target?: number;
}

export type ImportCorrectionResult = { status: "canceled" } | { status: "corrected"; row: ImportRow };

export type ImportProblemKind = "image" | "material" | "subLabel" | "originalNumber" | "other";

/** 可在应用内修正的阻断项：补图、移除材料、补原题号、调整答案／解析小问号。 */
export function importProblemKind(problem: string): ImportProblemKind {
  if (/^(缺图|远程图片|图片|配图)/.test(problem)) return "image";
  if (problem.startsWith("材料失链")) return "material";
  if (/^(答案|解析)小问号不匹配：/.test(problem)) return "subLabel";
  if (problem.startsWith("缺少原题号")) return "originalNumber";
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
