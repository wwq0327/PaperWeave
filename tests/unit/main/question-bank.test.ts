import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, test } from "vitest";
import { Database } from "../../../src/main/database";
import { QuestionBank } from "../../../src/main/question-bank";
import type { Classification } from "../../../src/shared/question";
import { math, note, paragraph } from "../fixtures/questions";

const directories: string[] = [];
function open(): { db: Database; bank: QuestionBank; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "paperweave-bank-"));
  directories.push(dir);
  const path = join(dir, "题库.sqlite");
  const db = new Database(path);
  return { db, bank: new QuestionBank(db), path };
}
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test("新建题目为草稿、版本 1、答案待补，重开后内容一致", () => {
  const { db, bank, path } = open();
  const created = bank.createQuestion(note());
  expect(created.version).toBe(1);
  expect(created.contentStatus).toBe("draft");
  expect(created.answerStatus).toBe("missing");
  db.close();
  const reopened = new Database(path);
  const reread = new QuestionBank(reopened).getQuestionVersion(created.id);
  expect(reread).toEqual(created);
  expect(reread?.content.subQuestions[0].explanation).toEqual([paragraph("留言条应写明时间、地点和事情。")]);
  reopened.close();
});

test("原分值、小问材料与图引用保存后重开一致", () => {
  const { db, bank, path } = open();
  const material = bank.createMaterial({ title: "材料一", content: [paragraph("材料正文")], source: "自编" });
  const content = math();
  content.materials = [{ materialId: material.materialId, versionId: material.id }];
  content.subQuestions[0].materialIds = [material.materialId];
  content.subQuestions[0].prompt = [{ type: "image", id: "a".repeat(64), alt: "示意图", figureId: "figure-1" }];
  content.subQuestions[0].answers = [{ slotId: "p1-slot", blocks: [{ type: "paragraph", runs: [{ type: "reference", kind: "figure", targetId: "figure-1", fallback: "图 1" }] }], variants: [] }];
  content.subQuestions[1].originalScore = null;
  const created = bank.createQuestion(content);
  db.close();
  const reopened = new Database(path);
  const reread = new QuestionBank(reopened).getQuestionVersion(created.id);
  expect(reread?.content).toEqual(content);
  reopened.close();
});

test("审核通过后修改生成版本 2 并回到待核，旧版本不变", () => {
  const { bank } = open();
  const created = bank.createQuestion(math());
  bank.setContentStatus(created.id, "pending");
  bank.setContentStatus(created.id, "approved");
  bank.setAnswerStatus(created.id, "pending");
  bank.setAnswerStatus(created.id, "approved");

  const changed = math();
  changed.stem = [paragraph("修改后的题干")];
  const next = bank.saveQuestionVersion(created.questionId, changed);
  expect(next.version).toBe(2);
  expect(next.contentStatus).toBe("pending");
  expect(next.answerStatus).toBe("pending");
  expect(next.content.stem).not.toEqual(created.content.stem);

  const old = bank.getQuestionVersion(created.id);
  expect(old?.contentStatus).toBe("approved");
  expect(old?.answerStatus).toBe("approved");
  expect(old?.content.stem).toEqual(created.content.stem);
  expect(bank.getLatestQuestionVersion(created.questionId)?.id).toBe(next.id);
});

test("答案状态独立流转", () => {
  const { bank } = open();
  const created = bank.createQuestion(note());
  bank.setAnswerStatus(created.id, "pending");
  expect(bank.getQuestionVersion(created.id)?.contentStatus).toBe("draft");
  bank.setAnswerStatus(created.id, "approved");
  expect(bank.getQuestionVersion(created.id)?.answerStatus).toBe("approved");
  expect(bank.getQuestionVersion(created.id)?.contentStatus).toBe("draft");
});

test("拒绝非法状态跳转和已审核版本改状态", () => {
  const { bank } = open();
  const created = bank.createQuestion(note());
  expect(() => bank.setContentStatus(created.id, "approved")).toThrow();
  expect(() => bank.setAnswerStatus(created.id, "approved")).toThrow();
  bank.setContentStatus(created.id, "pending");
  bank.setAnswerStatus(created.id, "pending");
  bank.setContentStatus(created.id, "approved");
  bank.setAnswerStatus(created.id, "approved");
  bank.setContentStatus(created.id, "approved");
  expect(() => bank.setContentStatus(created.id, "pending")).toThrow();
  expect(() => bank.setAnswerStatus(created.id, "missing")).toThrow();
});

test("材料审核后修改生成新版本并待核，旧版本不变", () => {
  const { bank } = open();
  const material = bank.createMaterial({ title: "共享材料", content: [paragraph("材料一")], source: "自制" });
  expect(material.version).toBe(1);
  expect(material.status).toBe("draft");
  bank.setMaterialStatus(material.id, "pending");
  bank.setMaterialStatus(material.id, "approved");

  const next = bank.saveMaterialVersion(material.materialId, { title: "共享材料", content: [paragraph("材料二")], source: "自制" });
  expect(next.version).toBe(2);
  expect(next.status).toBe("pending");
  expect(bank.getMaterialVersion(material.id)?.status).toBe("approved");
  expect(bank.getMaterialVersion(material.id)?.content).toEqual([paragraph("材料一")]);
});

test("拒绝非法题目内容且不留下半条记录", () => {
  const { bank, path } = open();
  expect(() => bank.createQuestion({ ...note(), extra: true })).toThrow("题目结构无效");

  const dangling = note();
  dangling.materials = [{ materialId: "material-1", versionId: "material-v1" }];
  expect(() => bank.createQuestion(dangling)).toThrow("材料版本不存在");

  const raw = new DatabaseSync(path);
  expect((raw.prepare("SELECT count(*) AS count FROM questions").get() as { count: number }).count).toBe(0);
  expect((raw.prepare("SELECT count(*) AS count FROM question_versions").get() as { count: number }).count).toBe(0);
  raw.close();
});

function approvedMaterial(bank: QuestionBank, title = "共享材料") {
  const material = bank.createMaterial({ title, content: [paragraph("材料一")], source: "自制" });
  bank.setMaterialStatus(material.id, "pending");
  bank.setMaterialStatus(material.id, "approved");
  return material;
}

function withMaterial(material: { materialId: string; id: string }, originalNumber = "15") {
  const content = note();
  content.source = { ...content.source, originalNumber };
  content.materials = [{ materialId: material.materialId, versionId: material.id }];
  return content;
}

test("一份材料被三道题引用，材料改版后三道题全部列为受影响", () => {
  const { bank } = open();
  const material = approvedMaterial(bank);
  const questions = ["甲", "乙", "丙"].map((label) => bank.createQuestion(withMaterial(material, label)));
  expect(bank.questionsAffectedByMaterial(material.materialId)).toEqual([]);

  const next = bank.saveMaterialVersion(material.materialId, { title: "共享材料", content: [paragraph("材料二")], source: "自制" });
  expect(next.version).toBe(2);
  const affected = bank.questionsAffectedByMaterial(material.materialId);
  expect(affected.map((item) => item.questionId).sort()).toEqual(questions.map((question) => question.questionId).sort());
  for (const item of affected) {
    expect(item.version).toBe(1);
    expect(item.materialVersion).toBe(material.version);
    expect(item.latestVersionId).toBe(next.id);
    expect(item.latestVersion).toBe(next.version);
  }
});

test("采用新版材料后生成新版本并待核，旧版本仍引用旧材料", () => {
  const { bank } = open();
  const material = approvedMaterial(bank);
  const question = bank.createQuestion(withMaterial(material));
  bank.setContentStatus(question.id, "pending");
  bank.setContentStatus(question.id, "approved");
  bank.setAnswerStatus(question.id, "pending");
  bank.setAnswerStatus(question.id, "approved");

  const nextMaterial = bank.saveMaterialVersion(material.materialId, { title: "共享材料", content: [paragraph("材料二")], source: "自制" });
  const adopted = bank.adoptMaterialVersion(question.questionId, material.materialId, nextMaterial.id);
  expect(adopted.version).toBe(2);
  expect(adopted.contentStatus).toBe("pending");
  expect(adopted.answerStatus).toBe("pending");
  expect(adopted.content.materials).toEqual([{ materialId: material.materialId, versionId: nextMaterial.id }]);
  expect(bank.getQuestionVersion(question.id)?.content.materials[0].versionId).toBe(material.id);
  expect(bank.getLatestQuestionVersion(question.questionId)?.id).toBe(adopted.id);
});

test("已采用新版的题目不再出现在受影响列表", () => {
  const { bank } = open();
  const material = approvedMaterial(bank);
  const question = bank.createQuestion(withMaterial(material));
  const nextMaterial = bank.saveMaterialVersion(material.materialId, { title: "共享材料", content: [paragraph("材料二")], source: "自制" });
  expect(bank.questionsAffectedByMaterial(material.materialId)).toHaveLength(1);
  bank.adoptMaterialVersion(question.questionId, material.materialId, nextMaterial.id);
  expect(bank.questionsAffectedByMaterial(material.materialId)).toEqual([]);
});

test("采用不存在、不属于该材料或未引用的版本被拒绝", () => {
  const { bank } = open();
  const material = approvedMaterial(bank);
  const other = approvedMaterial(bank, "另一份材料");
  const question = bank.createQuestion(withMaterial(material));
  expect(() => bank.adoptMaterialVersion(question.questionId, material.materialId, "missing")).toThrow("材料版本不存在");
  expect(() => bank.adoptMaterialVersion(question.questionId, material.materialId, other.id)).toThrow("不属于该材料");
  const unrelated = bank.createQuestion(note());
  expect(() => bank.adoptMaterialVersion(unrelated.questionId, material.materialId, material.id)).toThrow("未引用该材料");
});

test("就绪检查接入材料状态：材料未审核阻断，确认答案待补后通过", () => {
  const { bank } = open();
  const material = approvedMaterial(bank);
  bank.saveMaterialVersion(material.materialId, { title: "共享材料", content: [paragraph("材料二")], source: "自制" });
  const question = bank.createQuestion(withMaterial(material));
  bank.setContentStatus(question.id, "pending");
  bank.setContentStatus(question.id, "approved");
  bank.setAnswerStatus(question.id, "pending");
  bank.setAnswerStatus(question.id, "approved");

  // 题目引用的是已审核的旧版材料，因此材料本身不阻断；换成未审核版本后再验。
  expect(bank.checkReady(question.id)).toEqual({ ready: true, blockers: [], notices: [], requiresAnswerConfirmation: false });
  const nextMaterial = bank.saveMaterialVersion(material.materialId, { title: "共享材料", content: [paragraph("材料三")], source: "自制" });
  const adopted = bank.adoptMaterialVersion(question.questionId, material.materialId, nextMaterial.id);
  bank.setContentStatus(adopted.id, "pending");
  bank.setContentStatus(adopted.id, "approved");
  bank.setAnswerStatus(adopted.id, "pending");
  bank.setAnswerStatus(adopted.id, "approved");
  const blocked = bank.checkReady(adopted.id);
  expect(blocked.ready).toBe(false);
  expect(blocked.blockers).toContain(`材料「${material.materialId}」尚未审核`);

  bank.setMaterialStatus(nextMaterial.id, "pending");
  bank.setMaterialStatus(nextMaterial.id, "approved");
  expect(bank.checkReady(adopted.id)).toEqual({ ready: true, blockers: [], notices: [], requiresAnswerConfirmation: false });

  const gapQuestion = bank.createQuestion(note());
  bank.setContentStatus(gapQuestion.id, "pending");
  bank.setContentStatus(gapQuestion.id, "approved");
  const unconfirmed = bank.checkReady(gapQuestion.id);
  expect(unconfirmed.requiresAnswerConfirmation).toBe(true);
  expect(unconfirmed.ready).toBe(false);
  const confirmed = bank.checkReady(gapQuestion.id, { confirmAnswerGap: true });
  expect(confirmed.ready).toBe(true);
  expect(confirmed.notices.length).toBeGreaterThan(0);
});

const classification = {
  stage: "小学",
  subject: "语文",
  grade: "三年级",
  examType: "期中",
  year: "2025-2026",
  sourceName: "自编",
  questionType: "阅读",
  knowledgePoints: ["概括", "人物形象"],
} satisfies Classification;

test("创建题目时写入分类，读取一致；未提供分类时返回 undefined", () => {
  const { bank } = open();
  const categorized = bank.createQuestion(note(), classification);
  expect(bank.getQuestionClassification(categorized.questionId)).toEqual(classification);
  const plain = bank.createQuestion(note());
  expect(bank.getQuestionClassification(plain.questionId)).toBeUndefined();
  expect(bank.getQuestionClassification("missing")).toBeUndefined();
});

test("修改分类不生成新版本，也不改变内容审核状态", () => {
  const { bank } = open();
  const created = bank.createQuestion(note(), classification);
  bank.setContentStatus(created.id, "pending");
  bank.setContentStatus(created.id, "approved");
  const updated = { ...classification, examType: "期末", knowledgePoints: ["概括"] };
  expect(bank.setClassification(created.questionId, updated)).toEqual(updated);
  const latest = bank.getLatestQuestionVersion(created.questionId);
  expect(latest?.id).toBe(created.id);
  expect(latest?.version).toBe(1);
  expect(latest?.contentStatus).toBe("approved");
  expect(bank.getQuestionClassification(created.questionId)).toEqual(updated);
});

test("修改分类时知识点整体替换", () => {
  const { bank } = open();
  const created = bank.createQuestion(note(), classification);
  bank.setClassification(created.questionId, { ...classification, knowledgePoints: ["分析"] });
  expect(bank.getQuestionClassification(created.questionId)?.knowledgePoints).toEqual(["分析"]);
  bank.setClassification(created.questionId, { ...classification, knowledgePoints: [] });
  expect(bank.getQuestionClassification(created.questionId)?.knowledgePoints).toEqual([]);
});

test("非法分类被拒绝且不留下部分更新", () => {
  const { bank, path } = open();
  const created = bank.createQuestion(note(), classification);
  expect(() => bank.setClassification(created.questionId, { ...classification, stage: "大学" })).toThrow("学段无效");
  expect(() => bank.setClassification(created.questionId, { ...classification, knowledgePoints: ["概括", "概括"] })).toThrow();
  expect(bank.getQuestionClassification(created.questionId)).toEqual(classification);
  expect(() => bank.setClassification("missing", classification)).toThrow("题目不存在");
  expect(() => bank.createQuestion(note(), { ...classification, stage: "大学" })).toThrow("学段无效");

  const raw = new DatabaseSync(path);
  expect((raw.prepare("SELECT count(*) AS count FROM questions").get() as { count: number }).count).toBe(1);
  expect((raw.prepare("SELECT count(*) AS count FROM question_knowledge_points").get() as { count: number }).count).toBe(2);
  raw.close();
});

test("两项以上筛选条件命中目标题，无结果返回空列表", () => {
  const { bank } = open();
  const primary = bank.createQuestion(note(), classification);
  const secondary = bank.createQuestion(note(), {
    ...classification,
    stage: "初中",
    subject: "数学",
    grade: "七年级",
    knowledgePoints: ["方程"],
  });
  expect(bank.searchQuestions({ stage: "小学", subject: "语文" }).map((item) => item.questionId)).toEqual([primary.questionId]);
  expect(bank.searchQuestions({ subject: "数学", knowledgePoint: "方程" }).map((item) => item.questionId)).toEqual([secondary.questionId]);
  expect(bank.searchQuestions({ stage: "初中", subject: "语文" })).toEqual([]);
  expect(bank.searchQuestions({ knowledgePoint: "方程", questionType: "写作" })).toEqual([]);
});

test("关键词只命中题干与选项，不命中答案、解析或材料正文", () => {
  const { bank } = open();
  const material = bank.createMaterial({ title: "材料", content: [paragraph("材料关键词")], source: "自制" });
  const content = note();
  content.stem = [paragraph("题组指令关键词")];
  content.subQuestions[0].prompt = [paragraph("题干关键词")];
  content.subQuestions[0].options = [{ label: "A", content: [paragraph("选项关键词")] }];
  content.subQuestions[0].explanation = [paragraph("解析关键词")];
  content.subQuestions[0].answers = [{ slotId: null, blocks: [paragraph("答案关键词")], variants: ["变体关键词"] }];
  content.subQuestions[0].scoring = [{ id: "s1", description: "评分关键词", score: 5, slotIds: [] }];
  content.materials = [{ materialId: material.materialId, versionId: material.id }];
  bank.createQuestion(content);
  const hits = (keyword: string) => bank.searchQuestions({ keyword }).length;
  expect(hits("题干关键词")).toBe(1);
  expect(hits("题组指令关键词")).toBe(1);
  expect(hits("选项关键词")).toBe(1);
  for (const forbidden of ["解析关键词", "答案关键词", "变体关键词", "评分关键词", "材料关键词"]) expect(hits(forbidden)).toBe(0);
});

test("审核状态按最新版本过滤，历史版本不误命中", () => {
  const { bank } = open();
  const created = bank.createQuestion(note());
  bank.setContentStatus(created.id, "pending");
  bank.setContentStatus(created.id, "approved");
  bank.setAnswerStatus(created.id, "pending");
  bank.setAnswerStatus(created.id, "approved");
  const next = bank.saveQuestionVersion(created.questionId, note());
  expect(next.contentStatus).toBe("pending");
  expect(next.answerStatus).toBe("pending");
  expect(bank.searchQuestions({ contentStatus: "approved" })).toEqual([]);
  expect(bank.searchQuestions({ contentStatus: "pending" }).map((item) => item.questionId)).toEqual([created.questionId]);
  expect(bank.searchQuestions({ answerStatus: "approved" })).toEqual([]);
  expect(bank.searchQuestions({ answerStatus: "pending" }).map((item) => item.questionId)).toEqual([created.questionId]);
});

test("分类更新后按新分类可检索到，旧分类不再命中", () => {
  const { bank } = open();
  const created = bank.createQuestion(note(), classification);
  expect(bank.searchQuestions({ subject: "语文" }).map((item) => item.questionId)).toEqual([created.questionId]);
  bank.setClassification(created.questionId, { ...classification, subject: "数学", knowledgePoints: ["计算"] });
  expect(bank.searchQuestions({ subject: "语文" })).toEqual([]);
  expect(bank.searchQuestions({ subject: "数学" }).map((item) => item.questionId)).toEqual([created.questionId]);
  expect(bank.searchQuestions({ knowledgePoint: "概括" })).toEqual([]);
  expect(bank.searchQuestions({ knowledgePoint: "计算" }).map((item) => item.questionId)).toEqual([created.questionId]);
});

test("非法筛选条件被拒绝", () => {
  const { bank } = open();
  bank.createQuestion(note());
  expect(() => bank.searchQuestions({ extra: true })).toThrow("未知字段");
  for (const limit of [0, 201, 1.5, "10"]) expect(() => bank.searchQuestions({ limit })).toThrow("检索数量无效");
  expect(() => bank.searchQuestions({ contentStatus: "unknown" })).toThrow("检索内容状态无效");
  expect(() => bank.searchQuestions({ answerStatus: "unknown" })).toThrow("检索答案状态无效");
  expect(() => bank.searchQuestions({ stage: "大学" })).toThrow("检索学段无效");
  expect(() => bank.searchQuestions({ keyword: "长".repeat(201) })).toThrow("检索条件「keyword」无效");
  expect(() => bank.searchQuestions({ knowledgePoint: "长".repeat(201) })).toThrow("检索条件「knowledgePoint」无效");
  expect(bank.searchQuestions()).toHaveLength(1);
});

test("结果包含题干预览、来源、材料标识与最新版本状态", () => {
  const { bank } = open();
  const material = approvedMaterial(bank);
  const content = withMaterial(material);
  content.source = { section: "语文·阅读", pdfPage: 5, originalNumber: "12" };
  const question = bank.createQuestion(content, classification);
  bank.setContentStatus(question.id, "pending");
  bank.setContentStatus(question.id, "approved");
  bank.setAnswerStatus(question.id, "pending");
  bank.setAnswerStatus(question.id, "approved");

  const results = bank.searchQuestions({ keyword: "留言条" });
  expect(results).toHaveLength(1);
  expect(results[0]).toMatchObject({
    questionId: question.questionId,
    versionId: question.id,
    version: 1,
    contentStatus: "approved",
    answerStatus: "approved",
    classification,
    source: content.source,
    materialIds: [material.materialId],
  });
  expect(results[0].preview).toContain("根据情境写一张留言条");
  expect(results[0].preview.length).toBeLessThanOrEqual(120);
  expect(results[0].preview).not.toContain("示例答案");
  expect(bank.searchQuestions({ limit: 1 })).toHaveLength(1);
});
