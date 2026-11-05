import { randomUUID } from "node:crypto";
import { aiQuestionToIntake, type AiIntakeResult } from "../shared/ai-intake";
import { AI_LIMITS } from "../shared/ai";
import { buildContent, buildContentBlocks } from "../shared/intake";
import { buildSearchText, classificationProblem, type Classification, type QuestionContent, type ReviewStatus } from "../shared/question";
import { contentReviewProblems, type ReviewMaterial } from "../shared/review";
import type { WholePaperIntakeItem, WholePaperIntakeStatus, WholePaperIntakeSummary } from "../shared/whole-paper-intake";
import type { Database } from "./database";
import type { ExamStore } from "./exams";
import type { Intake } from "./intake";
import type { QuestionBank } from "./question-bank";
import type { WholePaperStore } from "./whole-paper-store";

interface IntakeRow {
  id: string;
  task_id: string;
  batch_index: number;
  question_index: number;
  original_number: string;
  page: number;
  status: WholePaperIntakeStatus;
  message: string;
  question_id: string | null;
  version_id: string | null;
  content: string;
  classification: string;
  material_ids: string;
  created_at: string;
  updated_at: string;
}

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function parseJson<T>(raw: string, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** 整卷识别结果批量建档：复用单题录题链路逐题保存，按（任务，批，题）唯一记录状态，重复候选由教师显式处理。 */
export class WholePaperIntake {
  constructor(
    private readonly db: Database,
    private readonly tasks: WholePaperStore,
    private readonly intake: Intake,
    private readonly bank: QuestionBank,
    private readonly exams: ExamStore,
  ) {}

  create(taskId: string, classification: Classification): WholePaperIntakeSummary {
    const task = this.tasks.get(taskId);
    if (task.state.batches.some((batch) => batch.status === "running")) throw new Error("整卷任务正在执行，请等待完成后再建档");
    const issue = classificationProblem(classification);
    if (issue !== null) throw new Error(`整卷分类无效：${issue}`);
    const exam = this.exams.getExam(task.examId);
    const section = exam.sections.find((item) => item.id === task.sectionId);
    if (section === undefined) throw new Error("考试分部不存在");
    const existingRows = this.db.read((sqlite) => sqlite.prepare("SELECT batch_index, question_index FROM whole_paper_intakes WHERE task_id = ?").all(taskId)) as unknown as Pick<IntakeRow, "batch_index" | "question_index">[];
    const existing = new Set(existingRows.map((row) => `${row.batch_index}:${row.question_index}`));
    const tagCandidates = this.bank.knowledgePointCandidates(classification.stage, classification.subject, AI_LIMITS.tagCount);
    const pending: { batchIndex: number; questionIndex: number; derived: AiIntakeResult }[] = [];
    task.state.batches.forEach((batch, batchIndex) => {
      if (batch.status !== "succeeded" || batch.result === undefined) return;
      batch.result.questions.forEach((question, questionIndex) => {
        if (existing.has(`${batchIndex}:${questionIndex}`)) return;
        pending.push({ batchIndex, questionIndex, derived: aiQuestionToIntake(question, classification, section.title, tagCandidates) });
      });
    });
    if (pending.length === 0) {
      return { created: 0, duplicates: 0, failed: 0, existing: existing.size, materials: 0 };
    }
    // 材料一遍：跨题按标题+正文去重，各题共享同一份草稿。
    const materialIdByKey = new Map<string, string>();
    const materialIdsByPending = pending.map(({ derived }) => derived.materials.map((suggestion) => {
      const key = `${suggestion.title.trim()}|${suggestion.content.trim()}`;
      let materialId = materialIdByKey.get(key);
      if (materialId === undefined) {
        const built = buildContentBlocks([{ kind: "text", text: suggestion.content }], "材料正文");
        if (built.problems.length > 0) throw new Error(built.problems.join("；"));
        const created = this.bank.createMaterial({ title: suggestion.title, content: built.blocks, source: suggestion.source });
        materialId = created.materialId;
        materialIdByKey.set(key, materialId);
      }
      return materialId;
    }));
    let created = 0;
    let duplicates = 0;
    let failed = 0;
    pending.forEach((item, index) => {
      const now = new Date().toISOString();
      const record = {
        id: randomUUID(), taskId, batchIndex: item.batchIndex, questionIndex: item.questionIndex,
        originalNumber: "", page: 0, status: "failed" as WholePaperIntakeStatus, message: "",
        questionId: null as string | null, versionId: null as string | null, content: "", classification: "",
        materialIds: materialIdsByPending[index],
      };
      try {
        const form = this.withMaterials(item.derived.form, record.materialIds);
        const built = buildContent(form);
        if (built.content === null) throw new Error(built.problems.join("；"));
        const saved = this.intake.save({
          examId: task.examId,
          sectionId: task.sectionId,
          content: built.content,
          classification: form.classification,
          submit: true,
        });
        record.originalNumber = built.content.source.originalNumber;
        const page = built.content.source.pdfPage;
        record.page = Number.isInteger(page) && page >= 1 ? page : 0;
        record.content = JSON.stringify(built.content);
        record.classification = JSON.stringify(form.classification);
        if (saved.saved) {
          record.status = "created";
          record.questionId = saved.questionId;
          record.versionId = saved.versionId;
          created += 1;
        } else {
          record.status = "duplicate";
          record.questionId = saved.duplicate.questionId;
          record.message = `原题号「${record.originalNumber}」已存在：第 ${saved.duplicate.version} 版，原卷第 ${saved.duplicate.source.pdfPage} 页`;
          duplicates += 1;
        }
      } catch (error) {
        record.status = "failed";
        record.message = errorMessage(error);
        failed += 1;
      }
      this.insertRecord(record, now);
    });
    return { created, duplicates, failed, existing: existing.size, materials: materialIdByKey.size };
  }

  list(taskId: string): WholePaperIntakeItem[] {
    const rows = this.db.read((sqlite) => sqlite.prepare("SELECT * FROM whole_paper_intakes WHERE task_id = ? ORDER BY batch_index, question_index").all(taskId)) as unknown as IntakeRow[];
    return rows.map((row) => {
      const materialIds = parseJson<string[]>(row.material_ids, []);
      let contentStatus: WholePaperIntakeItem["contentStatus"] = null;
      let answerStatus: WholePaperIntakeItem["answerStatus"] = null;
      let versionId: string | null = null;
      let preview = "";
      let problems: string[] = [];
      if ((row.status === "created" || row.status === "revised") && row.question_id !== null) {
        const latest = this.bank.getLatestQuestionVersion(row.question_id);
        if (latest === undefined) {
          problems = ["题目已不存在"];
        } else {
          contentStatus = latest.contentStatus;
          answerStatus = latest.answerStatus;
          versionId = latest.id;
          preview = buildSearchText(latest.content).replace(/\s+/g, " ").trim().slice(0, 120);
          const classification = parseJson<Classification | undefined>(row.classification, undefined);
          const materials: ReviewMaterial[] = latest.content.materials.flatMap((ref) => {
            const material = this.bank.getMaterialVersion(ref.versionId);
            return material === undefined ? [] : [{ versionId: material.id, title: material.title, status: material.status }];
          });
          problems = contentReviewProblems({ content: latest.content, classification, materials });
        }
      }
      return {
        id: row.id,
        batchIndex: row.batch_index,
        questionIndex: row.question_index,
        originalNumber: row.original_number,
        page: row.page,
        status: row.status,
        message: row.message,
        questionId: row.status === "duplicate" ? null : row.question_id,
        versionId,
        contentStatus,
        answerStatus,
        preview,
        problems,
        materialIds,
      };
    });
  }

  resolve(taskId: string, recordId: string, action: "skip" | "revise"): void {
    const task = this.tasks.get(taskId);
    const row = this.db.read((sqlite) => sqlite.prepare("SELECT * FROM whole_paper_intakes WHERE id = ? AND task_id = ?").get(recordId, taskId)) as unknown as IntakeRow | undefined;
    if (row === undefined) throw new Error("建档记录不存在");
    if (row.status !== "duplicate") throw new Error("仅重复候选可处理");
    if (action === "skip") {
      this.updateRecord(recordId, "skipped", { message: "" });
      return;
    }
    if (action !== "revise") throw new Error("处理动作无效");
    const content = parseJson<QuestionContent | null>(row.content, null);
    if (content === null) throw new Error("候选题目内容缺失，无法建修订版");
    const saved = this.intake.save({
      examId: task.examId,
      sectionId: task.sectionId,
      questionId: row.question_id ?? undefined,
      content,
      classification: parseJson<Classification | undefined>(row.classification, undefined),
      submit: true,
    });
    if (!saved.saved) throw new Error("修订版保存失败");
    this.updateRecord(recordId, "revised", { message: "", versionId: saved.versionId });
  }

  private withMaterials(form: AiIntakeResult["form"], materialIds: string[]) {
    if (materialIds.length === 0) return form;
    const materials = materialIds.map((materialId) => {
      const latest = this.latestMaterial(materialId);
      if (latest === undefined) throw new Error("材料创建失败");
      return { materialId, versionId: latest.versionId, title: latest.title, status: latest.status };
    });
    return {
      ...form,
      materials: [...form.materials, ...materials],
      subQuestions: form.subQuestions.map((sub) => ({ ...sub, materialIds: [...new Set([...sub.materialIds, ...materialIds])] })),
    };
  }

  private latestMaterial(materialId: string): { versionId: string; title: string; status: ReviewStatus } | undefined {
    return this.db.read((sqlite) => {
      const row = sqlite.prepare("SELECT id, title, status FROM material_versions WHERE material_id = ? ORDER BY version DESC LIMIT 1").get(materialId) as { id: string; title: string; status: ReviewStatus } | undefined;
      return row === undefined ? undefined : { versionId: row.id, title: row.title, status: row.status };
    });
  }

  private insertRecord(record: { id: string; taskId: string; batchIndex: number; questionIndex: number; originalNumber: string; page: number; status: WholePaperIntakeStatus; message: string; questionId: string | null; versionId: string | null; content: string; classification: string; materialIds: string[] }, now: string): void {
    this.db.transaction((sqlite) => {
      sqlite.prepare(`INSERT INTO whole_paper_intakes (id, task_id, batch_index, question_index, original_number, page, status, message, question_id, version_id, content, classification, material_ids, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        record.id, record.taskId, record.batchIndex, record.questionIndex, record.originalNumber, record.page,
        record.status, record.message, record.questionId, record.versionId, record.content, record.classification,
        JSON.stringify(record.materialIds), now, now,
      );
    });
  }

  private updateRecord(recordId: string, status: WholePaperIntakeStatus, fields: { message: string; versionId?: string }): void {
    this.db.transaction((sqlite) => {
      sqlite.prepare("UPDATE whole_paper_intakes SET status = ?, message = ?, version_id = COALESCE(?, version_id), updated_at = ? WHERE id = ?")
        .run(status, fields.message, fields.versionId ?? null, new Date().toISOString(), recordId);
    });
  }
}
