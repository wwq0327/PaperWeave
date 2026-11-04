import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  paperDefaultScore,
  paperScoringState,
  scoreConflicts,
  type BlankSpace,
  type PaperScoring,
  type PaperScoringState,
  type ScoreConflict,
} from "../shared/paper";
import type { QuestionContent, ScoringPoint, Stage } from "../shared/question";
import type { Database } from "./database";
import { QuestionBank } from "./question-bank";

export type { BlankSpace };

export interface PaperRecord {
  id: string;
  title: string;
  stage: Stage;
  subject: string;
  grade: string;
  createdAt: string;
  updatedAt: string;
}

export interface PaperSectionRecord {
  id: string;
  paperId: string;
  title: string;
  position: number;
}

export interface ConfirmedScoreConflict extends ScoreConflict {
  confirmed: boolean;
}

export interface PaperItemRecord {
  id: string;
  paperId: string;
  sectionId: string;
  position: number;
  questionId: string;
  questionVersionId: string;
  subQuestionIds: string[];
  score: number;
  blankSpace: BlankSpace;
  scoring: PaperScoring;
  defaultScore: number;
  scoringState: PaperScoringState;
  scoreConflictConfirmations: string[];
  scoreConflicts: ConfirmedScoreConflict[];
  content: QuestionContent;
  createdAt: string;
}

export interface PaperDetail {
  paper: PaperRecord;
  sections: (PaperSectionRecord & { items: PaperItemRecord[] })[];
  totalScore: number;
}

interface PaperRow {
  id: string;
  title: string;
  stage: Stage;
  subject: string;
  grade: string;
  created_at: string;
  updated_at: string;
}

interface SectionRow {
  id: string;
  paper_id: string;
  title: string;
  position: number;
}

interface ItemRow {
  id: string;
  paper_id: string;
  section_id: string;
  position: number;
  question_id: string;
  question_version_id: string;
  sub_question_ids: string;
  score: number;
  blank_space: BlankSpace;
  scoring: string;
  score_conflict_confirmations: string;
  created_at: string;
}

const stages = new Set<Stage>(["小学", "初中", "高中"]);
const roundScore = (value: number) => Math.round(value * 100) / 100;

/** 组卷草稿：题目版本快照、卷内分值与评分数据；不改写题库内容。 */
export class Paper {
  private readonly bank: QuestionBank;

  constructor(private readonly db: Database) {
    this.bank = new QuestionBank(db);
  }

  createPaper(input: { title: string; stage: Stage; subject: string; grade: string }): PaperRecord {
    if (typeof input.title !== "string" || !input.title.trim() || input.title.length > 200) throw new Error("试卷标题无效");
    if (!stages.has(input.stage)) throw new Error("试卷学段无效");
    if (typeof input.subject !== "string" || !input.subject.trim() || input.subject.length > 200) throw new Error("试卷学科无效");
    if (typeof input.grade !== "string" || !input.grade.trim() || input.grade.length > 200) throw new Error("试卷年级无效");
    const now = new Date().toISOString();
    const paper: PaperRecord = {
      id: randomUUID(),
      title: input.title.trim(),
      stage: input.stage,
      subject: input.subject.trim(),
      grade: input.grade.trim(),
      createdAt: now,
      updatedAt: now,
    };
    this.db.transaction((sqlite) => {
      sqlite.prepare("INSERT INTO papers (id, title, stage, subject, grade, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(paper.id, paper.title, paper.stage, paper.subject, paper.grade, paper.createdAt, paper.updatedAt);
    });
    return paper;
  }

  listPapers(): PaperRecord[] {
    return this.db.read((sqlite) => {
      const rows = sqlite.prepare("SELECT * FROM papers ORDER BY updated_at DESC, id").all() as unknown as PaperRow[];
      return rows.map((row) => ({
        id: row.id,
        title: row.title,
        stage: row.stage,
        subject: row.subject,
        grade: row.grade,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
    });
  }

  addSection(paperId: string, title: string): PaperSectionRecord {
    if (typeof title !== "string" || !title.trim() || title.length > 200) throw new Error("小节标题无效");
    return this.db.transaction((sqlite) => {
      this.paperRow(sqlite, paperId);
      const next = sqlite.prepare("SELECT COALESCE(MAX(position), 0) + 1 AS position FROM paper_sections WHERE paper_id = ?").get(paperId) as { position: number };
      const section: PaperSectionRecord = { id: randomUUID(), paperId, title: title.trim(), position: next.position };
      sqlite.prepare("INSERT INTO paper_sections (id, paper_id, title, position) VALUES (?, ?, ?, ?)").run(section.id, paperId, section.title, section.position);
      this.touch(sqlite, paperId);
      return section;
    });
  }

  removeSection(sectionId: string): void {
    this.db.transaction((sqlite) => {
      const section = this.sectionRow(sqlite, sectionId);
      const count = sqlite.prepare("SELECT COUNT(*) AS count FROM paper_items WHERE section_id = ?").get(sectionId) as { count: number };
      if (count.count > 0) throw new Error("小节内仍有题目，不能删除");
      sqlite.prepare("DELETE FROM paper_sections WHERE id = ?").run(sectionId);
      this.renumber(sqlite, "paper_sections", section.paper_id);
      this.touch(sqlite, section.paper_id);
    });
  }

  addBasketItem(paperId: string, sectionId: string, basketItemId: string, scoreOverride?: number): PaperItemRecord {
    return this.db.transaction((sqlite) => {
      const paper = this.paperRow(sqlite, paperId);
      const section = this.sectionRow(sqlite, sectionId);
      if (section.paper_id !== paperId) throw new Error("小节不属于该试卷");
      const basket = sqlite.prepare("SELECT question_id, question_version_id, sub_question_ids FROM basket_items WHERE id = ?").get(basketItemId) as
        | { question_id: string; question_version_id: string; sub_question_ids: string }
        | undefined;
      if (basket === undefined) throw new Error("题篮项不存在");
      const version = this.bank.getQuestionVersion(basket.question_version_id);
      if (version === undefined || version.questionId !== basket.question_id) throw new Error("题目版本不存在");
      const classification = this.bank.getQuestionClassification(basket.question_id);
      if (classification === undefined) throw new Error("题目缺少分类，不能组卷");
      if (classification.subject !== paper.subject) throw new Error("题目学科与试卷不一致");
      if (classification.stage !== paper.stage || classification.grade !== paper.grade) throw new Error("题目学段或年级与试卷不一致");

      const subQuestionIds = JSON.parse(basket.sub_question_ids) as string[];
      if (scoreOverride !== undefined && (!Number.isFinite(scoreOverride) || scoreOverride < 0 || scoreOverride > 1000)) {
        throw new Error("卷内分值必须是 0 到 1000 之间的数字");
      }
      const defaultScore = paperDefaultScore(version.content, subQuestionIds);
      let itemScore: number;
      if (defaultScore.conflict !== null) {
        if (scoreOverride === undefined) throw new Error(`${defaultScore.conflict}；请填写卷内分值后加入`);
        itemScore = Math.round(scoreOverride * 100) / 100;
      } else {
        itemScore = scoreOverride === undefined ? defaultScore.score : Math.round(scoreOverride * 100) / 100;
      }
      const next = sqlite.prepare("SELECT COALESCE(MAX(position), 0) + 1 AS position FROM paper_items WHERE section_id = ?").get(sectionId) as { position: number };
      const row: ItemRow = {
        id: randomUUID(),
        paper_id: paperId,
        section_id: sectionId,
        position: next.position,
        question_id: basket.question_id,
        question_version_id: basket.question_version_id,
        sub_question_ids: JSON.stringify(subQuestionIds),
        score: itemScore,
        blank_space: "medium",
        scoring: JSON.stringify({ mode: "original" } satisfies PaperScoring),
        score_conflict_confirmations: "[]",
        created_at: new Date().toISOString(),
      };
      sqlite.prepare("INSERT INTO paper_items (id, paper_id, section_id, position, question_id, question_version_id, sub_question_ids, score, blank_space, scoring, score_conflict_confirmations, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(row.id, row.paper_id, row.section_id, row.position, row.question_id, row.question_version_id, row.sub_question_ids, row.score, row.blank_space, row.scoring, row.score_conflict_confirmations, row.created_at);
      this.touch(sqlite, paperId);
      return this.itemRecord(row, version.content);
    });
  }

  removeItem(itemId: string): void {
    this.db.transaction((sqlite) => {
      const item = this.itemRow(sqlite, itemId);
      sqlite.prepare("DELETE FROM paper_items WHERE id = ?").run(itemId);
      this.renumber(sqlite, "paper_items", item.section_id, "section_id");
      this.touch(sqlite, item.paper_id);
    });
  }

  /** position 为 1 起的插入位置；越界时夹到小节首尾。 */
  moveItem(itemId: string, sectionId: string, position: number): void {
    if (!Number.isInteger(position) || position < 1) throw new Error("题目位置无效");
    this.db.transaction((sqlite) => {
      const item = this.itemRow(sqlite, itemId);
      const target = this.sectionRow(sqlite, sectionId);
      if (target.paper_id !== item.paper_id) throw new Error("小节不属于该试卷");
      if (item.section_id === sectionId) {
        const rows = sqlite.prepare("SELECT id FROM paper_items WHERE section_id = ? AND id <> ? ORDER BY position, id").all(sectionId, itemId) as { id: string }[];
        rows.splice(Math.min(position - 1, rows.length), 0, { id: itemId });
        rows.forEach((row, index) => sqlite.prepare("UPDATE paper_items SET section_id = ?, position = ? WHERE id = ?").run(sectionId, index + 1, row.id));
      } else {
        const sourceRows = (sqlite.prepare("SELECT id FROM paper_items WHERE section_id = ? ORDER BY position, id").all(item.section_id) as { id: string }[])
          .filter((row) => row.id !== itemId);
        sourceRows.forEach((row, index) => sqlite.prepare("UPDATE paper_items SET position = ? WHERE id = ?").run(index + 1, row.id));
        const targetRows = sqlite.prepare("SELECT id FROM paper_items WHERE section_id = ? ORDER BY position, id").all(sectionId) as { id: string }[];
        targetRows.splice(Math.min(position - 1, targetRows.length), 0, { id: itemId });
        targetRows.forEach((row, index) => sqlite.prepare("UPDATE paper_items SET section_id = ?, position = ? WHERE id = ?").run(sectionId, index + 1, row.id));
      }
      this.touch(sqlite, item.paper_id);
    });
  }

  /** 改卷内分值；回到默认分值时恢复沿用题库评分点。 */
  setItemScore(itemId: string, score: number): PaperItemRecord {
    if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 1000) throw new Error("卷内分值无效");
    return this.db.transaction((sqlite) => {
      const item = this.itemRow(sqlite, itemId);
      const version = this.bank.getQuestionVersion(item.question_version_id);
      if (version === undefined) throw new Error("题目版本不存在");
      const defaultScore = paperDefaultScore(version.content, JSON.parse(item.sub_question_ids) as string[]).score;
      const scoring: PaperScoring = score === defaultScore ? { mode: "original" } : this.parseScoring(item.scoring);
      sqlite.prepare("UPDATE paper_items SET score = ?, scoring = ? WHERE id = ?").run(roundScore(score), JSON.stringify(scoring), itemId);
      this.touch(sqlite, item.paper_id);
      return this.itemRecord({ ...item, score: roundScore(score), scoring: JSON.stringify(scoring) }, version.content);
    });
  }

  setItemBlankSpace(itemId: string, blankSpace: BlankSpace): PaperItemRecord {
    if (!(["none", "small", "medium", "large"] as const).includes(blankSpace)) throw new Error("留白档位无效");
    return this.db.transaction((sqlite) => {
      const item = this.itemRow(sqlite, itemId);
      const version = this.bank.getQuestionVersion(item.question_version_id);
      if (version === undefined) throw new Error("题目版本不存在");
      sqlite.prepare("UPDATE paper_items SET blank_space = ? WHERE id = ?").run(blankSpace, itemId);
      this.touch(sqlite, item.paper_id);
      return this.itemRecord({ ...item, blank_space: blankSpace }, version.content);
    });
  }

  setItemScoring(itemId: string, scoring: PaperScoring): PaperItemRecord {
    const valid = this.validScoring(scoring);
    return this.db.transaction((sqlite) => {
      const item = this.itemRow(sqlite, itemId);
      if (valid.mode === "adjusted") {
        const total = roundScore(valid.points.reduce((sum, point) => sum + point.score, 0));
        if (total !== item.score) throw new Error("评分点合计与卷内分值不一致");
      }
      const version = this.bank.getQuestionVersion(item.question_version_id);
      if (version === undefined) throw new Error("题目版本不存在");
      sqlite.prepare("UPDATE paper_items SET scoring = ? WHERE id = ?").run(JSON.stringify(valid), itemId);
      this.touch(sqlite, item.paper_id);
      return this.itemRecord({ ...item, scoring: JSON.stringify(valid) }, version.content);
    });
  }

  confirmScoreConflict(itemId: string, key: string): PaperItemRecord {
    return this.db.transaction((sqlite) => {
      const item = this.itemRow(sqlite, itemId);
      const version = this.bank.getQuestionVersion(item.question_version_id);
      if (version === undefined) throw new Error("题目版本不存在");
      const conflicts = scoreConflicts(version.content, JSON.parse(item.sub_question_ids) as string[], item.score);
      if (!conflicts.some((conflict) => conflict.key === key)) throw new Error("分值冲突不存在");
      const confirmations = this.parseConfirmations(item.score_conflict_confirmations);
      if (!confirmations.includes(key)) confirmations.push(key);
      sqlite.prepare("UPDATE paper_items SET score_conflict_confirmations = ? WHERE id = ?").run(JSON.stringify(confirmations), itemId);
      this.touch(sqlite, item.paper_id);
      return this.itemRecord({ ...item, score_conflict_confirmations: JSON.stringify(confirmations) }, version.content);
    });
  }

  getPaper(paperId: string): PaperDetail {
    return this.db.read((sqlite) => {
      const paper = this.paperRow(sqlite, paperId);
      const sections = sqlite.prepare("SELECT * FROM paper_sections WHERE paper_id = ? ORDER BY position, id").all(paperId) as unknown as SectionRow[];
      const items = sqlite.prepare("SELECT * FROM paper_items WHERE paper_id = ? ORDER BY section_id, position, id").all(paperId) as unknown as ItemRow[];
      let totalScore = 0;
      const detail: PaperDetail = {
        paper,
        sections: sections.map((section) => ({
          id: section.id,
          paperId: section.paper_id,
          title: section.title,
          position: section.position,
          items: items.filter((item) => item.section_id === section.id).map((item) => {
            const version = this.bank.getQuestionVersion(item.question_version_id);
            if (version === undefined) throw new Error("试卷数据损坏");
            totalScore = roundScore(totalScore + item.score);
            return this.itemRecord(item, version.content);
          }),
        })),
        totalScore: 0,
      };
      detail.totalScore = totalScore;
      return detail;
    });
  }

  private itemRecord(row: ItemRow, content: QuestionContent): PaperItemRecord {
    const subQuestionIds = JSON.parse(row.sub_question_ids) as string[];
    const scoring = this.parseScoring(row.scoring);
    const defaultScore = paperDefaultScore(content, subQuestionIds).score;
    const confirmations = this.parseConfirmations(row.score_conflict_confirmations);
    return {
      id: row.id,
      paperId: row.paper_id,
      sectionId: row.section_id,
      position: row.position,
      questionId: row.question_id,
      questionVersionId: row.question_version_id,
      subQuestionIds,
      score: row.score,
      blankSpace: row.blank_space,
      scoring,
      defaultScore,
      scoringState: paperScoringState(row.score, defaultScore, scoring),
      scoreConflictConfirmations: confirmations,
      scoreConflicts: scoreConflicts(content, subQuestionIds, row.score).map((conflict) => ({
        ...conflict,
        confirmed: confirmations.includes(conflict.key),
      })),
      content,
      createdAt: row.created_at,
    };
  }

  private paperRow(sqlite: DatabaseSync, paperId: string): PaperRecord {
    const row = sqlite.prepare("SELECT * FROM papers WHERE id = ?").get(paperId) as unknown as PaperRow | undefined;
    if (row === undefined) throw new Error("试卷不存在");
    return {
      id: row.id,
      title: row.title,
      stage: row.stage,
      subject: row.subject,
      grade: row.grade,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private sectionRow(sqlite: DatabaseSync, sectionId: string): SectionRow {
    const row = sqlite.prepare("SELECT * FROM paper_sections WHERE id = ?").get(sectionId) as unknown as SectionRow | undefined;
    if (row === undefined) throw new Error("小节不存在");
    return row;
  }

  private itemRow(sqlite: DatabaseSync, itemId: string): ItemRow {
    const row = sqlite.prepare("SELECT * FROM paper_items WHERE id = ?").get(itemId) as unknown as ItemRow | undefined;
    if (row === undefined) throw new Error("题目不在试卷中");
    return row;
  }

  private touch(sqlite: DatabaseSync, paperId: string): void {
    sqlite.prepare("UPDATE papers SET updated_at = ? WHERE id = ?").run(new Date().toISOString(), paperId);
  }

  private renumber(sqlite: DatabaseSync, table: "paper_sections" | "paper_items", parentId: string, column = "paper_id"): void {
    const rows = sqlite.prepare(`SELECT id FROM ${table} WHERE ${column} = ? ORDER BY position, id`).all(parentId) as { id: string }[];
    rows.forEach((row, index) => sqlite.prepare(`UPDATE ${table} SET position = ? WHERE id = ?`).run(index + 1, row.id));
  }

  private parseScoring(raw: string): PaperScoring {
    try {
      const value = JSON.parse(raw) as PaperScoring;
      if (value.mode === "original" || value.mode === "answerOnly") return value;
      if (value.mode === "adjusted" && Array.isArray(value.points)) return value;
    } catch {
      // 落到统一错误
    }
    throw new Error("试卷数据损坏");
  }

  private validScoring(scoring: PaperScoring): PaperScoring {
    if (scoring.mode === "original") return { mode: "original" };
    if (scoring.mode === "answerOnly") {
      if (scoring.note !== undefined && (typeof scoring.note !== "string" || scoring.note.length > 500)) throw new Error("评分说明无效");
      return scoring.note === undefined ? { mode: "answerOnly" } : { mode: "answerOnly", note: scoring.note };
    }
    if (scoring.mode === "adjusted") {
      if (!Array.isArray(scoring.points)) throw new Error("评分点无效");
      for (const point of scoring.points) {
        if (!this.validPoint(point)) throw new Error("评分点无效");
      }
      return { mode: "adjusted", points: scoring.points };
    }
    throw new Error("评分数据无效");
  }

  private validPoint(point: ScoringPoint): boolean {
    return typeof point === "object" && point !== null &&
      typeof point.id === "string" && point.id.length > 0 && point.id.length <= 64 &&
      typeof point.description === "string" && point.description.length <= 500 &&
      typeof point.score === "number" && Number.isFinite(point.score) && point.score >= 0 && point.score <= 1000 &&
      Array.isArray(point.slotIds) && point.slotIds.every((id) => typeof id === "string" && id.length <= 64);
  }

  private parseConfirmations(raw: string): string[] {
    try {
      const value = JSON.parse(raw);
      if (Array.isArray(value) && value.every((key) => typeof key === "string")) return value;
    } catch {
      // 落到统一错误
    }
    throw new Error("试卷数据损坏");
  }
}
