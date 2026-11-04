import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { Basket } from "../../../src/main/basket";
import { Database } from "../../../src/main/database";
import { Paper } from "../../../src/main/paper";
import { PaperFinalizer, PAPER_JOURNAL_KEY, recoverPaperFinalizations } from "../../../src/main/paper-finalization";
import { pdfPairPaths } from "../../../src/main/pdf-pair";
import { QuestionBank, type QuestionVersionRecord } from "../../../src/main/question-bank";
import { paperVolume, type VolumePaper } from "../../../src/shared/paper-layout";
import type { QuestionContent } from "../../../src/shared/question";
import { paragraph, referenceGroup } from "../fixtures/questions";
import { minimalPdf } from "../fixtures/pdf";

const directories: string[] = [];
function open() {
  const dir = mkdtempSync(join(tmpdir(), "paperweave-final-"));
  directories.push(dir);
  const db = new Database(join(dir, "题库.sqlite"));
  return { db, bank: new QuestionBank(db), basket: new Basket(db), paper: new Paper(db) };
}
function output() {
  const dir = mkdtempSync(join(tmpdir(), "paperweave-final-out-"));
  directories.push(dir);
  return dir;
}
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function approvedVersion(bank: QuestionBank, content: QuestionContent, options: { answerApproved?: boolean } = {}): QuestionVersionRecord {
  const versions = new Map<string, string>();
  const materialIds = new Map<string, string>();
  for (const ref of content.materials) {
    if (versions.has(ref.materialId)) continue;
    const material = bank.createMaterial({ title: `材料 ${ref.materialId}`, content: [paragraph("材料正文")], source: "自制样题" });
    bank.setMaterialStatus(material.id, "pending");
    bank.setMaterialStatus(material.id, "approved");
    versions.set(ref.materialId, material.id);
    materialIds.set(ref.materialId, material.materialId);
  }
  content.materials = content.materials.map((ref) => ({ materialId: materialIds.get(ref.materialId) as string, versionId: versions.get(ref.materialId) as string }));
  const remap = (blocks: QuestionContent["stem"]) => {
    for (const block of blocks) {
      if (block.type !== "paragraph") continue;
      for (const run of block.runs) {
        if (run.type === "reference" && run.kind === "material") run.targetId = materialIds.get(run.targetId) ?? run.targetId;
      }
    }
  };
  remap(content.stem);
  for (const sub of content.subQuestions) {
    sub.materialIds = sub.materialIds.map((id) => materialIds.get(id) ?? id);
    remap(sub.prompt);
    remap(sub.explanation);
    for (const option of sub.options) remap(option.content);
    for (const answer of sub.answers) remap(answer.blocks);
  }
  const version = bank.createQuestion(content);
  bank.setClassification(version.questionId, {
    stage: "初中",
    subject: "数学",
    grade: "九年级",
    examType: "期末",
    year: "2024",
    sourceName: "自制样题",
    questionType: "解答题",
    knowledgePoints: ["函数"],
  });
  bank.setContentStatus(version.id, "pending");
  bank.setContentStatus(version.id, "approved");
  bank.setAnswerStatus(version.id, "pending");
  if (options.answerApproved !== false) bank.setAnswerStatus(version.id, "approved");
  return version;
}

function addToPaper(paper: Paper, basket: Basket, version: QuestionVersionRecord, subQuestionId: string | null = null) {
  const created = paper.createPaper({ title: "九年级数学", stage: "初中", subject: "数学", grade: "九年级" });
  const section = paper.addSection(created.id, "一、解答题");
  const first = basket.addToBasket(version.questionId, version.id, subQuestionId);
  const result = first.status === "added" ? first : basket.addToBasket(version.questionId, version.id, subQuestionId, true);
  if (result.status !== "added") throw new Error("题篮加入失败");
  const item = paper.addBasketItem(created.id, section.id, result.item.id);
  return { created, section, item };
}

function fakeRenderer(calls: string[], onStudent?: (paper: VolumePaper) => void) {
  return async (volume: "student" | "teacher", paper: VolumePaper) => {
    calls.push(volume);
    if (volume === "student") onStudent?.(paper);
    const marker = volume === "teacher" ? "在 x=1 处取得最小值 结论正确" : "图 1";
    return minimalPdf(`${marker}\n${JSON.stringify({ volume, paper })}`);
  };
}

test("定稿生成两份不同 PDF，学生卷结构无答案，快照冻结且重印不重新渲染", async () => {
  const { db, bank, basket, paper } = open();
  const out = output();
  const version = approvedVersion(bank, referenceGroup());
  const { created, item } = addToPaper(paper, basket, version);
  expect(item.score).toBe(10);

  const calls: string[] = [];
  let studentPaper: VolumePaper | undefined;
  const finalizer = new PaperFinalizer(db, fakeRenderer(calls, (value) => { studentPaper = value; }));
  const check = finalizer.check(created.id);
  expect(check.blockers).toEqual([]);
  expect(check.ready).toBe(true);
  expect(check.references.filter((reference) => reference.label === null)).toEqual([]);

  const record = await finalizer.finalize(created.id, out);
  expect(calls).toEqual(["student", "teacher"]);
  const studentText = readFileSync(record.studentPdf).toString();
  const teacherText = readFileSync(record.teacherPdf).toString();
  expect(studentText).not.toContain("在 x=1 处取得最小值");
  expect(studentText).not.toContain('"answers"');
  expect(studentText).toContain("图 1");
  expect(teacherText).toContain("在 x=1 处取得最小值");
  expect(teacherText).toContain("结论正确");
  expect(studentText).not.toBe(teacherText);
  expect(JSON.stringify(studentPaper)).not.toContain("在 x=1 处取得最小值");
  expect(record.studentSha256).toBe(createHash("sha256").update(readFileSync(record.studentPdf)).digest("hex"));
  expect(record.teacherSha256).toBe(createHash("sha256").update(readFileSync(record.teacherPdf)).digest("hex"));
  expect(finalizer.listFinalizations(created.id)).toHaveLength(1);
  expect(db.getSetting(PAPER_JOURNAL_KEY)).toBe("[]");
  expect(record.snapshot.sections[0].items[0].number).toBe("1");
  expect(record.snapshot.materials.map((material) => material.label)).toEqual(["材料一", "材料二"]);

  const frozen = JSON.stringify(record.snapshot);
  bank.saveQuestionVersion(version.questionId, { ...version.content, stem: [paragraph("新版题干")] });
  const reprint = await finalizer.reprint(record.id);
  expect(reprint).toEqual({ studentPath: record.studentPdf, teacherPath: record.teacherPdf });
  expect(calls).toHaveLength(2);
  expect(JSON.stringify(finalizer.getFinalization(record.id).snapshot)).toBe(frozen);
});

test("定稿门槛：评分待调整、答案待确认、内嵌分值未确认都逐项阻断", async () => {
  const { db, bank, basket, paper } = open();
  const out = output();
  const version = approvedVersion(bank, referenceGroup());
  const { created, item } = addToPaper(paper, basket, version);
  const finalizer = new PaperFinalizer(db, fakeRenderer([]));

  paper.setItemScore(item.id, 4);
  let check = finalizer.check(created.id);
  expect(check.ready).toBe(false);
  expect(check.blockers).toContain("第 1 题：原评分不适用于当前分值，待调整");
  expect(check.blockers).toContain("第 1 题：卷内分值已改，图片中的旧分值需人工核对");
  await expect(finalizer.finalize(created.id, out)).rejects.toThrow("无法定稿");
  expect(finalizer.listFinalizations(created.id)).toEqual([]);
  const imageCheck = paper.getPaper(created.id).sections[0].items[0].pendingChecks;
  expect(imageCheck).toHaveLength(1);
  expect(imageCheck[0]).toMatchObject({ kind: "imageScore", confirmed: false });
  paper.confirmScoreConflict(item.id, imageCheck[0].key);

  paper.setItemScoring(item.id, {
    mode: "adjusted",
    points: [{ id: "p1", description: "按步给分", score: 4, slotIds: [] }],
  });
  expect(finalizer.check(created.id).ready).toBe(true);

  const gapVersion = approvedVersion(bank, referenceGroup(), { answerApproved: false });
  const gapPaper = addToPaper(paper, basket, gapVersion);
  check = finalizer.check(gapPaper.created.id);
  expect(check.ready).toBe(false);
  expect(check.blockers.some((blocker) => blocker.includes("答案或评分尚未齐全，需教师确认后出卷"))).toBe(true);
  check = finalizer.check(gapPaper.created.id, { confirmAnswerGap: true });
  expect(check.ready).toBe(true);
  expect(check.notices.some((notice) => notice.includes("答案或评分尚未齐全"))).toBe(true);
  const teacherVolume = paperVolume(check.snapshot, "teacher");
  const studentVolume = paperVolume(check.snapshot, "student");
  expect(teacherVolume.sections[0].items[0].answerGap).toBe(true);
  expect("answerGap" in studentVolume.sections[0].items[0]).toBe(false);

  const conflictContent = referenceGroup();
  conflictContent.subQuestions[0].prompt.push(paragraph("（4 分）"));
  const conflictVersion = approvedVersion(bank, conflictContent);
  const conflictPaper = addToPaper(paper, basket, conflictVersion);
  const conflictCheck = finalizer.check(conflictPaper.created.id);
  expect(conflictCheck.ready).toBe(false);
  expect(conflictCheck.blockers).toContain("第 1 题：内嵌分值「4 分」尚未确认");
  expect(conflictPaper.item.scoreConflicts).toHaveLength(1);
  paper.confirmScoreConflict(conflictPaper.item.id, conflictPaper.item.scoreConflicts[0].key);
  expect(finalizer.check(conflictPaper.created.id).ready).toBe(true);
});

test("文字引用未结构化时逐项阻断，确认后才可定稿", () => {
  const { db, bank, basket, paper } = open();
  const content = referenceGroup();
  content.subQuestions[0].prompt.push(paragraph("结合第(1)问与图 1 作答。"));
  const version = approvedVersion(bank, content);
  const { created } = addToPaper(paper, basket, version);
  const finalizer = new PaperFinalizer(db, fakeRenderer([]));

  const check = finalizer.check(created.id);
  expect(check.ready).toBe(false);
  expect(check.blockers).toContain("第 1 题：文字引用「第(1)问」未结构化，需确认");
  expect(check.blockers).toContain("第 1 题：文字引用「图 1」未结构化，需确认");

  const item = paper.getPaper(created.id).sections[0].items[0];
  for (const pending of item.pendingChecks) paper.confirmScoreConflict(item.id, pending.key);
  expect(finalizer.check(created.id).ready).toBe(true);
});

test("引用目标不在本卷时列出题号与原卷页并阻断定稿", () => {
  const { db, bank, basket, paper } = open();
  const content = referenceGroup();
  content.stem = [];
  for (const sub of content.subQuestions) sub.dependsOn = [];
  const version = approvedVersion(bank, content);
  const { created } = addToPaper(paper, basket, version, "ref-2");
  const check = new PaperFinalizer(db, fakeRenderer([])).check(created.id);
  expect(check.ready).toBe(false);
  const unresolved = check.references.filter((reference) => reference.label === null);
  expect(unresolved).toHaveLength(1);
  expect(unresolved[0]).toMatchObject({ kind: "subQuestion", targetId: "ref-1", reason: "目标小问未加入本卷" });
  expect(check.blockers.some((blocker) => blocker.includes("第 1 题（原卷第 9 页 题 24）") && blocker.includes("小问引用无法解析"))).toBe(true);
});

test("空试卷与中断恢复：清理无记录完成目录，保留有效定稿与非预期目录", async () => {
  const { db, bank, basket, paper } = open();
  const out = output();
  const empty = paper.createPaper({ title: "空卷", stage: "初中", subject: "数学", grade: "九年级" });
  paper.addSection(empty.id, "一、解答题");
  const finalizer = new PaperFinalizer(db, fakeRenderer([]));
  expect(finalizer.check(empty.id).blockers).toContain("试卷没有题目");

  const version = approvedVersion(bank, referenceGroup());
  const { created } = addToPaper(paper, basket, version);
  const record = await finalizer.finalize(created.id, out);

  const orphan = randomUUID();
  const orphanPaths = pdfPairPaths(out, orphan);
  mkdirSync(orphanPaths.result);
  writeFileSync(join(orphanPaths.result, "学生卷.pdf"), "%PDF-1");
  writeFileSync(join(orphanPaths.result, "教师答案卷.pdf"), "%PDF-1");

  const pendingId = randomUUID();
  const pendingPaths = pdfPairPaths(out, pendingId);
  mkdirSync(pendingPaths.pending);
  writeFileSync(join(pendingPaths.pending, "学生卷.pdf"), "%PDF-1");
  mkdirSync(pendingPaths.preview, { recursive: true });
  writeFileSync(join(pendingPaths.preview, "学生卷.pdf"), "%PDF-1");
  writeFileSync(join(pendingPaths.preview, "教师答案卷.pdf"), "%PDF-1");

  const unusual = randomUUID();
  const unusualPaths = pdfPairPaths(out, unusual);
  mkdirSync(unusualPaths.result);
  writeFileSync(join(unusualPaths.result, "学生卷.pdf"), "%PDF-1");
  writeFileSync(join(unusualPaths.result, "教师答案卷.pdf"), "%PDF-1");
  writeFileSync(join(unusualPaths.result, "其他.txt"), "保留");

  db.setSetting(PAPER_JOURNAL_KEY, JSON.stringify([
    { id: record.id, parent: out },
    { id: orphan, parent: out },
    { id: pendingId, parent: out },
    { id: unusual, parent: out },
  ]));
  const recovered = await recoverPaperFinalizations(db);
  expect(recovered.kept.map((operation) => operation.id)).toEqual([unusual]);
  expect(recovered.cleared.sort()).toEqual([record.id, orphan, pendingId].sort());
  expect(existsSync(join(out, `拾题成卷-样张-${record.id}`))).toBe(true);
  expect(existsSync(orphanPaths.result)).toBe(false);
  expect(existsSync(pendingPaths.pending)).toBe(false);
  expect(existsSync(pendingPaths.preview)).toBe(false);
  expect(existsSync(unusualPaths.result)).toBe(true);
  expect(JSON.parse(db.getSetting(PAPER_JOURNAL_KEY) ?? "[]")).toEqual([{ id: unusual, parent: out }]);
});
