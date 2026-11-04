import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { isBlockList, type Block } from "../shared/document";
import { buildSearchText, classificationProblem, isQuestionContent, isClassification, questionContentProblem, questionReadiness, type AnswerStatus, type Classification, type QuestionContent, type Readiness, type ReviewStatus, type SourcePosition, type Stage } from "../shared/question";
import type { Database } from "./database";

export interface QuestionVersionRecord {
  id: string;
  questionId: string;
  version: number;
  content: QuestionContent;
  contentStatus: ReviewStatus;
  answerStatus: AnswerStatus;
  createdAt: string;
}

export interface MaterialVersionRecord {
  id: string;
  materialId: string;
  version: number;
  title: string;
  content: Block[];
  source: string;
  status: ReviewStatus;
  createdAt: string;
}

export interface MaterialInput {
  title: string;
  content: Block[];
  source: string;
}

export interface QuestionUsage {
  questionId: string;
  versionId: string;
  version: number;
  materialVersion: number;
}

export interface QuestionFilter {
  stage?: Stage;
  subject?: string;
  grade?: string;
  examType?: string;
  year?: string;
  sourceName?: string;
  questionType?: string;
  knowledgePoint?: string;
  keyword?: string;
  contentStatus?: ReviewStatus;
  answerStatus?: AnswerStatus;
  limit?: number;
}

export interface QuestionSummary {
  questionId: string;
  versionId: string;
  version: number;
  contentStatus: ReviewStatus;
  answerStatus: AnswerStatus;
  classification: Classification | undefined;
  preview: string;
  source: SourcePosition;
  materialIds: string[];
}

const isReviewStatus = (value: unknown): value is ReviewStatus => value === "draft" || value === "pending" || value === "approved";
const isAnswerStatus = (value: unknown): value is AnswerStatus => value === "missing" || value === "pending" || value === "approved";

const contentTransitions: Record<ReviewStatus, ReviewStatus[]> = {
  draft: ["pending"],
  pending: ["draft", "approved"],
  approved: [],
};
const answerTransitions: Record<AnswerStatus, AnswerStatus[]> = {
  missing: ["pending"],
  pending: ["missing", "approved"],
  approved: [],
};

function materialProblem(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "材料格式无效";
  const input = value as Record<string, unknown>;
  if (!Object.keys(input).every((key) => ["title", "content", "source"].includes(key))) return "材料格式无效";
  if (typeof input.title !== "string" || !input.title.trim() || input.title.length > 200) return "材料标题无效";
  if (typeof input.source !== "string" || input.source.length > 500) return "材料出处无效";
  if (!isBlockList(input.content)) return "材料内容格式无效";
  return null;
}

interface QuestionRow {
  id: string;
  question_id: string;
  version: number;
  content: string;
  content_status: string;
  answer_status: string;
  created_at: string;
}

interface MaterialRow {
  id: string;
  material_id: string;
  version: number;
  title: string;
  content: string;
  source: string;
  status: string;
  created_at: string;
}

/** 题目与材料的主进程写入口：版本只增不改，审核状态独立流转。 */
export class QuestionBank {
  constructor(private readonly db: Database) {}

  createQuestion(content: unknown, classification?: unknown): QuestionVersionRecord {
    const valid = this.validQuestion(content);
    const validClassification = classification === undefined ? undefined : this.validClassification(classification);
    return this.db.transaction((sqlite) => {
      const questionId = randomUUID();
      sqlite.prepare("INSERT INTO questions (id, created_at) VALUES (?, ?)").run(questionId, new Date().toISOString());
      if (validClassification) this.writeClassification(sqlite, questionId, validClassification);
      this.ensureMaterials(sqlite, valid);
      return this.insertQuestionVersion(sqlite, { questionId, version: 1, content: valid, contentStatus: "draft", answerStatus: "missing" });
    });
  }

  saveQuestionVersion(questionId: string, content: unknown): QuestionVersionRecord {
    const valid = this.validQuestion(content);
    return this.db.transaction((sqlite) => {
      const row = this.latestQuestionRow(sqlite, questionId);
      if (row === undefined) throw new Error("题目不存在");
      const previous = this.questionRecord(row);
      this.ensureMaterials(sqlite, valid);
      return this.insertQuestionVersion(sqlite, {
        questionId,
        version: previous.version + 1,
        content: valid,
        ...this.savedStatuses(previous),
      });
    });
  }

  /** 内容版本与分类在同一事务内保存；分类无效时不产生新版本。 */
  saveQuestionVersionWithClassification(questionId: string, content: unknown, classification: unknown): QuestionVersionRecord {
    const valid = this.validQuestion(content);
    const validClassification = this.validClassification(classification);
    return this.db.transaction((sqlite) => {
      const row = this.latestQuestionRow(sqlite, questionId);
      if (row === undefined) throw new Error("题目不存在");
      const previous = this.questionRecord(row);
      this.writeClassification(sqlite, questionId, validClassification);
      this.ensureMaterials(sqlite, valid);
      return this.insertQuestionVersion(sqlite, {
        questionId,
        version: previous.version + 1,
        content: valid,
        ...this.savedStatuses(previous),
      });
    });
  }

  getQuestionVersion(versionId: string): QuestionVersionRecord | undefined {
    const row = this.db.read((sqlite) => sqlite.prepare("SELECT * FROM question_versions WHERE id = ?").get(versionId));
    return row === undefined ? undefined : this.questionRecord(row);
  }

  getLatestQuestionVersion(questionId: string): QuestionVersionRecord | undefined {
    const row = this.db.read((sqlite) => this.latestQuestionRow(sqlite, questionId));
    return row === undefined ? undefined : this.questionRecord(row);
  }

  /** 分类挂在题目身份上，与版本无关；未标分类时返回 undefined。 */
  getQuestionClassification(questionId: string): Classification | undefined {
    return this.db.read((sqlite) => {
      const row = sqlite.prepare("SELECT stage, subject, grade, exam_type, year, source_name, question_type FROM questions WHERE id = ?").get(questionId) as {
        stage: string;
        subject: string;
        grade: string;
        exam_type: string;
        year: string;
        source_name: string;
        question_type: string;
      } | undefined;
      if (row === undefined || row.stage === "") return undefined;
      const knowledgePoints = sqlite.prepare("SELECT value FROM question_knowledge_points WHERE question_id = ? ORDER BY rowid").all(questionId).map((point) => (point as { value: string }).value);
      const value = {
        stage: row.stage,
        subject: row.subject,
        grade: row.grade,
        examType: row.exam_type,
        year: row.year,
        sourceName: row.source_name,
        questionType: row.question_type,
        knowledgePoints,
      };
      if (!isClassification(value)) throw new Error("分类数据损坏");
      return value;
    });
  }

  /** 修改分类只更新题目身份，不生成新版本，也不触碰审核状态。 */
  setClassification(questionId: string, value: unknown): Classification {
    const valid = this.validClassification(value);
    this.db.transaction((sqlite) => this.writeClassification(sqlite, questionId, valid));
    return valid;
  }

  /** 只检索每题最新版本；关键词只查可搜索文本，不涉及答案、解析与材料正文。 */
  searchQuestions(filter: unknown = {}): QuestionSummary[] {
    const valid = this.validFilter(filter);
    const limit = valid.limit ?? 50;
    const rows = this.db.read((sqlite) => {
      const conditions: string[] = [];
      const params: (string | number)[] = [];
      const equals = [
        ["stage", "q.stage"],
        ["subject", "q.subject"],
        ["grade", "q.grade"],
        ["examType", "q.exam_type"],
        ["year", "q.year"],
        ["sourceName", "q.source_name"],
        ["questionType", "q.question_type"],
        ["contentStatus", "qv.content_status"],
        ["answerStatus", "qv.answer_status"],
      ] as const;
      for (const [key, column] of equals) {
        const value = valid[key];
        if (value !== undefined) {
          conditions.push(`${column} = ?`);
          params.push(value);
        }
      }
      if (valid.knowledgePoint !== undefined) {
        conditions.push("EXISTS (SELECT 1 FROM question_knowledge_points kp WHERE kp.question_id = qv.question_id AND kp.value = ?)");
        params.push(valid.knowledgePoint);
      }
      if (valid.keyword !== undefined) {
        conditions.push("instr(qv.search_text, ?) > 0");
        params.push(valid.keyword);
      }
      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      return sqlite.prepare(`
        SELECT qv.id AS versionId, qv.question_id AS questionId, qv.version, qv.content, qv.content_status AS contentStatus, qv.answer_status AS answerStatus, qv.search_text AS searchText
        FROM question_versions qv
        JOIN questions q ON q.id = qv.question_id
        JOIN (SELECT question_id, MAX(version) AS version FROM question_versions GROUP BY question_id) latest
          ON latest.question_id = qv.question_id AND latest.version = qv.version
        ${where}
        ORDER BY qv.created_at DESC
        LIMIT ?
      `).all(...params, limit) as unknown[];
    });
    return rows.map((row) => this.questionSummary(row));
  }

  setContentStatus(versionId: string, status: ReviewStatus): void {
    if (!isReviewStatus(status)) throw new Error("内容审核状态无效");
    this.db.transaction((sqlite) => {
      const row = sqlite.prepare("SELECT content_status FROM question_versions WHERE id = ?").get(versionId) as { content_status: string } | undefined;
      if (row === undefined) throw new Error("题目版本不存在");
      if (!isReviewStatus(row.content_status)) throw new Error("题目审核状态损坏");
      if (row.content_status === status) return;
      if (!contentTransitions[row.content_status].includes(status)) throw new Error(`内容审核状态不能从「${row.content_status}」改为「${status}」`);
      sqlite.prepare("UPDATE question_versions SET content_status = ? WHERE id = ?").run(status, versionId);
    });
  }

  setAnswerStatus(versionId: string, status: AnswerStatus): void {
    if (!isAnswerStatus(status)) throw new Error("答案状态无效");
    this.db.transaction((sqlite) => {
      const row = sqlite.prepare("SELECT answer_status FROM question_versions WHERE id = ?").get(versionId) as { answer_status: string } | undefined;
      if (row === undefined) throw new Error("题目版本不存在");
      if (!isAnswerStatus(row.answer_status)) throw new Error("答案状态损坏");
      if (row.answer_status === status) return;
      if (!answerTransitions[row.answer_status].includes(status)) throw new Error(`答案状态不能从「${row.answer_status}」改为「${status}」`);
      sqlite.prepare("UPDATE question_versions SET answer_status = ? WHERE id = ?").run(status, versionId);
    });
  }

  createMaterial(input: unknown): MaterialVersionRecord {
    const valid = this.validMaterial(input);
    return this.db.transaction((sqlite) => {
      const materialId = randomUUID();
      sqlite.prepare("INSERT INTO materials (id, created_at) VALUES (?, ?)").run(materialId, new Date().toISOString());
      return this.insertMaterialVersion(sqlite, { materialId, version: 1, ...valid, status: "draft" });
    });
  }

  saveMaterialVersion(materialId: string, input: unknown): MaterialVersionRecord {
    const valid = this.validMaterial(input);
    return this.db.transaction((sqlite) => {
      const row = sqlite.prepare("SELECT * FROM material_versions WHERE material_id = ? ORDER BY version DESC LIMIT 1").get(materialId);
      if (row === undefined) throw new Error("材料不存在");
      const previous = this.materialRecord(row);
      return this.insertMaterialVersion(sqlite, { materialId, version: previous.version + 1, ...valid, status: previous.status === "approved" ? "pending" : previous.status });
    });
  }

  getMaterialVersion(versionId: string): MaterialVersionRecord | undefined {
    const row = this.db.read((sqlite) => sqlite.prepare("SELECT * FROM material_versions WHERE id = ?").get(versionId));
    return row === undefined ? undefined : this.materialRecord(row);
  }

  setMaterialStatus(versionId: string, status: ReviewStatus): void {
    if (!isReviewStatus(status)) throw new Error("材料审核状态无效");
    this.db.transaction((sqlite) => {
      const row = sqlite.prepare("SELECT status FROM material_versions WHERE id = ?").get(versionId) as { status: string } | undefined;
      if (row === undefined) throw new Error("材料版本不存在");
      if (!isReviewStatus(row.status)) throw new Error("材料审核状态损坏");
      if (row.status === status) return;
      if (!contentTransitions[row.status].includes(status)) throw new Error(`材料审核状态不能从「${row.status}」改为「${status}」`);
      sqlite.prepare("UPDATE material_versions SET status = ? WHERE id = ?").run(status, versionId);
    });
  }

  /** 列出仍引用旧版材料的题目（只取每题最新版本）。 */
  questionsAffectedByMaterial(materialId: string): QuestionUsage[] {
    return this.db.read((sqlite) => {
      const rows = sqlite.prepare(`
        SELECT qv.question_id AS questionId, qv.id AS versionId, qv.version AS version, MAX(mv.version) AS materialVersion
        FROM question_versions qv
        JOIN question_material_refs ref ON ref.question_version_id = qv.id
        JOIN material_versions mv ON mv.id = ref.material_version_id
        JOIN (SELECT question_id, MAX(version) AS version FROM question_versions GROUP BY question_id) latest
          ON latest.question_id = qv.question_id AND latest.version = qv.version
        WHERE mv.material_id = ?
        GROUP BY qv.question_id
        HAVING MAX(mv.version) < (SELECT MAX(version) FROM material_versions WHERE material_id = ?)
        ORDER BY qv.question_id
      `).all(materialId, materialId) as unknown[];
      return rows.map((row) => {
        const value = row as { questionId: string; versionId: string; version: number; materialVersion: number };
        return { questionId: value.questionId, versionId: value.versionId, version: value.version, materialVersion: value.materialVersion };
      });
    });
  }

  /** 采用指定材料版本：生成新题目版本；已审核题回到待核，旧版本保持原引用。 */
  adoptMaterialVersion(questionId: string, materialId: string, materialVersionId: string): QuestionVersionRecord {
    return this.db.transaction((sqlite) => {
      const row = this.latestQuestionRow(sqlite, questionId);
      if (row === undefined) throw new Error("题目不存在");
      const previous = this.questionRecord(row);
      const target = sqlite.prepare("SELECT material_id FROM material_versions WHERE id = ?").get(materialVersionId) as { material_id: string } | undefined;
      if (target === undefined) throw new Error("材料版本不存在");
      if (target.material_id !== materialId) throw new Error("材料版本不属于该材料");
      if (!previous.content.materials.some((ref) => ref.materialId === materialId)) throw new Error("题目未引用该材料");
      const content: QuestionContent = {
        ...previous.content,
        materials: previous.content.materials.map((ref) => ref.materialId === materialId ? { materialId, versionId: materialVersionId } : ref),
      };
      return this.insertQuestionVersion(sqlite, { questionId, version: previous.version + 1, content, ...this.savedStatuses(previous) });
    });
  }

  checkReady(versionId: string, options: { confirmAnswerGap?: boolean } = {}): Readiness {
    return this.db.read((sqlite) => {
      const row = sqlite.prepare("SELECT * FROM question_versions WHERE id = ?").get(versionId);
      if (row === undefined) throw new Error("题目版本不存在");
      const record = this.questionRecord(row);
      const materialStatuses: Record<string, ReviewStatus | undefined> = {};
      const find = sqlite.prepare("SELECT status FROM material_versions WHERE id = ?");
      for (const ref of record.content.materials) {
        const material = find.get(ref.versionId) as { status: string } | undefined;
        materialStatuses[ref.versionId] = material !== undefined && isReviewStatus(material.status) ? material.status : undefined;
      }
      return questionReadiness({
        content: record.content,
        contentStatus: record.contentStatus,
        answerStatus: record.answerStatus,
        confirmAnswerGap: options.confirmAnswerGap ?? false,
        materialStatuses,
      });
    });
  }

  private savedStatuses(previous: QuestionVersionRecord): { contentStatus: ReviewStatus; answerStatus: AnswerStatus } {
    return {
      contentStatus: previous.contentStatus === "approved" ? "pending" : previous.contentStatus,
      answerStatus: previous.contentStatus === "approved" && previous.answerStatus === "approved" ? "pending" : previous.answerStatus,
    };
  }

  private validQuestion(content: unknown): QuestionContent {
    if (!isQuestionContent(content)) throw new Error(`题目结构无效：${questionContentProblem(content) ?? "未知问题"}`);
    return content;
  }

  private validClassification(value: unknown): Classification {
    const problem = classificationProblem(value);
    if (problem) throw new Error(`分类无效：${problem}`);
    return value as Classification;
  }

  private validFilter(value: unknown): QuestionFilter {
    if (value === undefined) return {};
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("检索条件无效");
    const input = value as Record<string, unknown>;
    const allowed = ["stage", "subject", "grade", "examType", "year", "sourceName", "questionType", "knowledgePoint", "keyword", "contentStatus", "answerStatus", "limit"];
    if (!Object.keys(input).every((key) => allowed.includes(key))) throw new Error("检索条件包含未知字段");
    for (const key of ["subject", "grade", "examType", "year", "sourceName", "questionType", "knowledgePoint", "keyword"]) {
      const item = input[key];
      if (item !== undefined && (typeof item !== "string" || item.length > 200)) throw new Error(`检索条件「${key}」无效`);
    }
    if (input.stage !== undefined && input.stage !== "小学" && input.stage !== "初中" && input.stage !== "高中") throw new Error("检索学段无效");
    if (input.contentStatus !== undefined && !isReviewStatus(input.contentStatus)) throw new Error("检索内容状态无效");
    if (input.answerStatus !== undefined && !isAnswerStatus(input.answerStatus)) throw new Error("检索答案状态无效");
    if (input.limit !== undefined && (typeof input.limit !== "number" || !Number.isInteger(input.limit) || input.limit < 1 || input.limit > 200)) throw new Error("检索数量无效");
    return input as QuestionFilter;
  }

  private questionSummary(row: unknown): QuestionSummary {
    const value = row as { versionId: string; questionId: string; version: number; content: string; contentStatus: string; answerStatus: string; searchText: string };
    let content: unknown;
    try { content = JSON.parse(value.content); } catch { throw new Error("题目版本内容损坏，已保留原数据"); }
    if (!isQuestionContent(content)) throw new Error("题目版本内容损坏，已保留原数据");
    if (!isReviewStatus(value.contentStatus) || !isAnswerStatus(value.answerStatus)) throw new Error("题目审核状态损坏");
    return {
      questionId: value.questionId,
      versionId: value.versionId,
      version: value.version,
      contentStatus: value.contentStatus,
      answerStatus: value.answerStatus,
      classification: this.getQuestionClassification(value.questionId),
      preview: value.searchText.replace(/\s+/g, " ").trim().slice(0, 120),
      source: content.source,
      materialIds: content.materials.map((ref) => ref.materialId),
    };
  }

  private writeClassification(sqlite: DatabaseSync, questionId: string, value: Classification): void {
    const updated = sqlite.prepare("UPDATE questions SET stage = ?, subject = ?, grade = ?, exam_type = ?, year = ?, source_name = ?, question_type = ? WHERE id = ?").run(value.stage, value.subject, value.grade, value.examType, value.year, value.sourceName, value.questionType, questionId);
    if (updated.changes === 0) throw new Error("题目不存在");
    sqlite.prepare("DELETE FROM question_knowledge_points WHERE question_id = ?").run(questionId);
    const insert = sqlite.prepare("INSERT INTO question_knowledge_points (question_id, value) VALUES (?, ?)");
    for (const point of value.knowledgePoints) insert.run(questionId, point);
  }

  private validMaterial(input: unknown): MaterialInput {
    const problem = materialProblem(input);
    if (problem) throw new Error(problem);
    return input as MaterialInput;
  }

  private latestQuestionRow(sqlite: DatabaseSync, questionId: string): unknown {
    return sqlite.prepare("SELECT * FROM question_versions WHERE question_id = ? ORDER BY version DESC LIMIT 1").get(questionId);
  }

  private ensureMaterials(sqlite: DatabaseSync, content: QuestionContent): void {
    const find = sqlite.prepare("SELECT material_id FROM material_versions WHERE id = ?");
    for (const ref of content.materials) {
      const row = find.get(ref.versionId) as { material_id: string } | undefined;
      if (row === undefined) throw new Error(`材料版本不存在：${ref.versionId}`);
      if (row.material_id !== ref.materialId) throw new Error("材料引用与材料身份不一致");
    }
  }

  private insertQuestionVersion(sqlite: DatabaseSync, input: { questionId: string; version: number; content: QuestionContent; contentStatus: ReviewStatus; answerStatus: AnswerStatus }): QuestionVersionRecord {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    sqlite.prepare("INSERT INTO question_versions (id, question_id, version, content, content_status, answer_status, created_at, search_text) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(id, input.questionId, input.version, JSON.stringify(input.content), input.contentStatus, input.answerStatus, createdAt, buildSearchText(input.content));
    const insertRef = sqlite.prepare("INSERT INTO question_material_refs (question_version_id, material_version_id) VALUES (?, ?)");
    for (const ref of input.content.materials) insertRef.run(id, ref.versionId);
    return { id, questionId: input.questionId, version: input.version, content: input.content, contentStatus: input.contentStatus, answerStatus: input.answerStatus, createdAt };
  }

  private insertMaterialVersion(sqlite: DatabaseSync, input: { materialId: string; version: number; title: string; content: Block[]; source: string; status: ReviewStatus }): MaterialVersionRecord {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    sqlite.prepare("INSERT INTO material_versions (id, material_id, version, title, content, source, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(id, input.materialId, input.version, input.title, JSON.stringify(input.content), input.source, input.status, createdAt);
    return { id, materialId: input.materialId, version: input.version, title: input.title, content: input.content, source: input.source, status: input.status, createdAt };
  }

  private questionRecord(row: unknown): QuestionVersionRecord {
    const value = row as QuestionRow;
    let content: unknown;
    try { content = JSON.parse(value.content); } catch { throw new Error("题目版本内容损坏，已保留原数据"); }
    if (!isQuestionContent(content)) throw new Error("题目版本内容损坏，已保留原数据");
    if (!isReviewStatus(value.content_status) || !isAnswerStatus(value.answer_status)) throw new Error("题目审核状态损坏");
    return { id: value.id, questionId: value.question_id, version: value.version, content, contentStatus: value.content_status, answerStatus: value.answer_status, createdAt: value.created_at };
  }

  private materialRecord(row: unknown): MaterialVersionRecord {
    const value = row as MaterialRow;
    let content: unknown;
    try { content = JSON.parse(value.content); } catch { throw new Error("材料内容损坏，已保留原数据"); }
    if (!isBlockList(content)) throw new Error("材料内容损坏，已保留原数据");
    if (!isReviewStatus(value.status)) throw new Error("材料审核状态损坏");
    return { id: value.id, materialId: value.material_id, version: value.version, title: value.title, content, source: value.source, status: value.status, createdAt: value.created_at };
  }
}
