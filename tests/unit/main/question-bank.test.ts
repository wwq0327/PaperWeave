import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, test } from "vitest";
import { Database } from "../../../src/main/database";
import { QuestionBank } from "../../../src/main/question-bank";
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
