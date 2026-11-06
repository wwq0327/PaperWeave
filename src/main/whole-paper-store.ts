import { randomUUID } from "node:crypto";
import { AI_LIMITS, isAiAnswerDraft, isAiDraft } from "../shared/ai";
import type { WholePaperAnswerFile, WholePaperBatchKind, WholePaperPageImage } from "../shared/whole-paper-batches";
import type { WholePaperRunState } from "../shared/whole-paper-runner";
import { Database } from "./database";

const prefix = "whole-paper.task.";
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const errors = new Set(["上次执行中断，请重试", "已取消，请重试", "批次处理失败，请重试"]);
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const keys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every((key) => allowed.includes(key));
const pageNumber = (page: unknown): page is number => Number.isInteger(page) && (page as number) >= 1 && (page as number) <= 2000;
const finiteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const attachmentId = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const batchKinds = new Set<WholePaperBatchKind>(["text", "scan", "answer-text", "answer-scan"]);
const kindOf = (batch: Record<string, unknown>): WholePaperBatchKind => batch.kind === undefined ? "text" : batch.kind as WholePaperBatchKind;
const isScanKind = (kind: WholePaperBatchKind): boolean => kind === "scan" || kind === "answer-scan";
const isAnswerKind = (kind: WholePaperBatchKind): boolean => kind === "answer-text" || kind === "answer-scan";
const validAnswerFile = (value: unknown): value is WholePaperAnswerFile =>
  object(value) && keys(value, ["fileId", "role", "name"])
  && typeof value.fileId === "string" && value.fileId.length > 0 && value.fileId.length <= 200
  && (value.role === "answer" || value.role === "rubric")
  && typeof value.name === "string" && value.name.length > 0 && value.name.length <= 255;
const validImage = (value: unknown): value is WholePaperPageImage =>
  object(value) && keys(value, ["page", "attachmentId", "width", "height"])
  && pageNumber(value.page) && attachmentId(value.attachmentId)
  && Number.isInteger(value.width) && (value.width as number) > 0 && (value.width as number) <= 20000
  && Number.isInteger(value.height) && (value.height as number) > 0 && (value.height as number) <= 20000;
const validDocxImages = (value: unknown): boolean =>
  value === undefined || (Array.isArray(value) && value.length <= 2000 && value.every((image: unknown) => {
    if (!object(image) || !keys(image, ["unit", "start", "end", "name", "attachmentId", "note"])) return false;
    const attachment = image.attachmentId;
    return pageNumber(image.unit)
      && Number.isInteger(image.start) && Number.isInteger(image.end) && (image.start as number) >= 0 && (image.end as number) > (image.start as number)
      && typeof image.name === "string" && image.name.length > 0 && image.name.length <= 255
      && (attachment === undefined || (typeof attachment === "string" && /^[a-f0-9]{64}$/.test(attachment)))
      && (image.note === undefined || (typeof image.note === "string" && image.note.length > 0 && image.note.length <= 500));
  }));

const validBlocks = (blocks: unknown, start: number, end: number): boolean =>
  Array.isArray(blocks) && blocks.every((block: unknown) =>
    object(block) && keys(block, ["start", "end", "text", "x", "y", "width", "height"])
    && Number.isInteger(block.start) && Number.isInteger(block.end)
    && (block.start as number) >= start && (block.end as number) <= end && (block.end as number) > (block.start as number)
    && typeof block.text === "string" && (block.end as number) - (block.start as number) === [...block.text].length
    && finiteNumber(block.x) && finiteNumber(block.y) && finiteNumber(block.width) && finiteNumber(block.height));

/** 不信任数据库中的 JSON；拒绝不一致、未知字段和未校验的模型结果。 */
function validState(value: unknown): value is WholePaperRunState {
  if (!object(value) || !keys(value, ["plan", "batches"]) || !object(value.plan) || !keys(value.plan, ["sourceKind", "batches", "emptyPages", "docxImages", "answerFiles"]) || (value.plan.sourceKind !== undefined && value.plan.sourceKind !== "pdf" && value.plan.sourceKind !== "docx") || !Array.isArray(value.plan.batches) || !Array.isArray(value.plan.emptyPages) || !Array.isArray(value.batches)) return false;
  if (value.plan.batches.length !== value.batches.length || value.batches.length > 20000 || !value.plan.emptyPages.every(pageNumber) || !validDocxImages(value.plan.docxImages)) return false;
  if (value.plan.answerFiles !== undefined && (!Array.isArray(value.plan.answerFiles) || value.plan.answerFiles.length > 20 || !value.plan.answerFiles.every(validAnswerFile))) return false;
  if (value.plan.emptyPages.some((p, i, a) => i > 0 && p <= a[i - 1])) return false;
  for (let i = 0; i < value.batches.length; i++) {
    const plan = value.plan.batches[i];
    const batch = value.batches[i];
    if (!object(plan) || !object(batch)) return false;
    const kind = kindOf(plan);
    if (!batchKinds.has(kind) || !keys(plan, ["kind", "fragments", "pages", "text", "sendable", "reviewBoundaryBefore", "image", "answer"])) return false;
    if (plan.reviewBoundaryBefore !== (i > 0) || !Array.isArray(plan.pages) || plan.pages.length > 50) return false;
    if (isScanKind(kind)) {
      if (!Array.isArray(plan.fragments) || plan.fragments.length !== 0 || plan.text !== "" || plan.sendable !== true || !validImage(plan.image)) return false;
      if (plan.pages.length !== 1 || plan.pages[0] !== plan.image.page) return false;
    } else {
      if (!Array.isArray(plan.fragments) || plan.fragments.length === 0 || typeof plan.text !== "string" || [...plan.text].length > AI_LIMITS.textChars || plan.sendable !== !!plan.text.trim() || plan.image !== undefined) return false;
      if (!plan.fragments.every((part: unknown) => object(part) && keys(part, ["page", "start", "end", "text", "blocks"]) && pageNumber(part.page) && Number.isInteger(part.start) && Number.isInteger(part.end) && (part.start as number) >= 0 && typeof part.text === "string" && (part.end as number) - (part.start as number) === [...part.text].length && (part.end as number) > (part.start as number) && (part.blocks === undefined || validBlocks(part.blocks, part.start as number, part.end as number)))) return false;
      if (plan.fragments.map((part: { text: string }) => part.text).join("") !== plan.text || JSON.stringify([...new Set(plan.fragments.map((part: { page: number }) => part.page))]) !== JSON.stringify(plan.pages)) return false;
    }
    if (isAnswerKind(kind) ? !validAnswerFile(plan.answer) : plan.answer !== undefined) return false;
    if (!keys(batch, ["status", "result", "error", "answers"]) || !["pending", "running", "succeeded", "failed", "skipped"].includes(batch.status as string)) return false;
    if ((batch.status === "skipped") !== !plan.sendable) return false;
    const succeeded = batch.status === "succeeded";
    if (isAnswerKind(kind)) {
      if (succeeded ? !isAiAnswerDraft(batch.answers) : batch.answers !== undefined) return false;
      if (batch.result !== undefined) return false;
    } else {
      if (succeeded ? !isAiDraft(batch.result) : batch.result !== undefined) return false;
      if (batch.answers !== undefined) return false;
    }
    if (batch.status === "failed" ? typeof batch.error !== "string" || !errors.has(batch.error) : batch.error !== undefined) return false;
  }
  return true;
}

export interface WholePaperTask {
  id: string;
  examId: string;
  sectionId: string;
  sourceFileId?: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  state: WholePaperRunState;
}

function parse(raw: string, id: string): WholePaperTask {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error("整卷任务数据损坏"); }
  if (!object(value) || !keys(value, ["id", "examId", "sectionId", "sourceFileId", "revision", "createdAt", "updatedAt", "state"]) || value.id !== id || typeof value.examId !== "string" || !value.examId || typeof value.sectionId !== "string" || !value.sectionId || (value.sourceFileId !== undefined && (typeof value.sourceFileId !== "string" || !value.sourceFileId)) || !Number.isSafeInteger(value.revision) || (value.revision as number) < 1 || typeof value.createdAt !== "string" || typeof value.updatedAt !== "string" || !validState(value.state)) throw new Error("整卷任务数据损坏");
  return value as unknown as WholePaperTask;
}

export class WholePaperStore {
  constructor(private readonly db: Database) {}

  create(examId: string, sectionId: string, state: WholePaperRunState, sourceFileId?: string): WholePaperTask {
    if (!validState(state) || state.batches.some((batch) => batch.status !== "pending" && batch.status !== "skipped")) throw new Error("整卷任务初始状态无效");
    const now = new Date().toISOString();
    const task: WholePaperTask = { id: randomUUID(), examId, sectionId, ...(sourceFileId === undefined ? {} : { sourceFileId }), revision: 1, createdAt: now, updatedAt: now, state: structuredClone(state) };
    this.db.transaction((sqlite) => {
      if (!sqlite.prepare("SELECT 1 FROM exam_sections WHERE id = ? AND exam_id = ?").get(sectionId, examId)) throw new Error("考试分部不存在");
      if (sourceFileId !== undefined && !sqlite.prepare("SELECT 1 FROM exam_originals WHERE exam_id = ? AND file_id = ? AND role = 'paper'").get(examId, sourceFileId)) throw new Error("原卷不属于该考试");
      sqlite.prepare("INSERT INTO app_settings (key, value) VALUES (?, ?)").run(prefix + task.id, JSON.stringify(task));
    });
    return task;
  }

  get(id: string): WholePaperTask {
    if (typeof id !== "string" || !idPattern.test(id)) throw new Error("整卷任务标识无效");
    const raw = this.db.getSetting(prefix + id);
    if (raw === undefined) throw new Error("整卷任务不存在");
    return parse(raw, id);
  }

  list(): Pick<WholePaperTask, "id" | "examId" | "sectionId" | "sourceFileId" | "revision" | "createdAt" | "updatedAt">[] {
    const rows = this.db.read((sqlite) => sqlite.prepare("SELECT key, value FROM app_settings WHERE key GLOB ? ORDER BY key").all(prefix + "*") as { key: string; value: string }[]);
    return rows.map((row) => {
      const id = row.key.slice(prefix.length);
      if (!idPattern.test(id)) throw new Error("整卷任务数据损坏");
      const { state: _state, ...summary } = parse(row.value, id);
      return summary;
    });
  }

  save(id: string, expectedRevision: number, state: WholePaperRunState): WholePaperTask {
    if (!validState(state)) throw new Error("整卷任务状态无效");
    return this.db.transaction((sqlite) => {
      if (!idPattern.test(id)) throw new Error("整卷任务标识无效");
      const row = sqlite.prepare("SELECT value FROM app_settings WHERE key = ?").get(prefix + id) as { value: string } | undefined;
      if (!row) throw new Error("整卷任务不存在");
      const current = parse(row.value, id);
      if (current.revision !== expectedRevision) throw new Error("整卷任务已被更新，请重新读取");
      if (JSON.stringify(current.state.plan) !== JSON.stringify(state.plan)) throw new Error("整卷任务分批计划不可修改");
      const next = { ...current, revision: current.revision + 1, updatedAt: new Date().toISOString(), state: structuredClone(state) };
      sqlite.prepare("UPDATE app_settings SET value = ? WHERE key = ?").run(JSON.stringify(next), prefix + id);
      return next;
    });
  }
}
