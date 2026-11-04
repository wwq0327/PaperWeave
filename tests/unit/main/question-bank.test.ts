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
