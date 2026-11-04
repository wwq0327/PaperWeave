import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { Database } from "./database";
import {
  examInputProblem,
  isExamFileRole,
  type ExamDetail,
  type ExamFileRecord,
  type ExamFileRole,
  type ExamInput,
  type ExamQuestionSummary,
  type ExamRecord,
  type ExamSectionRecord,
  type OriginalFileRecord,
} from "../shared/exam";
import { isQuestionContent, type AnswerStatus, type ReviewStatus, type Stage } from "../shared/question";

const MAX_PDF_BYTES = 100 * 1024 * 1024;
const PDF_HEADER = Buffer.from("%PDF-");
const timestamp = () => new Date().toISOString();
const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");

export interface ImportedExam {
  exam: ExamRecord;
  file: OriginalFileRecord;
  existing: boolean;
}

export interface AttachedFile {
  file: ExamFileRecord;
  existing: boolean;
}

interface ExamRow {
  id: string;
  title: string;
  stage: string;
  subject: string;
  grade: string;
  region: string;
  exam_type: string;
  year: string;
  source_name: string;
  created_at: string;
  updated_at: string;
}

interface FileRow {
  id: string;
  sha256: string;
  relative_path: string;
  original_name: string;
  size: number;
  created_at: string;
}

interface SectionRow {
  id: string;
  exam_id: string;
  title: string;
  subject: string;
  position: number;
}

interface QuestionRow {
  question_id: string;
  version_id: string;
  version: number;
  section_id: string | null;
  content_status: string;
  answer_status: string;
  content: string;
  search_text: string;
}

const reviewStatuses = new Set(["draft", "pending", "approved"]);
const answerStatuses = new Set(["missing", "pending", "approved"]);

function validExamInput(value: unknown): ExamInput {
  const problem = examInputProblem(value);
  if (problem) throw new Error(problem);
  const input = value as ExamInput;
  return {
    title: input.title.trim(),
    stage: input.stage,
    subject: input.subject.trim(),
    grade: input.grade.trim(),
    region: (input.region ?? "").trim(),
    examType: (input.examType ?? "").trim(),
    year: (input.year ?? "").trim(),
    sourceName: (input.sourceName ?? "").trim(),
  };
}

function readSourcePdf(path: unknown): { bytes: Buffer; originalName: string } {
  if (typeof path !== "string" || !path) throw new Error("原卷文件无效");
  let stats;
  try {
    stats = statSync(path);
  } catch {
    throw new Error("无法读取 PDF 文件");
  }
  if (!stats.isFile()) throw new Error("原卷必须是 PDF 文件");
  if (stats.size === 0) throw new Error("PDF 文件为空");
  if (stats.size > MAX_PDF_BYTES) throw new Error("PDF 文件超过 100 MiB");
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch {
    throw new Error("无法读取 PDF 文件");
  }
  if (bytes.length < PDF_HEADER.length || !bytes.subarray(0, PDF_HEADER.length).equals(PDF_HEADER)) throw new Error("原卷必须是 PDF 文件");
  return { bytes, originalName: basename(path) };
}

/** 考试与原卷文件的主进程入口：文件按指纹去重，读取时校验完整性。 */
export class ExamStore {
  private readonly originals: string;

  constructor(private readonly db: Database, userData: string) {
    this.originals = join(userData, "originals");
  }

  importPaper(input: unknown, sourcePath: unknown): ImportedExam {
    const valid = validExamInput(input);
    const { bytes, originalName } = readSourcePdf(sourcePath);
    const sha = sha256(bytes);
    const existingFile = this.fileBySha(sha);
    if (existingFile) {
      this.readFile(existingFile.id);
      const paper = this.paperExam(existingFile.id);
      if (paper) return { exam: paper, file: existingFile, existing: true };
      const exam = this.db.transaction((sqlite) => this.createExam(sqlite, valid, existingFile));
      return { exam, file: existingFile, existing: false };
    }

    const copy = this.storeCopy(sha, bytes);
    try {
      return this.db.transaction((sqlite) => {
        const file = this.fileBySha(sha, sqlite) ?? this.insertFile(sqlite, sha, copy.relativePath, originalName, bytes.length);
        const paper = this.paperExam(file.id, sqlite);
        if (paper) return { exam: paper, file, existing: true };
        return { exam: this.createExam(sqlite, valid, file), file, existing: false };
      });
    } catch (error) {
      if (copy.created) rmSync(copy.path, { force: true });
      throw error;
    }
  }

  attachFile(examId: string, role: unknown, sourcePath: unknown): AttachedFile {
    const exam = this.requireExam(examId);
    if (!isExamFileRole(role)) throw new Error("文件角色无效");
    const { bytes, originalName } = readSourcePdf(sourcePath);
    const sha = sha256(bytes);
    const existingFile = this.fileBySha(sha);
    if (existingFile) this.readFile(existingFile.id);
    const copy = existingFile ? undefined : this.storeCopy(sha, bytes);
    try {
      return this.db.transaction((sqlite) => {
        const file = this.fileBySha(sha, sqlite) ?? this.insertFile(sqlite, sha, copy!.relativePath, originalName, bytes.length);
        if (role === "paper") {
          const current = sqlite.prepare("SELECT file_id FROM exam_originals WHERE exam_id = ? AND role = 'paper'").get(exam) as { file_id: string } | undefined;
          if (current !== undefined && current.file_id !== file.id) throw new Error("该考试已有原卷，不能静默替换");
          const owner = sqlite.prepare("SELECT exam_id FROM exam_originals WHERE file_id = ? AND role = 'paper' AND exam_id <> ?").get(file.id, exam) as { exam_id: string } | undefined;
          if (owner !== undefined) throw new Error("该原卷已属于另一场考试");
        }
        const result = sqlite.prepare("INSERT OR IGNORE INTO exam_originals (exam_id, file_id, role, created_at) VALUES (?, ?, ?, ?)").run(exam, file.id, role, timestamp());
        sqlite.prepare("UPDATE exams SET updated_at = ? WHERE id = ?").run(timestamp(), exam);
        return { file: { ...file, role }, existing: result.changes === 0 };
      });
    } catch (error) {
      if (copy?.created) rmSync(copy.path, { force: true });
      throw error;
    }
  }

  listExams(): ExamRecord[] {
    const rows = this.db.read((sqlite) => sqlite.prepare("SELECT * FROM exams ORDER BY updated_at DESC, title").all() as unknown as ExamRow[]);
    return rows.map((row) => this.examRecord(row));
  }

  getExam(examId: string): ExamDetail {
    if (typeof examId !== "string" || !examId) throw new Error("考试标识无效");
    return this.db.read((sqlite) => {
      const row = sqlite.prepare("SELECT * FROM exams WHERE id = ?").get(examId) as ExamRow | undefined;
      if (row === undefined) throw new Error("考试不存在");
      const sections = (sqlite.prepare("SELECT * FROM exam_sections WHERE exam_id = ? ORDER BY position, id").all(examId) as unknown as SectionRow[]).map((section) => this.sectionRecord(section));
      const files = (sqlite.prepare(`
        SELECT f.*, eo.role FROM exam_originals eo
        JOIN original_files f ON f.id = eo.file_id
        WHERE eo.exam_id = ? ORDER BY eo.role, eo.created_at, f.original_name
      `).all(examId) as unknown as (FileRow & { role: ExamFileRole })[]).map((file) => ({ ...this.fileRecord(file), role: file.role }));
      const { count } = sqlite.prepare("SELECT count(*) AS count FROM question_exams WHERE exam_id = ?").get(examId) as { count: number };
      return { exam: this.examRecord(row), sections, files, questionCount: count };
    });
  }

  /** 该考试已关联题目的最新版本，按关联顺序返回。 */
  listQuestions(examId: string): ExamQuestionSummary[] {
    if (typeof examId !== "string" || !examId) throw new Error("考试标识无效");
    return this.db.read((sqlite) => {
      if (sqlite.prepare("SELECT 1 FROM exams WHERE id = ?").get(examId) === undefined) throw new Error("考试不存在");
      const rows = sqlite.prepare(`
        SELECT qe.question_id, qe.section_id, qv.id AS version_id, qv.version,
          qv.content_status, qv.answer_status, qv.content, qv.search_text
        FROM question_exams qe
        JOIN question_versions qv ON qv.question_id = qe.question_id
        JOIN (SELECT question_id, MAX(version) AS version FROM question_versions GROUP BY question_id) latest
          ON latest.question_id = qv.question_id AND latest.version = qv.version
        WHERE qe.exam_id = ?
        ORDER BY qe.created_at, qv.created_at
      `).all(examId) as unknown as QuestionRow[];
      return rows.map((row) => {
        let content: unknown;
        try { content = JSON.parse(row.content); } catch { throw new Error("题目内容损坏，已保留原数据"); }
        if (!isQuestionContent(content)) throw new Error("题目内容损坏，已保留原数据");
        if (!reviewStatuses.has(row.content_status) || !answerStatuses.has(row.answer_status)) throw new Error("题目审核状态损坏");
        return {
          questionId: row.question_id,
          versionId: row.version_id,
          version: row.version,
          sectionId: row.section_id,
          contentStatus: row.content_status as ReviewStatus,
          answerStatus: row.answer_status as AnswerStatus,
          preview: row.search_text.replace(/\s+/g, " ").trim().slice(0, 120),
          source: content.source,
        };
      });
    });
  }

  /** 同一考试、同一分部、同一原题号的已有题；不同考试或分部不算重复。 */
  findDuplicate(examId: string, sectionId: string, originalNumber: string): ExamQuestionSummary | undefined {
    const number = originalNumber.trim();
    if (!number) return undefined;
    return this.listQuestions(examId).find((question) =>
      question.sectionId === sectionId && question.source.originalNumber.trim() === number);
  }

  addSection(examId: string, title: unknown, subject?: unknown): ExamSectionRecord {    const exam = this.requireExam(examId);
    if (typeof title !== "string" || !title.trim() || title.length > 200) throw new Error("分部标题无效");
    if (subject !== undefined && (typeof subject !== "string" || subject.length > 200)) throw new Error("分部学科无效");
    return this.db.transaction((sqlite) => {
      const { position } = sqlite.prepare("SELECT COALESCE(MAX(position), 0) + 1 AS position FROM exam_sections WHERE exam_id = ?").get(exam) as { position: number };
      const record: ExamSectionRecord = {
        id: randomUUID(),
        examId: exam,
        title: title.trim(),
        subject: typeof subject === "string" ? subject.trim() : "",
        position,
      };
      sqlite.prepare("INSERT INTO exam_sections (id, exam_id, title, subject, position) VALUES (?, ?, ?, ?, ?)").run(record.id, record.examId, record.title, record.subject, record.position);
      sqlite.prepare("UPDATE exams SET updated_at = ? WHERE id = ?").run(timestamp(), exam);
      return record;
    });
  }

  /** 将题目身份关联到考试分部；同一题目重复关联时只更新分部。 */
  linkQuestion(questionId: string, examId: string, sectionId: string): void {
    if (typeof questionId !== "string" || !questionId) throw new Error("题目标识无效");
    const exam = this.requireExam(examId);
    this.db.transaction((sqlite) => {
      const section = sqlite.prepare("SELECT 1 FROM exam_sections WHERE id = ? AND exam_id = ?").get(sectionId, exam);
      if (section === undefined) throw new Error("考试分部不存在");
      if (sqlite.prepare("SELECT 1 FROM questions WHERE id = ?").get(questionId) === undefined) throw new Error("题目不存在");
      sqlite.prepare(`
        INSERT INTO question_exams (question_id, exam_id, section_id, created_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(question_id, exam_id) DO UPDATE SET section_id = excluded.section_id
      `).run(questionId, exam, sectionId, timestamp());
      sqlite.prepare("UPDATE exams SET updated_at = ? WHERE id = ?").run(timestamp(), exam);
    });
  }

  readFile(fileId: string): { file: OriginalFileRecord; data: Buffer } {
    if (typeof fileId !== "string" || !fileId) throw new Error("原卷文件无效");
    const row = this.db.read((sqlite) => sqlite.prepare("SELECT * FROM original_files WHERE id = ?").get(fileId) as FileRow | undefined);
    if (row === undefined) throw new Error("原卷文件不存在");
    const file = this.fileRecord(row);
    const data = readFileSync(this.storedPath(file));
    if (data.length !== file.size || sha256(data) !== file.sha256) throw new Error("校验失败：原卷内容与记录不一致");
    return { file, data };
  }

  private requireExam(examId: string): string {
    if (typeof examId !== "string" || !examId) throw new Error("考试标识无效");
    const row = this.db.read((sqlite) => sqlite.prepare("SELECT 1 FROM exams WHERE id = ?").get(examId));
    if (row === undefined) throw new Error("考试不存在");
    return examId;
  }

  private createExam(sqlite: DatabaseSync, input: ExamInput, file: OriginalFileRecord): ExamRecord {
    const id = randomUUID();
    const at = timestamp();
    sqlite.prepare(`
      INSERT INTO exams (id, title, stage, subject, grade, region, exam_type, year, source_name, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, input.title, input.stage, input.subject, input.grade, input.region, input.examType, input.year, input.sourceName, at, at);
    sqlite.prepare("INSERT INTO exam_sections (id, exam_id, title, subject, position) VALUES (?, ?, ?, ?, 1)").run(randomUUID(), id, "全卷", input.subject);
    sqlite.prepare("INSERT INTO exam_originals (exam_id, file_id, role, created_at) VALUES (?, ?, 'paper', ?)").run(id, file.id, at);
    return this.examRecord(sqlite.prepare("SELECT * FROM exams WHERE id = ?").get(id) as unknown as ExamRow);
  }

  private paperExam(fileId: string, sqlite?: DatabaseSync): ExamRecord | undefined {
    const query = (db: DatabaseSync) => db.prepare(`
      SELECT e.* FROM exam_originals eo JOIN exams e ON e.id = eo.exam_id
      WHERE eo.file_id = ? AND eo.role = 'paper' ORDER BY eo.created_at, e.id LIMIT 1
    `).get(fileId) as ExamRow | undefined;
    const row = sqlite === undefined ? this.db.read(query) : query(sqlite);
    return row === undefined ? undefined : this.examRecord(row);
  }

  private fileBySha(sha: string, sqlite?: DatabaseSync): OriginalFileRecord | undefined {
    const query = (db: DatabaseSync) => db.prepare("SELECT * FROM original_files WHERE sha256 = ?").get(sha) as FileRow | undefined;
    const row = sqlite === undefined ? this.db.read(query) : query(sqlite);
    return row === undefined ? undefined : this.fileRecord(row);
  }

  private insertFile(sqlite: DatabaseSync, sha: string, relativePath: string, originalName: string, size: number): OriginalFileRecord {
    const record: OriginalFileRecord = { id: randomUUID(), sha256: sha, relativePath, originalName, size, createdAt: timestamp() };
    sqlite.prepare("INSERT INTO original_files (id, sha256, relative_path, original_name, size, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(record.id, record.sha256, record.relativePath, record.originalName, record.size, record.createdAt);
    return record;
  }

  private storeCopy(sha: string, bytes: Buffer): { relativePath: string; path: string; created: boolean } {
    mkdirSync(this.originals, { recursive: true });
    const relativePath = `originals/${sha}.pdf`;
    const target = join(this.originals, `${sha}.pdf`);
    if (existsSync(target)) {
      if (sha256(readFileSync(target)) !== sha) throw new Error("原卷存储校验失败");
      return { relativePath, path: target, created: false };
    }
    const temp = join(this.originals, `.tmp-${randomUUID()}`);
    try {
      writeFileSync(temp, bytes, { flag: "wx" });
      if (sha256(readFileSync(temp)) !== sha) throw new Error("原卷写入校验失败");
      renameSync(temp, target);
    } catch (error) {
      rmSync(temp, { force: true });
      throw error;
    }
    return { relativePath, path: target, created: true };
  }

  private storedPath(file: OriginalFileRecord): string {
    if (file.relativePath !== `originals/${file.sha256}.pdf`) throw new Error("原卷路径无效");
    const path = join(this.originals, `${file.sha256}.pdf`);
    let stats;
    try {
      stats = lstatSync(path);
    } catch {
      throw new Error("原卷文件缺失");
    }
    if (!stats.isFile() || stats.isSymbolicLink()) throw new Error("原卷文件异常");
    if (stats.size !== file.size) throw new Error("校验失败：原卷大小与记录不一致");
    return path;
  }

  private examRecord(row: ExamRow): ExamRecord {
    return {
      id: row.id,
      title: row.title,
      stage: row.stage as Stage,
      subject: row.subject,
      grade: row.grade,
      region: row.region,
      examType: row.exam_type,
      year: row.year,
      sourceName: row.source_name,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private fileRecord(row: FileRow): OriginalFileRecord {
    return {
      id: row.id,
      sha256: row.sha256,
      relativePath: row.relative_path,
      originalName: row.original_name,
      size: row.size,
      createdAt: row.created_at,
    };
  }

  private sectionRecord(row: SectionRow): ExamSectionRecord {
    return { id: row.id, examId: row.exam_id, title: row.title, subject: row.subject, position: row.position };
  }
}
