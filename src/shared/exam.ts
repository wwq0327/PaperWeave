import type { Stage } from "./question";

/** 原卷文件角色：原卷、答案、评分细则、答题卡。 */
export type ExamFileRole = "paper" | "answer" | "rubric" | "answer_sheet";

export interface ExamInput {
  title: string;
  stage: Stage;
  subject: string;
  grade: string;
  region: string;
  examType: string;
  year: string;
  sourceName: string;
}

export interface ExamRecord extends ExamInput {
  id: string;
  createdAt: string;
  updatedAt: string;
}

export interface ExamSectionRecord {
  id: string;
  examId: string;
  title: string;
  subject: string;
  position: number;
}

export interface OriginalFileRecord {
  id: string;
  sha256: string;
  relativePath: string;
  originalName: string;
  size: number;
  createdAt: string;
}

export interface ExamFileRecord extends OriginalFileRecord {
  role: ExamFileRole;
}

export interface ExamDetail {
  exam: ExamRecord;
  sections: ExamSectionRecord[];
  files: ExamFileRecord[];
  questionCount: number;
}

/** 渲染进程视图：不含本机文件系统路径。 */
export type OriginalFileView = Omit<OriginalFileRecord, "relativePath">;
export type ExamFileView = Omit<ExamFileRecord, "relativePath">;

export interface ExamDetailView extends Omit<ExamDetail, "files"> {
  files: ExamFileView[];
}

export interface ExamImportResult {
  exam: ExamRecord;
  file: OriginalFileView;
  existing: boolean;
}

export interface ExamAttachment {
  file: ExamFileView;
  existing: boolean;
}

const stages = new Set(["小学", "初中", "高中"]);
const inputKeys = ["title", "stage", "subject", "grade", "region", "examType", "year", "sourceName"];
const fileRoles = new Set(["paper", "answer", "rubric", "answer_sheet"]);

const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown, max: number): value is string => typeof value === "string" && value.length <= max;

/** 考试基本信息校验；地区、题型、年份、来源允许缺省或空串，表示待补。 */
export function examInputProblem(value: unknown): string | null {
  if (!object(value) || !Object.keys(value).every((key) => inputKeys.includes(key))) return "考试信息无效";
  if (!text(value.title, 200) || !value.title.trim()) return "考试标题无效";
  if (typeof value.stage !== "string" || !stages.has(value.stage)) return "学段无效";
  if (!text(value.subject, 200) || !value.subject.trim()) return "学科无效";
  if (!text(value.grade, 200) || !value.grade.trim()) return "年级无效";
  for (const key of ["region", "examType", "year", "sourceName"]) {
    if (value[key] !== undefined && !text(value[key], 200)) return "考试信息无效";
  }
  return null;
}

export function isExamFileRole(value: unknown): value is ExamFileRole {
  return typeof value === "string" && fileRoles.has(value);
}
