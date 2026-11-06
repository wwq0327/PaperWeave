import { randomUUID } from "node:crypto";
import { aiQuestionToIntake, aiSlotHint, type AiIntakeResult } from "../shared/ai-intake";
import { AI_LIMITS } from "../shared/ai";
import { buildContent, buildContentBlocks, missingAnswerLabels } from "../shared/intake";
import { buildSearchText, classificationProblem, type Classification, type QuestionContent, type ReviewStatus } from "../shared/question";
import { contentReviewProblems, type ReviewMaterial } from "../shared/review";
import { mergeWholePaperQuestions, type WholePaperCandidate } from "../shared/whole-paper-merge";
import {
  wholePaperIssueCodes,
  wholePaperQualities,
  type WholePaperApprovalResult,
  type WholePaperEvidence,
  type WholePaperIntakeItem,
  type WholePaperIntakeStatus,
  type WholePaperIntakeSummary,
  type WholePaperIssue,
  type WholePaperIssueCode,
  type WholePaperMaterialSummary,
  type WholePaperQuality,
} from "../shared/whole-paper-intake";
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
  quality: WholePaperQuality;
  issues: string;
  message: string;
  question_id: string | null;
  version_id: string | null;
  content: string;
  classification: string;
  material_ids: string;
  member_keys: string;
  evidence: string;
  created_at: string;
  updated_at: string;
}

interface MaterialPlan {
  materialId: string;
  versionId: string;
  title: string;
  status: ReviewStatus;
  appliesTo: string[];
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

function parseIssues(raw: string): WholePaperIssue[] {
  const value = parseJson<unknown>(raw, []);
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is WholePaperIssue => {
    if (typeof item !== "object" || item === null) return false;
    const issue = item as Record<string, unknown>;
    return typeof issue.code === "string" && (wholePaperIssueCodes as readonly string[]).includes(issue.code) && typeof issue.message === "string";
  });
}

function isQuality(value: unknown): value is WholePaperQuality {
  return typeof value === "string" && (wholePaperQualities as readonly string[]).includes(value);
}

function parseEvidence(raw: string): WholePaperEvidence {
  const value = parseJson<Partial<WholePaperEvidence>>(raw, {});
  return {
    anchors: Array.isArray(value.anchors) ? value.anchors : [],
    materialAnchors: Array.isArray(value.materialAnchors) ? value.materialAnchors : [],
    figures: Array.isArray(value.figures) ? value.figures : [],
    answerSources: Array.isArray(value.answerSources) ? value.answerSources : [],
  };
}

const issue = (code: WholePaperIssueCode, message: string): WholePaperIssue => ({ code, message });

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
    const exam = this.exams.getExam(task.examId);
    // 教师只填差异项：空文本字段从考试元数据补齐，仍由分类校验把住其余非法输入。
    const filled = (value: unknown, fallback: string): unknown =>
      typeof value === "string" ? value.trim() || fallback : value;
    const effective = {
      ...classification,
      stage: filled(classification.stage, exam.exam.stage),
      subject: filled(classification.subject, exam.exam.subject),
      grade: filled(classification.grade, exam.exam.grade),
      examType: filled(classification.examType, exam.exam.examType),
      year: filled(classification.year, exam.exam.year),
      sourceName: filled(classification.sourceName, exam.exam.sourceName),
    } as Classification;
    const issueProblem = classificationProblem(effective);
    if (issueProblem !== null) throw new Error(`整卷分类无效：${issueProblem}`);
    const section = exam.sections.find((item) => item.id === task.sectionId);
    if (section === undefined) throw new Error("考试分部不存在");
    const existingRows = this.db.read((sqlite) => sqlite.prepare("SELECT batch_index, question_index, member_keys FROM whole_paper_intakes WHERE task_id = ?").all(taskId)) as unknown as Pick<IntakeRow, "batch_index" | "question_index" | "member_keys">[];
    const existing = new Set<string>();
    for (const row of existingRows) {
      const stored = parseJson<unknown>(row.member_keys, []);
      const keys = Array.isArray(stored) ? stored.filter((key): key is string => typeof key === "string") : [];
      if (keys.length === 0) existing.add(`${row.batch_index}:${row.question_index}`);
      else keys.forEach((key) => existing.add(key));
    }
    const tagCandidates = this.bank.knowledgePointCandidates(effective.stage, effective.subject, AI_LIMITS.tagCount);
    const candidates: WholePaperCandidate[] = [];
    task.state.batches.forEach((batch, batchIndex) => {
      if (batch.status !== "succeeded" || batch.result === undefined) return;
      batch.result.questions.forEach((question, questionIndex) => candidates.push({ batchIndex, questionIndex, question }));
    });
    const pending: { batchIndex: number; questionIndex: number; memberKeys: string[]; evidence: WholePaperEvidence; derived: AiIntakeResult; materials: MaterialPlan[]; materialIssues: WholePaperIssue[] }[] = [];
    for (const group of mergeWholePaperQuestions(candidates)) {
      const memberKeys = group.members.map((member) => `${member.batchIndex}:${member.questionIndex}`);
      // 任一成员已建档即整组跳过：跨批合并题不会因后续批次重跑而重复建档。
      if (memberKeys.some((key) => existing.has(key))) continue;
      const derived = aiQuestionToIntake(group.question, effective, section.title, tagCandidates);
      const materialIssues: WholePaperIssue[] = [];
      const materials: MaterialPlan[] = [];
      for (const suggestion of derived.materials) {
        const key = `${suggestion.title.trim()}|${suggestion.content.trim()}`;
        try {
          const material = this.createOrReuseMaterial(key, suggestion);
          const appliesTo = (suggestion.appliesTo ?? []).map((label) => label.trim()).filter(Boolean);
          const labels = derived.form.subQuestions.map((sub) => sub.originalLabel);
          if (appliesTo.length === 0 && labels.length > 1) {
            materialIssues.push(issue("material_scope", `材料「${suggestion.title}」未标明归属小问，暂关联全部小问，请核对。`));
          } else if (appliesTo.length > 0 && !appliesTo.some((label) => labels.includes(label))) {
            materialIssues.push(issue("material_scope", `材料「${suggestion.title}」的归属小问标签不存在，暂关联全部小问，请核对。`));
          }
          materials.push({ ...material, appliesTo });
        } catch (error) {
          materialIssues.push(issue("material_pending", `材料「${suggestion.title}」建立失败：${errorMessage(error)}`));
        }
      }
      const first = group.members[0];
      pending.push({ batchIndex: first.batchIndex, questionIndex: first.questionIndex, memberKeys, evidence: derived.evidence, derived, materials, materialIssues });
    }
    if (pending.length === 0) {
      return { created: 0, duplicates: 0, failed: 0, existing: existingRows.length, materials: 0, needsAttention: 0 };
    }
    let created = 0;
    let duplicates = 0;
    let failed = 0;
    let needsAttention = 0;
    const materialKeys = new Set<string>();
    pending.forEach((item) => {
      const now = new Date().toISOString();
      const record = {
        id: randomUUID(), taskId, batchIndex: item.batchIndex, questionIndex: item.questionIndex,
        memberKeys: item.memberKeys, evidence: item.evidence,
        originalNumber: "", page: 0, status: "failed" as WholePaperIntakeStatus, quality: "needs_attention" as WholePaperQuality,
        issues: [] as WholePaperIssue[], message: "",
        questionId: null as string | null, versionId: null as string | null, content: "", classification: "",
        materialIds: item.materials.map((material) => material.materialId),
      };
      try {
        const form = this.withMaterials(item.derived.form, item.materials);
        const built = buildContent(form);
        if (built.content === null) throw new Error(built.problems.join("；"));
        record.originalNumber = built.content.source.originalNumber;
        const page = built.content.source.pdfPage;
        record.page = Number.isInteger(page) && page >= 1 ? page : 0;
        record.content = JSON.stringify(built.content);
        record.classification = JSON.stringify(form.classification);
        const contentIssues = this.contentIssues(item.derived, built.content, item.materials, item.materialIssues);
        const saved = this.intake.save({
          examId: task.examId,
          sectionId: task.sectionId,
          content: built.content,
          classification: form.classification,
          submit: true,
        });
        if (saved.saved) {
          record.status = "created";
          record.questionId = saved.questionId;
          record.versionId = saved.versionId;
          record.issues = contentIssues;
          record.quality = contentIssues.length === 0 ? "auto_passed" : "needs_attention";
          created += 1;
          if (contentIssues.length > 0) needsAttention += 1;
        } else {
          record.status = "duplicate";
          record.questionId = saved.duplicate.questionId;
          record.message = `原题号「${record.originalNumber}」已存在：第 ${saved.duplicate.version} 版，原卷第 ${saved.duplicate.source.pdfPage} 页`;
          record.issues = [issue("duplicate", record.message), ...contentIssues];
          duplicates += 1;
          needsAttention += 1;
        }
      } catch (error) {
        record.status = "failed";
        record.message = errorMessage(error);
        record.issues = [issue("failed", record.message)];
        failed += 1;
        needsAttention += 1;
      }
      for (const material of item.materials) materialKeys.add(material.materialId);
      this.insertRecord(record, now);
    });
    return { created, duplicates, failed, existing: existingRows.length, materials: materialKeys.size, needsAttention };
  }

  list(taskId: string): WholePaperIntakeItem[] {
    const rows = this.db.read((sqlite) => sqlite.prepare("SELECT * FROM whole_paper_intakes WHERE task_id = ? ORDER BY batch_index, question_index").all(taskId)) as unknown as IntakeRow[];
    return rows.map((row) => {
      const materialIds = parseJson<string[]>(row.material_ids, []);
      const materials = materialIds.flatMap((materialId) => {
        const latest = this.latestMaterial(materialId);
        return latest === undefined ? [] : [{ materialId, ...latest }];
      });
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
          const reviewMaterials: ReviewMaterial[] = latest.content.materials.flatMap((ref) => {
            const material = this.bank.getMaterialVersion(ref.versionId);
            return material === undefined ? [] : [{ versionId: material.id, title: material.title, status: material.status }];
          });
          problems = contentReviewProblems({ content: latest.content, classification, materials: reviewMaterials });
        }
      }
      let quality: WholePaperQuality = isQuality(row.quality) ? row.quality : "needs_attention";
      let issues = parseIssues(row.issues);
      if (quality === "needs_attention") {
        // 材料审核完成后，材料待审异常自动消除；其余异常仍需教师显式处理。
        issues = issues.filter((entry) => entry.code !== "material_pending" || materials.some((material) => material.status !== "approved"));
        if (issues.length === 0) quality = "auto_passed";
      }
      return {
        id: row.id,
        batchIndex: row.batch_index,
        questionIndex: row.question_index,
        memberKeys: (() => {
          const stored = parseJson<unknown>(row.member_keys, []);
          return Array.isArray(stored) ? stored.filter((key): key is string => typeof key === "string") : [];
        })(),
        evidence: parseEvidence(row.evidence),
        originalNumber: row.original_number,
        page: row.page,
        status: row.status,
        quality,
        issues,
        message: row.message,
        questionId: row.status === "duplicate" ? null : row.question_id,
        versionId,
        contentStatus,
        answerStatus,
        preview,
        problems,
        materialIds,
        materials,
      };
    });
  }

  resolve(taskId: string, recordId: string, action: "skip" | "revise" | "resolve" | "exclude"): void {
    const task = this.tasks.get(taskId);
    const row = this.db.read((sqlite) => sqlite.prepare("SELECT * FROM whole_paper_intakes WHERE id = ? AND task_id = ?").get(recordId, taskId)) as unknown as IntakeRow | undefined;
    if (row === undefined) throw new Error("建档记录不存在");
    if (action === "resolve" || action === "exclude") {
      if (row.status !== "created" && row.status !== "revised") throw new Error("仅已建档题目可标记质量状态");
      if (action === "resolve") {
        this.updateQuality(recordId, "resolved");
      } else {
        this.updateQuality(recordId, "excluded");
      }
      return;
    }
    if (row.status !== "duplicate") throw new Error("仅重复候选可处理");
    if (action === "skip") {
      this.updateRecord(recordId, "skipped", { message: "", quality: "excluded" });
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
    const remainingIssues = parseIssues(row.issues).filter((entry) => entry.code !== "duplicate");
    this.updateRecord(recordId, "revised", {
      message: "",
      versionId: saved.versionId,
      quality: remainingIssues.length === 0 ? "auto_passed" : "needs_attention",
      issues: remainingIssues,
    });
  }

  approve(taskId: string, recordIds: string[]): WholePaperApprovalResult {
    if (!Array.isArray(recordIds) || recordIds.length === 0 || recordIds.length > 500) throw new Error("待确认题目无效");
    const unique = [...new Set(recordIds)];
    if (unique.some((id) => typeof id !== "string" || !id)) throw new Error("待确认题目无效");
    return this.db.transaction((sqlite) => {
      let approved = 0;
      const rejected: { id: string; reason: string }[] = [];
      for (const recordId of unique) {
        const row = sqlite.prepare("SELECT * FROM whole_paper_intakes WHERE id = ? AND task_id = ?").get(recordId, taskId) as unknown as IntakeRow | undefined;
        if (row === undefined) {
          rejected.push({ id: recordId, reason: "建档记录不存在" });
          continue;
        }
        const reason = this.approvalProblem(row);
        if (reason !== null) {
          rejected.push({ id: recordId, reason });
          continue;
        }
        this.bank.approveVersionWithin(sqlite, row.question_id as string, row.version_id as string);
        approved += 1;
      }
      return { approved, rejected };
    });
  }

  private approvalProblem(row: IntakeRow): string | null {
    if (row.status !== "created" && row.status !== "revised") return "非已建档题目";
    if (row.question_id === null || row.version_id === null) return "缺少题目版本";
    const quality = isQuality(row.quality) ? row.quality : "needs_attention";
    if (quality === "excluded") return "题目已排除";
    if (quality === "needs_attention") {
      const materials = parseJson<string[]>(row.material_ids, []).flatMap((materialId) => {
        const latest = this.latestMaterial(materialId);
        return latest === undefined ? [] : [latest];
      });
      const issues = parseIssues(row.issues).filter((entry) => entry.code !== "material_pending" || materials.some((material) => material.status !== "approved"));
      if (issues.length > 0) return `仍有未处理异常：${issues.map((entry) => entry.message).join("；")}`;
    }
    const latest = this.bank.getLatestQuestionVersion(row.question_id);
    if (latest === undefined) return "题目已不存在";
    if (latest.id !== row.version_id) return "题目已有新版本，请重新读取后再确认";
    if (latest.contentStatus === "approved") return "内容已通过";
    const classification = parseJson<Classification | undefined>(row.classification, undefined);
    const materials: ReviewMaterial[] = latest.content.materials.flatMap((ref) => {
      const material = this.bank.getMaterialVersion(ref.versionId);
      return material === undefined ? [] : [{ versionId: material.id, title: material.title, status: material.status }];
    });
    const problems = contentReviewProblems({ content: latest.content, classification, materials });
    if (problems.length > 0) return problems.join("；");
    return null;
  }

  private contentIssues(derived: AiIntakeResult, content: QuestionContent, materials: MaterialPlan[], materialIssues: WholePaperIssue[]): WholePaperIssue[] {
    const issues: WholePaperIssue[] = [];
    const uncertain = derived.uncertain.filter((item) => item !== aiSlotHint);
    if (uncertain.length > 0) issues.push(issue("uncertain", `模型待核：${uncertain.join("；")}`));
    if (derived.newTags.length > 0) issues.push(issue("new_tag", `候选外标签建议未写入：${derived.newTags.join("、")}`));
    const missingAnswers = missingAnswerLabels(content);
    if (missingAnswers.length > 0) issues.push(issue("answer_missing", `以下小问缺少答案：${missingAnswers.join("、")}`));
    const missingScores = content.subQuestions.filter((sub) => sub.originalScore === null).map((sub) => sub.originalLabel.trim() || sub.id);
    if (missingScores.length > 0) issues.push(issue("score_missing", `以下小问缺少原分值：${missingScores.join("、")}`));
    const pendingMaterials = materials.filter((material) => material.status !== "approved").map((material) => material.title);
    if (pendingMaterials.length > 0) issues.push(issue("material_pending", `材料草稿待审核：${pendingMaterials.join("、")}`));
    issues.push(...materialIssues);
    return issues;
  }

  private createOrReuseMaterial(key: string, suggestion: AiIntakeResult["materials"][number]): { materialId: string; versionId: string; title: string; status: ReviewStatus } {
    const cached = this.materialIdByKey.get(key);
    const materialId = cached ?? (() => {
      const built = buildContentBlocks([{ kind: "text", text: suggestion.content }], "材料正文");
      if (built.problems.length > 0) throw new Error(built.problems.join("；"));
      const created = this.bank.createMaterial({ title: suggestion.title, content: built.blocks, source: suggestion.source });
      this.materialIdByKey.set(key, created.materialId);
      return created.materialId;
    })();
    const latest = this.latestMaterial(materialId);
    if (latest === undefined) throw new Error("材料创建失败");
    return { materialId, ...latest };
  }

  /** 进程内材料去重表；重启后由已有建档记录跳过，不会重复处理同一任务。 */
  private materialIdByKey = new Map<string, string>();

  private withMaterials(form: AiIntakeResult["form"], materials: MaterialPlan[]) {
    if (materials.length === 0) return form;
    const all = [...new Map(materials.map((material) => [material.materialId, { materialId: material.materialId, versionId: material.versionId, title: material.title, status: material.status }])).values()];
    const labels = new Set(form.subQuestions.map((sub) => sub.originalLabel));
    const unknownScope = materials.some((material) => material.appliesTo.length > 0 && !material.appliesTo.some((label) => labels.has(label)));
    return {
      ...form,
      materials: [...form.materials, ...all],
      subQuestions: form.subQuestions.map((sub) => {
        const applicable = materials.filter((material) => material.appliesTo.length === 0 || material.appliesTo.includes(sub.originalLabel));
        const attached = applicable.length > 0 ? applicable : unknownScope ? materials : [];
        return { ...sub, materialIds: [...new Set([...sub.materialIds, ...attached.map((material) => material.materialId)])] };
      }),
    };
  }

  private latestMaterial(materialId: string): { versionId: string; title: string; status: ReviewStatus } | undefined {
    return this.db.read((sqlite) => {
      const row = sqlite.prepare("SELECT id, title, status FROM material_versions WHERE material_id = ? ORDER BY version DESC LIMIT 1").get(materialId) as { id: string; title: string; status: ReviewStatus } | undefined;
      return row === undefined ? undefined : { versionId: row.id, title: row.title, status: row.status };
    });
  }

  private insertRecord(record: { id: string; taskId: string; batchIndex: number; questionIndex: number; memberKeys: string[]; evidence: WholePaperEvidence; originalNumber: string; page: number; status: WholePaperIntakeStatus; quality: WholePaperQuality; issues: WholePaperIssue[]; message: string; questionId: string | null; versionId: string | null; content: string; classification: string; materialIds: string[] }, now: string): void {
    this.db.transaction((sqlite) => {
      sqlite.prepare(`INSERT INTO whole_paper_intakes (id, task_id, batch_index, question_index, member_keys, evidence, original_number, page, status, quality, issues, message, question_id, version_id, content, classification, material_ids, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        record.id, record.taskId, record.batchIndex, record.questionIndex, JSON.stringify(record.memberKeys), JSON.stringify(record.evidence),
        record.originalNumber, record.page,
        record.status, record.quality, JSON.stringify(record.issues), record.message, record.questionId, record.versionId,
        record.content, record.classification, JSON.stringify(record.materialIds), now, now,
      );
    });
  }

  private updateRecord(recordId: string, status: WholePaperIntakeStatus, fields: { message: string; versionId?: string; quality?: WholePaperQuality; issues?: WholePaperIssue[] }): void {
    this.db.transaction((sqlite) => {
      sqlite.prepare("UPDATE whole_paper_intakes SET status = ?, message = ?, version_id = COALESCE(?, version_id), quality = COALESCE(?, quality), issues = COALESCE(?, issues), updated_at = ? WHERE id = ?")
        .run(status, fields.message, fields.versionId ?? null, fields.quality ?? null, fields.issues === undefined ? null : JSON.stringify(fields.issues), new Date().toISOString(), recordId);
    });
  }

  private updateQuality(recordId: string, quality: WholePaperQuality): void {
    this.db.transaction((sqlite) => {
      sqlite.prepare("UPDATE whole_paper_intakes SET quality = ?, updated_at = ? WHERE id = ?").run(quality, new Date().toISOString(), recordId);
    });
  }
}
