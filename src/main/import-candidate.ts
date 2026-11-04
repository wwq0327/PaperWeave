import type { ParsedImage } from "./import-parse";
import type { Classification, QuestionBlock, QuestionContent } from "../shared/question";

export interface ImportMaterialSpec {
  key: string;
  placeholderId: string;
  title: string;
  content: QuestionBlock[];
  source: string;
  hash: string;
}

/** 旧库解析结果；Tiku 与 mathVault 共用批次、差异与写入流程。 */
export interface ImportCandidate {
  sourceKey: string;
  sourceHash: string;
  title: string;
  section: string;
  pdfPage: number;
  originalNumber: string;
  classification: Classification;
  preview: string;
  reasons: string[];
  legacyStatus?: string;
  blocked: boolean;
  needsProofread: boolean;
  content?: QuestionContent;
  images: ParsedImage[];
  materials: ImportMaterialSpec[];
}
