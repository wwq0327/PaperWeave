import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  emptyImportSummary,
  importProblemKind,
  isImportDecision,
  isImportKind,
  type ImportApplyResult,
  type ImportApplyRow,
  type ImportBatchView,
  type ImportKind,
  type ImportRow,
  type ImportScanView,
  type ImportStatus,
} from "../shared/import";
import { diffImportContent, type ImportDiffMaterial, type ImportFieldDiff } from "../shared/import-diff";
import { buildSearchText, hasContent, type AnswerStatus, type QuestionContent } from "../shared/question";
import type { AttachmentStore } from "./attachments";
import type { Database } from "./database";
import { QuestionBank, type QuestionVersionRecord } from "./question-bank";
import type { ImportCandidate, ImportMaterialSpec } from "./import-candidate";
import { scanMathVault } from "./mathvault";
import { scanTiku } from "./tiku";

interface RecordRow {
  source_hash: string;
  target_question_id: string | null;
  target_version_id: string | null;
  decision: string;
  detail: string;
}

interface BatchRow {
  id: string;
  kind: string;
  root: string;
  created_at: string;
  summary: string;
}

interface CachedScan {
  kind: ImportKind;
  root: string;
  candidates: Map<string, ImportCandidate>;
  rows: Map<string, ImportRow>;
}

const MAX_ROWS = 2000;

/** 旧库迁入：扫描只读，执行在单个事务内写题目、材料、批次与来源记录。 */
export class ImportStore {
  private readonly scans = new Map<string, CachedScan>();
  private readonly bank: QuestionBank;

  constructor(private readonly db: Database, private readonly attachments: AttachmentStore, bank?: QuestionBank) {
    this.bank = bank ?? new QuestionBank(db);
  }

  scan(kind: unknown, root: unknown): ImportScanView {
    if (!isImportKind(kind)) throw new Error("旧库类型无效");
    if (typeof root !== "string" || !root.trim()) throw new Error("旧库根目录无效");
    const candidates = kind === "tiku" ? scanTiku(root) : scanMathVault(root);
    const rows = candidates.map((candidate) => this.annotate(kind, candidate));
    const summary = emptyImportSummary();
    for (const row of rows) summary[row.status] += 1;
    const scanId = randomUUID();
    this.scans.set(scanId, { kind, root, candidates: new Map(candidates.map((candidate) => [candidate.sourceKey, candidate])), rows: new Map(rows.map((row) => [row.sourceKey, row])) });
    while (this.scans.size > 4) {
      const oldest = this.scans.keys().next().value;
      if (oldest === undefined) break;
      this.scans.delete(oldest);
    }
    return { scanId, kind, rows, summary };
  }

  apply(input: unknown): ImportApplyResult {
    if (typeof input !== "object" || input === null || Array.isArray(input)) throw new Error("导入请求无效");
    const value = input as Record<string, unknown>;
    if (!Object.keys(value).every((key) => key === "scanId" || key === "rows")) throw new Error("导入请求包含未知字段");
    if (typeof value.scanId !== "string" || !value.scanId) throw new Error("扫描标识无效");
    if (!Array.isArray(value.rows) || value.rows.length === 0 || value.rows.length > MAX_ROWS) throw new Error("导入条目无效");
    const cache = this.scans.get(value.scanId);
    if (!cache) throw new Error("扫描结果已失效，请重新扫描");
    const actions: ImportApplyRow[] = [];
    const seen = new Set<string>();
    for (const entry of value.rows) {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw new Error("导入条目无效");
      const item = entry as Record<string, unknown>;
      if (!Object.keys(item).every((key) => key === "sourceKey" || key === "action" || key === "acknowledgeProofread")) throw new Error("导入条目包含未知字段");
      if (typeof item.sourceKey !== "string" || !item.sourceKey) throw new Error("来源标识无效");
      if (!isImportDecision(item.action)) throw new Error("导入动作无效");
      if (item.acknowledgeProofread !== undefined && typeof item.acknowledgeProofread !== "boolean") throw new Error("校勘确认无效");
      if (seen.has(item.sourceKey)) throw new Error("同一来源不能重复提交");
      seen.add(item.sourceKey);
      const row = cache.rows.get(item.sourceKey);
      if (!row) throw new Error(`扫描结果中没有来源：${item.sourceKey}`);
      const acknowledgeProofread = item.acknowledgeProofread === true;
      this.checkAction(row, item.action, acknowledgeProofread);
      actions.push({ sourceKey: item.sourceKey, action: item.action, acknowledgeProofread });
    }

    for (const action of actions) {
      if (action.action === "skip") continue;
      const candidate = cache.candidates.get(action.sourceKey);
      if (!candidate) throw new Error(`扫描结果中没有来源：${action.sourceKey}`);
      for (const image of candidate.images) {
        if (image.saved) continue;
        let data: Buffer;
        try { data = readFileSync(image.path); } catch { throw new Error("图片在扫描后已缺失，请重新扫描"); }
        const saved = this.attachments.save(data);
        if (saved.id !== image.id) throw new Error("图片在扫描后已变化，请重新扫描");
      }
    }

    const batchId = randomUUID();
    const createdAt = new Date().toISOString();
    this.db.transaction((sqlite) => {
      sqlite.prepare("INSERT INTO import_batches (id, kind, root, created_at, summary) VALUES (?, ?, ?, ?, ?)").run(batchId, cache.kind, cache.root, createdAt, "{}");
      let imported = 0;
      let revised = 0;
      let skipped = 0;
      let materials = 0;
      for (const action of actions) {
        const row = cache.rows.get(action.sourceKey)!;
        const candidate = cache.candidates.get(action.sourceKey)!;
        if (action.action === "skip") {
          this.writeRecord(sqlite, batchId, cache.kind, candidate, "skip", row.target?.questionId ?? null, row.target?.versionId ?? null, row, false);
          skipped += 1;
          continue;
        }
        const resolved = this.resolveMaterials(sqlite, batchId, cache.kind, candidate);
        materials += resolved.created;
        const content = this.linkMaterials(candidate.content!, resolved.refs);
        const answerStatus: AnswerStatus = this.hasAnswer(content) ? "pending" : "missing";
        let questionId: string;
        let versionId: string;
        if (action.action === "import") {
          const record = this.bank.createQuestionWithin(sqlite, content, candidate.classification, "pending", answerStatus);
          questionId = record.questionId;
          versionId = record.id;
          imported += 1;
        } else {
          questionId = row.target!.questionId;
          const record = this.bank.saveQuestionVersionWithin(sqlite, questionId, content, candidate.classification, { contentStatus: "pending", answerStatus });
          versionId = record.id;
          revised += 1;
        }
        this.writeRecord(sqlite, batchId, cache.kind, candidate, action.action, questionId, versionId, row, action.acknowledgeProofread === true);
      }
      const summary = { imported, revised, skipped, materials };
      sqlite.prepare("UPDATE import_batches SET summary = ? WHERE id = ?").run(JSON.stringify(summary), batchId);
    });
    this.scans.delete(value.scanId);
    const summary = JSON.parse(this.db.read((sqlite) => (sqlite.prepare("SELECT summary FROM import_batches WHERE id = ?").get(batchId) as { summary: string }).summary)) as { imported: number; revised: number; skipped: number };
    return { batchId, imported: summary.imported, revised: summary.revised, skipped: summary.skipped };
  }

  history(): ImportBatchView[] {
    return this.db.read((sqlite) => (sqlite.prepare("SELECT * FROM import_batches ORDER BY created_at DESC, id LIMIT 20").all() as unknown as BatchRow[]).map((row) => ({
      id: row.id,
      kind: row.kind as ImportKind,
      rootName: basename(row.root),
      createdAt: row.created_at,
      summary: this.parseSummary(row.summary),
    })));
  }

  private annotate(kind: ImportKind, candidate: ImportCandidate): ImportRow {
    const base = {
      sourceKey: candidate.sourceKey,
      sourceHash: candidate.sourceHash,
      title: candidate.title,
      section: candidate.section,
      pdfPage: candidate.pdfPage,
      originalNumber: candidate.originalNumber,
      classification: candidate.classification,
      preview: candidate.preview,
      reasons: [...candidate.reasons],
      problems: [...candidate.problems],
      legacyStatus: candidate.legacyStatus,
      needsProofread: candidate.needsProofread,
    };
    if (candidate.blocked) return { ...base, status: "blocked", canRevise: false };
    const record = this.getRecord(kind, candidate.sourceKey);
    if (!record) return { ...base, status: "importable", incoming: candidate.content, canRevise: false };
    const latest = record.target_question_id ? this.bank.getLatestQuestionVersion(record.target_question_id) : undefined;
    const target = latest ? {
      questionId: latest.questionId,
      versionId: latest.id,
      version: latest.version,
      preview: buildSearchText(latest.content).slice(0, 120),
      contentStatus: latest.contentStatus,
    } : undefined;
    let status: ImportStatus;
    if (record.source_hash === candidate.sourceHash) status = "duplicate";
    else if (!latest || !record.target_version_id) status = "importable";
    else if (latest.id !== record.target_version_id) status = "target_modified";
    else status = "changed";
    return {
      ...base,
      status,
      target,
      incoming: status === "importable" || status === "changed" ? candidate.content : undefined,
      canRevise: status === "changed",
      needsProofread: candidate.needsProofread,
      diff: status === "changed" && latest ? this.diffFor(latest, candidate) : undefined,
    };
  }

  /** 应用内修正单个阻断项：补图或确认移除；只重校验该条，不重跑整批。 */
  correct(input: unknown, image?: { data: Buffer; path: string; alt: string }): ImportRow {
    if (typeof input !== "object" || input === null || Array.isArray(input)) throw new Error("修正请求无效");
    const value = input as Record<string, unknown>;
    if (!Object.keys(value).every((key) => key === "scanId" || key === "sourceKey" || key === "action" || key === "problem")) throw new Error("修正请求包含未知字段");
    if (typeof value.scanId !== "string" || !value.scanId) throw new Error("扫描标识无效");
    if (typeof value.sourceKey !== "string" || !value.sourceKey) throw new Error("来源标识无效");
    if (value.action !== "attachImage" && value.action !== "dropProblem") throw new Error("修正动作无效");
    if (typeof value.problem !== "string" || !value.problem) throw new Error("阻断项无效");
    const cache = this.scans.get(value.scanId);
    if (!cache) throw new Error("扫描结果已失效，请重新扫描");
    const candidate = cache.candidates.get(value.sourceKey);
    if (!candidate) throw new Error(`扫描结果中没有来源：${value.sourceKey}`);
    if (cache.rows.get(value.sourceKey)?.status !== "blocked") throw new Error("该来源当前没有阻断项");
    if (!candidate.problems.includes(value.problem)) throw new Error("该阻断项已处理或不存在");
    const kind = importProblemKind(value.problem);
    if (kind === "other") throw new Error("该阻断项不能在应用内修正，请修改源文件后重新扫描");
    if (value.action === "attachImage") {
      if (kind !== "image") throw new Error("该阻断项不能用补图修正");
      if (!image) throw new Error("未选择图片");
      if (!candidate.content) throw new Error("该来源缺少题目内容，无法补图");
      const saved = this.attachments.save(image.data);
      const alt = image.alt || "补入图片";
      const block = { type: "image" as const, id: saved.id, alt };
      const target = candidate.content.subQuestions[0]?.prompt ?? candidate.content.stem;
      target.push(block);
      candidate.images.push({ id: saved.id, path: image.path, alt, saved: true });
      candidate.corrections.push(`补图：${value.problem}`);
    } else {
      candidate.corrections.push(`确认移除：${value.problem}`);
    }
    candidate.problems = candidate.problems.filter((entry) => entry !== value.problem);
    candidate.reasons = candidate.reasons.filter((entry) => entry !== value.problem);
    candidate.blocked = candidate.problems.length > 0;
    const updated = this.annotate(cache.kind, candidate);
    cache.rows.set(candidate.sourceKey, updated);
    return updated;
  }

  private diffFor(latest: QuestionVersionRecord, candidate: ImportCandidate): ImportFieldDiff[] {
    const beforeMaterials: ImportDiffMaterial[] = latest.content.materials.map((ref) => {
      const version = this.bank.getMaterialVersion(ref.versionId);
      return { title: version?.title ?? "", blocks: version?.content ?? [] };
    });
    return diffImportContent(
      {
        number: latest.content.source.originalNumber,
        classification: this.bank.getQuestionClassification(latest.questionId) ?? candidate.classification,
        content: latest.content,
        materials: beforeMaterials,
      },
      {
        number: candidate.originalNumber,
        classification: candidate.classification,
        content: candidate.content!,
        materials: candidate.materials.map((material) => ({ title: material.title, blocks: material.content })),
      },
    );
  }

  private checkAction(row: ImportRow, action: ImportApplyRow["action"], acknowledgeProofread: boolean): void {
    if (row.status === "blocked") throw new Error("该来源存在阻断原因，不能导入");
    if (row.needsProofread && action !== "skip" && !acknowledgeProofread) throw new Error("该来源待校勘，请先确认校勘说明");
    if (action === "import") {
      if (row.status === "importable") return;
      if (row.status === "duplicate") throw new Error("该来源已导入，不能重复导入");
      if (row.status === "changed") throw new Error("来源已变化，请选择建立修订版或保留当前");
      throw new Error("目标题已人工修改，请保留当前");
    }
    if (action === "revise") {
      if (row.status === "changed" && row.target && row.canRevise) return;
      if (row.status === "target_modified") throw new Error("目标题已人工修改，禁止自动修订");
      if (row.status === "duplicate") throw new Error("来源未变化，无需修订");
      throw new Error("尚无目标题，不能建立修订版");
    }
    if (row.status === "importable") throw new Error("尚未导入的来源不能选择保留当前");
  }

  private resolveMaterials(sqlite: DatabaseSync, batchId: string, kind: ImportKind, candidate: ImportCandidate): { refs: Map<string, { materialId: string; versionId: string }>; created: number } {
    const refs = new Map<string, { materialId: string; versionId: string }>();
    let created = 0;
    for (const material of candidate.materials) {
      const record = this.getRecord(`${kind}-material`, material.key, sqlite);
      const input = { title: material.title, content: material.content, source: material.source };
      if (record?.target_question_id && record.source_hash === material.hash && record.target_version_id && this.materialVersionExists(sqlite, record.target_version_id)) {
        refs.set(material.placeholderId, { materialId: record.target_question_id, versionId: record.target_version_id });
        continue;
      }
      if (record?.target_question_id) {
        const saved = this.bank.saveMaterialVersionWithin(sqlite, record.target_question_id, input, "pending");
        refs.set(material.placeholderId, { materialId: saved.materialId, versionId: saved.id });
        this.writeMaterialRecord(sqlite, batchId, kind, material, saved.materialId, saved.id, "revise");
      } else {
        const saved = this.bank.createMaterialWithin(sqlite, input, "pending");
        refs.set(material.placeholderId, { materialId: saved.materialId, versionId: saved.id });
        this.writeMaterialRecord(sqlite, batchId, kind, material, saved.materialId, saved.id, "import");
        created += 1;
      }
    }
    return { refs, created };
  }

  private linkMaterials(content: QuestionContent, refs: Map<string, { materialId: string; versionId: string }>): QuestionContent {
    return {
      ...content,
      materials: content.materials.map((ref) => refs.get(ref.materialId) ?? ref),
      subQuestions: content.subQuestions.map((sub) => ({
        ...sub,
        materialIds: sub.materialIds.map((id) => refs.get(id)?.materialId ?? id),
      })),
    };
  }

  private hasAnswer(content: QuestionContent): boolean {
    return content.subQuestions.some((sub) => sub.answers.some((answer) => hasContent(answer.blocks)));
  }

  private writeRecord(
    sqlite: DatabaseSync,
    batchId: string,
    kind: ImportKind,
    candidate: ImportCandidate,
    decision: string,
    questionId: string | null,
    versionId: string | null,
    row: ImportRow,
    acknowledged: boolean,
  ): void {
    const detail = JSON.stringify({
      legacyStatus: candidate.legacyStatus ?? null,
      reasons: candidate.reasons,
      section: candidate.section,
      originalNumber: candidate.originalNumber,
      pdfPage: candidate.pdfPage,
      targetStatus: row.status,
      ...(candidate.corrections.length > 0 ? { corrections: candidate.corrections } : {}),
      ...(candidate.needsProofread ? { proofread: acknowledged ? "acknowledged" : "not_acknowledged" } : {}),
    });
    this.upsertRecord(sqlite, batchId, kind, candidate.sourceKey, candidate.sourceHash, questionId, versionId, decision, detail);
  }

  private writeMaterialRecord(sqlite: DatabaseSync, batchId: string, kind: ImportKind, material: ImportMaterialSpec, materialId: string, versionId: string, decision: string): void {
    this.upsertRecord(sqlite, batchId, `${kind}-material`, material.key, material.hash, materialId, versionId, decision, JSON.stringify({ title: material.title, source: material.source }));
  }

  private upsertRecord(sqlite: DatabaseSync, batchId: string, kind: string, sourceKey: string, sourceHash: string, questionId: string | null, versionId: string | null, decision: string, detail: string): void {
    sqlite.prepare(`
      INSERT INTO import_records (id, batch_id, kind, source_key, source_hash, target_question_id, target_version_id, decision, detail, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(kind, source_key) DO UPDATE SET
        batch_id = excluded.batch_id,
        source_hash = excluded.source_hash,
        target_question_id = excluded.target_question_id,
        target_version_id = excluded.target_version_id,
        decision = excluded.decision,
        detail = excluded.detail,
        updated_at = excluded.updated_at
    `).run(randomUUID(), batchId, kind, sourceKey, sourceHash, questionId, versionId, decision, detail, new Date().toISOString());
  }

  private getRecord(kind: string, sourceKey: string, sqlite?: DatabaseSync): RecordRow | undefined {
    const query = (db: DatabaseSync) => db.prepare("SELECT source_hash, target_question_id, target_version_id, decision, detail FROM import_records WHERE kind = ? AND source_key = ?").get(kind, sourceKey) as RecordRow | undefined;
    return sqlite ? query(sqlite) : this.db.read(query);
  }

  private materialVersionExists(sqlite: DatabaseSync, versionId: string): boolean {
    return sqlite.prepare("SELECT 1 FROM material_versions WHERE id = ?").get(versionId) !== undefined;
  }

  private parseSummary(raw: string): ImportBatchView["summary"] {
    try {
      const value = JSON.parse(raw);
      return typeof value === "object" && value !== null ? value as ImportBatchView["summary"] : {};
    } catch { return {}; }
  }
}
