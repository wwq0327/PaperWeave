import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { AttachmentStore } from "../../../src/main/attachments";
import { Database } from "../../../src/main/database";
import { ExamStore } from "../../../src/main/exams";
import { Intake } from "../../../src/main/intake";
import { QuestionBank } from "../../../src/main/question-bank";
import type { SaveIntakeResult } from "../../../src/shared/intake";
import type { Classification, QuestionContent } from "../../../src/shared/question";

const directories: string[] = [];
function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  directories.push(dir);
  return dir;
}
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const pdf = (text: string) => Buffer.from(`%PDF-1.4\n${text}\n%%EOF`);
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const classification: Classification = { stage: "初中", subject: "数学", grade: "九年级", examType: "单元测", year: "2026", sourceName: "自制样题", questionType: "解答题", knowledgePoints: ["一元二次方程"] };
const examInput = { title: "九年级数学单元卷", stage: "初中" as const, subject: "数学", grade: "九年级", region: "", examType: "单元测", year: "2026", sourceName: "自制样题" };

function saved(result: SaveIntakeResult) {
  if (!result.saved) throw new Error(`预期保存成功，实际提示重复题 ${result.duplicate.questionId}`);
  return result;
}

function importExam(store: ExamStore, title: string) {
  const source = temp("paperweave-intake-src-");
  const pdfPath = join(source, `${title}.pdf`);
  writeFileSync(pdfPath, pdf(`合成原卷 ${title}`));
  const imported = store.importPaper({ ...examInput, title }, pdfPath);
  return { examId: imported.exam.id, sectionId: store.getExam(imported.exam.id).sections[0].id };
}

function content(label: string, answer?: string): QuestionContent {
  return {
    stem: [{ type: "paragraph", runs: [{ type: "text", text: "合成题干", style: "普通" }] }],
    subQuestions: [{
      id: `sub-${label}`,
      originalLabel: label,
      prompt: [{ type: "paragraph", runs: [{ type: "text", text: `合成小问 ${label}`, style: "普通" }] }],
      explanation: [],
      options: [],
      slots: [],
      answers: answer === undefined ? [] : [{ slotId: null, blocks: [{ type: "paragraph", runs: [{ type: "text", text: answer, style: "普通" }] }], variants: [] }],
      scoring: [{ id: `score-${label}`, description: "答案正确", score: 4, slotIds: [] }],
      originalScore: 4,
      materialIds: [],
      dependsOn: [],
    }],
    materials: [],
    selection: { mode: "all" },
    source: { section: "全卷", pdfPage: 1, originalNumber: label },
  };
}

function open() {
  const root = temp("paperweave-intake-");
  const source = temp("paperweave-intake-src-");
  const db = new Database(join(root, "paperweave.sqlite"));
  const store = new ExamStore(db, root);
  const pdfPath = join(source, "单元卷.pdf");
  writeFileSync(pdfPath, pdf("合成原卷"));
  const imported = store.importPaper({ title: "九年级数学单元卷", stage: "初中", subject: "数学", grade: "九年级", region: "", examType: "单元测", year: "2026", sourceName: "自制样题" }, pdfPath);
  const section = store.getExam(imported.exam.id).sections[0];
  return { root, db, store, bank: new QuestionBank(db), intake: new Intake(store, new QuestionBank(db)), examId: imported.exam.id, sectionId: section.id };
}

test("新题保存为草稿并关联考试；提交待核时答案状态随内容流转", () => {
  const { store, intake, examId, sectionId } = open();
  const draft = saved(intake.save({ examId, sectionId, content: content("1"), classification, submit: false }));
  expect(draft).toMatchObject({ version: 1, contentStatus: "draft", answerStatus: "missing" });
  const listed = store.listQuestions(examId);
  expect(listed).toHaveLength(1);
  expect(listed[0]).toMatchObject({ questionId: draft.questionId, versionId: draft.versionId, contentStatus: "draft", source: { pdfPage: 1, originalNumber: "1" } });

  const submittedWithAnswer = saved(intake.save({ examId, sectionId, content: content("2", "4"), classification, submit: true }));
  expect(submittedWithAnswer).toMatchObject({ contentStatus: "pending", answerStatus: "pending" });
  const submittedWithoutAnswer = saved(intake.save({ examId, sectionId, content: content("3"), classification, submit: true }));
  expect(submittedWithoutAnswer).toMatchObject({ contentStatus: "pending", answerStatus: "missing" });
  expect(store.listQuestions(examId)).toHaveLength(3);
});

test("已有题保存新版本，身份不变，已审核内容回到待核", () => {
  const { bank, intake, examId, sectionId } = open();
  const first = saved(intake.save({ examId, sectionId, content: content("1", "4"), classification, submit: true }));
  bank.setContentStatus(first.versionId, "approved");
  bank.setAnswerStatus(first.versionId, "approved");
  const changed = content("1", "5");
  changed.stem = [{ type: "paragraph", runs: [{ type: "text", text: "修改后的题干", style: "普通" }] }];
  const second = saved(intake.save({ examId, sectionId, questionId: first.questionId, content: changed, classification: { ...classification, knowledgePoints: ["一元二次方程", "判别式"] }, submit: true }));
  expect(second.questionId).toBe(first.questionId);
  expect(second.version).toBe(2);
  expect(second).toMatchObject({ contentStatus: "pending", answerStatus: "pending" });
  expect(bank.getLatestQuestionVersion(first.questionId)?.content.stem).toEqual(changed.stem);
  expect(bank.getQuestionClassification(first.questionId)?.knowledgePoints).toEqual(["一元二次方程", "判别式"]);
});

test("分类无效且保存已有题时不产生新版本", () => {
  const { bank, intake, examId, sectionId } = open();
  const first = saved(intake.save({ examId, sectionId, content: content("1", "4"), classification }));
  expect(() => intake.save({ examId, sectionId, questionId: first.questionId, content: content("1", "5"), classification: { ...classification, stage: "大学" as never } })).toThrow("分类无效");
  expect(bank.getLatestQuestionVersion(first.questionId)?.version).toBe(1);
});

test("分部不属于该考试或题目不存在时拒绝保存", () => {
  const { intake, examId, sectionId } = open();
  expect(() => intake.save({ examId, sectionId: "00000000-0000-0000-0000-000000000000", content: content("9"), classification })).toThrow("分部");
  expect(() => intake.save({ examId, sectionId, questionId: "00000000-0000-0000-0000-000000000000", content: content("1"), classification })).toThrow("题目不存在");
  expect(() => intake.save({ examId, sectionId, content: { stem: [] }, classification })).toThrow("题目结构无效");
});

test("同卷同分部同号再次保存时返回已有题，不静默新建", () => {
  const { bank, intake, store, examId, sectionId } = open();
  const first = saved(intake.save({ examId, sectionId, content: content("1", "4"), classification }));
  const second = intake.save({ examId, sectionId, content: content("1", "5"), classification });
  expect(second.saved).toBe(false);
  if (second.saved) throw new Error("预期提示重复题");
  expect(second.duplicate).toMatchObject({ questionId: first.questionId, versionId: first.versionId, version: 1, preview: "合成题干 合成小问 1" });
  expect(store.getExam(examId).questionCount).toBe(1);
  expect(bank.getLatestQuestionVersion(first.questionId)?.version).toBe(1);
});

test("同一题内小问号重复时拒绝保存；不同题各自使用相同小问号不误判", () => {
  const { store, intake, examId, sectionId } = open();
  const duplicated = content("1");
  duplicated.subQuestions = [
    { ...duplicated.subQuestions[0], id: "sub-a", originalLabel: "(1)" },
    { ...duplicated.subQuestions[0], id: "sub-b", originalLabel: "（1）" },
  ];
  expect(() => intake.save({ examId, sectionId, content: duplicated, classification })).toThrow("小问号重复");
  expect(store.getExam(examId).questionCount).toBe(0);

  const first = content("2");
  first.subQuestions[0].originalLabel = "(1)";
  const second = content("3");
  second.subQuestions[0].originalLabel = "(1)";
  const a = saved(intake.save({ examId, sectionId, content: first, classification }));
  const b = saved(intake.save({ examId, sectionId, content: second, classification }));
  expect(a.questionId).not.toBe(b.questionId);
  expect(store.getExam(examId).questionCount).toBe(2);

  const edited = content("2");
  edited.subQuestions = [
    { ...edited.subQuestions[0], id: "sub-a", originalLabel: "(1)" },
    { ...edited.subQuestions[0], id: "sub-b", originalLabel: "(1)" },
  ];
  expect(() => intake.save({ examId, sectionId, questionId: a.questionId, content: edited, classification })).toThrow("小问号重复");
});

test("不同分部或不同考试的同号题不提示重复", () => {
  const { store, intake, examId, sectionId } = open();
  const otherSection = store.addSection(examId, "第二部分", "数学");
  const otherExam = importExam(store, "另一场考试");
  const a = saved(intake.save({ examId, sectionId, content: content("1"), classification }));
  const b = saved(intake.save({ examId, sectionId: otherSection.id, content: content("1"), classification }));
  const c = saved(intake.save({ examId: otherExam.examId, sectionId: otherExam.sectionId, content: content("1"), classification }));
  expect(new Set([a.questionId, b.questionId, c.questionId]).size).toBe(3);
  expect(store.getExam(examId).questionCount).toBe(2);
  expect(store.getExam(otherExam.examId).questionCount).toBe(1);
});

test("确认建立修订版：身份不变、版本加一、已审核状态回落，旧版本保留", () => {
  const { bank, intake, examId, sectionId } = open();
  const first = saved(intake.save({ examId, sectionId, content: content("1", "4"), classification, submit: true }));
  bank.setContentStatus(first.versionId, "approved");
  bank.setAnswerStatus(first.versionId, "approved");
  const originalStem = bank.getQuestionVersion(first.versionId)?.content.stem;
  const changed = content("1", "5");
  changed.stem = [{ type: "paragraph", runs: [{ type: "text", text: "修订后的题干", style: "普通" }] }];
  const prompt = intake.save({ examId, sectionId, content: changed, classification, submit: true });
  expect(prompt.saved).toBe(false);
  if (prompt.saved) throw new Error("预期提示重复题");
  const revised = saved(intake.save({ examId, sectionId, questionId: prompt.duplicate.questionId, content: changed, classification, submit: true }));
  expect(revised.questionId).toBe(first.questionId);
  expect(revised.version).toBe(2);
  expect(revised).toMatchObject({ contentStatus: "pending", answerStatus: "pending" });
  expect(bank.getQuestionVersion(first.versionId)?.content.stem).toEqual(originalStem);
  expect(bank.getLatestQuestionVersion(first.questionId)?.content.stem).toEqual(changed.stem);
});

test("录题草稿存于数据库，重开连接后仍可读出并继续编辑", () => {
  const { root, db, intake, examId, sectionId } = open();
  const draft = saved(intake.save({ examId, sectionId, content: content("1"), classification, submit: false }));
  db.close();
  const reopened = new Database(join(root, "paperweave.sqlite"));
  try {
    const bank = new QuestionBank(reopened);
    const latest = bank.getLatestQuestionVersion(draft.questionId);
    expect(latest).toMatchObject({ id: draft.versionId, version: 1, contentStatus: "draft" });
    const store = new ExamStore(reopened, root);
    expect(store.listQuestions(examId)).toMatchObject([{ questionId: draft.questionId, versionId: draft.versionId, contentStatus: "draft" }]);
  } finally {
    reopened.close();
  }
});

test("裁图按哈希写入附件目录，重复保存同一图片不复制，非图片被拒绝", () => {
  const root = temp("paperweave-attachments-");
  const attachments = new AttachmentStore(root);
  const url = `data:image/png;base64,${png.toString("base64")}`;
  const id = createHash("sha256").update(png).digest("hex");
  const first = attachments.saveDataUrl(url);
  expect(first.id).toBe(id);
  expect(first.url).toBe(url);
  expect(existsSync(join(root, "attachments", id))).toBe(true);
  expect(attachments.read(id).data.equals(png)).toBe(true);
  expect(attachments.saveDataUrl(url).id).toBe(id);
  expect(() => attachments.saveDataUrl(`data:text/plain;base64,${Buffer.from("文本").toString("base64")}`)).toThrow("图片");
  expect(() => attachments.saveDataUrl("data:image/png;base64,不是base64")).toThrow("图片");
});
