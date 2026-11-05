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

/** 小问号对不上、但可在应用内并入现有小问的答案或解析条目。 */
export interface ImportUnmatchedGroup {
  problem: string;
  target: "answers" | "explanation";
  blocks: QuestionBlock[];
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
  /** 可逐条修正或确认移除的阻断原因；解析失败等不可修正项不在此列。 */
  problems: string[];
  /** 应用内已做的修正，随导入记录写入 detail 供追溯。 */
  corrections: string[];
  /** 来源文件相对旧库根目录的路径。 */
  sourcePath?: string;
  /** 小问号超出题内小问数量、可调整到现有小问的答案与解析。 */
  unmatchedGroups?: ImportUnmatchedGroup[];
  legacyStatus?: string;
  blocked: boolean;
  needsProofread: boolean;
  content?: QuestionContent;
  images: ParsedImage[];
  materials: ImportMaterialSpec[];
}
