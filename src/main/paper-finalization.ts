import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  buildPaperSnapshot,
  paperVolume,
  resolvePaperReferences,
  type PaperSnapshot,
  type ResolvedReference,
  type VolumePaper,
} from "../shared/paper-layout";
import { paperDefaultScore } from "../shared/paper";
import type { Volume } from "../shared/volume";
import type { Database } from "./database";
import { Paper, type PaperDetail, type PaperItemRecord } from "./paper";
import { QuestionBank } from "./question-bank";
import { addOperation, parseJournal, removeOperation, type PendingOperation } from "./pdf-journal";
import { isValidPdf, pdfPairPaths, writePdfPair } from "./pdf-pair";

export const PAPER_JOURNAL_KEY = "paper.pending";

const expectedFiles = new Set(["学生卷.pdf", "教师答案卷.pdf"]);

export type PaperRenderer = (volume: Volume, paper: VolumePaper) => Promise<Buffer>;

export interface FinalizationOptions {
  confirmAnswerGap?: boolean;
}

export interface FinalizationCheck {
  ready: boolean;
  blockers: string[];
  notices: string[];
  references: ResolvedReference[];
  snapshot: PaperSnapshot;
}

export interface PaperFinalizationRecord {
  id: string;
  paperId: string;
  studentPdf: string;
  teacherPdf: string;
  snapshot: PaperSnapshot;
  studentSha256: string;
  teacherSha256: string;
  createdAt: string;
}

interface FinalizationRow {
  id: string;
  paper_id: string;
  student_pdf: string;
  teacher_pdf: string;
  snapshot: string;
  student_sha256: string;
  teacher_sha256: string;
  created_at: string;
}

const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");

function referenceKindLabel(kind: ResolvedReference["kind"]): string {
  if (kind === "subQuestion") return "小问";
  if (kind === "material") return "材料";
  return "图";
}

/** 定稿门槛、双卷原子落盘、快照冻结与重印；PDF 渲染由调用方注入，学生卷只收到学生结构。 */
export class PaperFinalizer {
  private readonly paper: Paper;
  private readonly bank: QuestionBank;

  constructor(private readonly db: Database, private readonly render: PaperRenderer) {
    this.paper = new Paper(db);
    this.bank = new QuestionBank(db);
  }

  check(paperId: string, options: FinalizationOptions = {}): FinalizationCheck {
    const detail = this.paper.getPaper(paperId);
    const snapshot = this.buildSnapshot(detail);
    const references = resolvePaperReferences(snapshot);
    const blockers: string[] = [];
    const notices: string[] = [];
    const items = detail.sections.flatMap((section) => section.items);
    if (items.length === 0) blockers.push("试卷没有题目");
    const byId = new Map(snapshot.sections.flatMap((section) => section.items).map((item) => [item.id, item]));

    for (const item of items) {
      const snapshotItem = byId.get(item.id);
      const label = `第 ${snapshotItem?.number ?? "?"} 题`;
      const page = `原卷第 ${item.content.source.pdfPage} 页 题 ${item.content.source.originalNumber}`;
      const classification = this.bank.getQuestionClassification(item.questionId);
      if (classification === undefined) blockers.push(`${label}：题目缺少分类`);
      else if (classification.subject !== detail.paper.subject) blockers.push(`${label}：题目学科与试卷不一致`);
      else if (classification.stage !== detail.paper.stage || classification.grade !== detail.paper.grade) blockers.push(`${label}：题目学段或年级与试卷不一致`);

      const defaultScore = paperDefaultScore(item.content, item.subQuestionIds);
      if (defaultScore.conflict !== null) blockers.push(`${label}：${defaultScore.conflict}`);
      if (item.scoringState === "needsAdjustment") blockers.push(`${label}：原评分不适用于当前分值，待调整`);
      for (const conflict of item.scoreConflicts) {
        if (!conflict.confirmed) blockers.push(`${label}：内嵌分值「${conflict.text}」尚未确认`);
      }
      const readiness = this.bank.checkReady(item.questionVersionId, { confirmAnswerGap: options.confirmAnswerGap ?? false });
      blockers.push(...readiness.blockers.map((blocker) => `${label}（${page}）：${blocker}`));
      notices.push(...readiness.notices.map((notice) => `${label}：${notice}`));
    }

    for (const material of snapshot.materials) {
      if (material.missing) blockers.push(`材料「${material.materialId}」缺失`);
    }
    for (const reference of references) {
      if (reference.label !== null) continue;
      const source = byId.get(reference.itemId)?.source;
      const page = source === undefined ? "" : `（原卷第 ${source.pdfPage} 页 题 ${source.originalNumber}）`;
      blockers.push(`第 ${reference.itemNumber} 题${page}：${referenceKindLabel(reference.kind)}引用无法解析（${reference.blockPath}），${reference.reason ?? "待核"}`);
    }

    return {
      ready: blockers.length === 0,
      blockers: [...new Set(blockers)],
      notices: [...new Set(notices)],
      references,
      snapshot,
    };
  }

  async finalize(paperId: string, parent: string, options: FinalizationOptions = {}): Promise<PaperFinalizationRecord> {
    const prepared = this.prepare(paperId, parent, options);
    const student = await this.render("student", paperVolume(prepared.snapshot, "student"));
    const teacher = await this.render("teacher", paperVolume(prepared.snapshot, "teacher"));
    return this.complete(prepared.id, paperId, parent, prepared.snapshot, student, teacher);
  }

  /** 定稿第一步：门槛通过后登记操作并冻结快照；PDF 由调用方分卷渲染后交给 complete。 */
  prepare(paperId: string, parent: string, options: FinalizationOptions = {}): { id: string; snapshot: PaperSnapshot; check: FinalizationCheck } {
    const check = this.check(paperId, options);
    if (!check.ready) throw new Error(`无法定稿：\n${check.blockers.join("\n")}`);
    const id = randomUUID();
    const journal = parseJournal(this.db.getSetting(PAPER_JOURNAL_KEY));
    this.db.setSetting(PAPER_JOURNAL_KEY, JSON.stringify(addOperation(journal, { id, parent })));
    return { id, snapshot: check.snapshot, check };
  }

  /** 定稿第二步：两份 PDF 同时落盘并写入不可变定稿记录。 */
  async complete(id: string, paperId: string, parent: string, snapshot: PaperSnapshot, student: Buffer, teacher: Buffer): Promise<PaperFinalizationRecord> {
    const directory = await writePdfPair(parent, id, student, teacher);
    const studentPdf = join(directory, "学生卷.pdf");
    const teacherPdf = join(directory, "教师答案卷.pdf");
    const record: PaperFinalizationRecord = {
      id,
      paperId,
      studentPdf,
      teacherPdf,
      snapshot,
      studentSha256: sha256(student),
      teacherSha256: sha256(teacher),
      createdAt: new Date().toISOString(),
    };
    this.db.transaction((sqlite) => {
      sqlite.prepare("INSERT INTO paper_finalizations (id, paper_id, student_pdf, teacher_pdf, snapshot, student_sha256, teacher_sha256, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(record.id, record.paperId, record.studentPdf, record.teacherPdf, JSON.stringify(record.snapshot), record.studentSha256, record.teacherSha256, record.createdAt);
    });
    this.db.setSetting(PAPER_JOURNAL_KEY, JSON.stringify(removeOperation(parseJournal(this.db.getSetting(PAPER_JOURNAL_KEY)), id)));
    return record;
  }

  /** 写入预览暂存并用路径交给界面打开；确认前不产生正式目录或记录。 */
  async stagePreview(id: string, parent: string, student: Buffer, teacher: Buffer): Promise<{ studentPath: string; teacherPath: string }> {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("操作标识无效");
    if (!isValidPdf(student) || !isValidPdf(teacher)) throw new Error("双份 PDF 必须都生成并校验成功");
    const { preview } = pdfPairPaths(parent, id);
    const studentPath = join(preview, "学生卷.pdf");
    const teacherPath = join(preview, "教师答案卷.pdf");
    await mkdir(preview, { recursive: true });
    await writeFile(studentPath, student, { flag: "wx" });
    await writeFile(teacherPath, teacher, { flag: "wx" });
    return { studentPath, teacherPath };
  }

  /** 删除预览暂存；确认落盘后或取消时调用。 */
  async clearPreview(id: string, parent: string): Promise<void> {
    await rm(pdfPairPaths(parent, id).preview, { recursive: true, force: true });
  }

  /** 取消尚未落盘的定稿操作；已开始写盘的操作留给启动恢复处理。 */
  abort(id: string): void {
    const journal = parseJournal(this.db.getSetting(PAPER_JOURNAL_KEY));
    this.db.setSetting(PAPER_JOURNAL_KEY, JSON.stringify(removeOperation(journal, id)));
  }

  listFinalizations(paperId: string): PaperFinalizationRecord[] {
    return this.db.read((sqlite) => {
      const rows = sqlite.prepare("SELECT * FROM paper_finalizations WHERE paper_id = ? ORDER BY created_at DESC, id").all(paperId) as unknown as FinalizationRow[];
      return rows.map((row) => this.record(row));
    });
  }

  getFinalization(id: string): PaperFinalizationRecord {
    return this.db.read((sqlite) => {
      const row = sqlite.prepare("SELECT * FROM paper_finalizations WHERE id = ?").get(id) as unknown as FinalizationRow | undefined;
      if (row === undefined) throw new Error("定稿不存在");
      return this.record(row);
    });
  }

  /** 重印只返回已有 PDF 的路径，不重新渲染，也不读取题库新版。 */
  async reprint(id: string): Promise<{ studentPath: string; teacherPath: string }> {
    const record = this.getFinalization(id);
    for (const path of [record.studentPdf, record.teacherPdf]) {
      try {
        await access(path);
      } catch {
        throw new Error(`定稿 PDF 缺失：${path}`);
      }
    }
    return { studentPath: record.studentPdf, teacherPath: record.teacherPdf };
  }

  private buildSnapshot(detail: PaperDetail): PaperSnapshot {
    return buildPaperSnapshot({
      paper: {
        id: detail.paper.id,
        title: detail.paper.title,
        stage: detail.paper.stage,
        subject: detail.paper.subject,
        grade: detail.paper.grade,
      },
      sections: detail.sections.map((section) => ({
        title: section.title,
        items: section.items.map((item: PaperItemRecord) => ({
          id: item.id,
          questionId: item.questionId,
          questionVersionId: item.questionVersionId,
          subQuestionIds: item.subQuestionIds,
          score: item.score,
          blankSpace: item.blankSpace,
          scoring: item.scoring,
          scoringState: item.scoringState,
          answerGap: this.bank.checkReady(item.questionVersionId, { confirmAnswerGap: true }).requiresAnswerConfirmation,
          content: item.content,
        })),
      })),
      materialVersion: (versionId) => {
        const material = this.bank.getMaterialVersion(versionId);
        return material === undefined ? undefined : { title: material.title, content: material.content, source: material.source };
      },
    });
  }

  private record(row: FinalizationRow): PaperFinalizationRecord {
    let snapshot: PaperSnapshot;
    try {
      snapshot = JSON.parse(row.snapshot) as PaperSnapshot;
    } catch {
      throw new Error("定稿数据损坏");
    }
    return {
      id: row.id,
      paperId: row.paper_id,
      studentPdf: row.student_pdf,
      teacherPdf: row.teacher_pdf,
      snapshot,
      studentSha256: row.student_sha256,
      teacherSha256: row.teacher_sha256,
      createdAt: row.created_at,
    };
  }
}

async function entries(path: string): Promise<string[] | undefined> {
  try {
    return await readdir(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** 启动恢复：清掉未完成暂存与没有定稿记录的完成目录；有记录或有非预期文件的目录保留。 */
export async function recoverPaperFinalizations(db: Database): Promise<{ cleared: string[]; kept: PendingOperation[] }> {
  const operations = parseJournal(db.getSetting(PAPER_JOURNAL_KEY));
  const cleared: string[] = [];
  const kept: PendingOperation[] = [];
  for (const operation of operations) {
    const paths = pdfPairPaths(operation.parent, operation.id);
    const previewNames = await entries(paths.preview);
    if (previewNames !== undefined) {
      if (!previewNames.every((name) => expectedFiles.has(name))) {
        kept.push(operation);
        continue;
      }
      await rm(paths.preview, { recursive: true, force: true });
    }
    const pendingNames = await entries(paths.pending);
    if (pendingNames !== undefined && !pendingNames.every((name) => expectedFiles.has(name))) {
      kept.push(operation);
      continue;
    }
    if (pendingNames !== undefined) await rm(paths.pending, { recursive: true, force: true });
    const saved = db.read((sqlite) => sqlite.prepare("SELECT id FROM paper_finalizations WHERE id = ?").get(operation.id) !== undefined);
    if (!saved) {
      const resultNames = await entries(paths.result);
      if (resultNames !== undefined && !resultNames.every((name) => expectedFiles.has(name))) {
        kept.push(operation);
        continue;
      }
      if (resultNames !== undefined) await rm(paths.result, { recursive: true, force: true });
    }
    cleared.push(operation.id);
  }
  db.setSetting(PAPER_JOURNAL_KEY, JSON.stringify(kept));
  return { cleared, kept };
}
