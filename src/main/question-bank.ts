import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { isBlockList, type Block } from "../shared/document";
import { isQuestionContent, questionContentProblem, type AnswerStatus, type QuestionContent, type ReviewStatus } from "../shared/question";
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

  createQuestion(content: unknown): QuestionVersionRecord {
    const valid = this.validQuestion(content);
    return this.db.transaction((sqlite) => {
      const questionId = randomUUID();
      sqlite.prepare("INSERT INTO questions (id, created_at) VALUES (?, ?)").run(questionId, new Date().toISOString());
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
        contentStatus: previous.contentStatus === "approved" ? "pending" : previous.contentStatus,
        answerStatus: previous.contentStatus === "approved" && previous.answerStatus === "approved" ? "pending" : previous.answerStatus,
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

  private validQuestion(content: unknown): QuestionContent {
    if (!isQuestionContent(content)) throw new Error(`题目结构无效：${questionContentProblem(content) ?? "未知问题"}`);
    return content;
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
    sqlite.prepare("INSERT INTO question_versions (id, question_id, version, content, content_status, answer_status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(id, input.questionId, input.version, JSON.stringify(input.content), input.contentStatus, input.answerStatus, createdAt);
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
