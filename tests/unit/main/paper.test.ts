import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { Basket } from "../../../src/main/basket";
import { Database } from "../../../src/main/database";
import { Paper } from "../../../src/main/paper";
import { QuestionBank, type QuestionVersionRecord } from "../../../src/main/question-bank";
import type { QuestionContent } from "../../../src/shared/question";
import { exercise, math, note, paragraph } from "../fixtures/questions";

const directories: string[] = [];
function open() {
  const dir = mkdtempSync(join(tmpdir(), "paperweave-paper-"));
  directories.push(dir);
  const db = new Database(join(dir, "题库.sqlite"));
  return { db, bank: new QuestionBank(db), basket: new Basket(db), paper: new Paper(db) };
}
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function classified(subject = "数学") {
  return {
    stage: "初中",
    subject,
    grade: "九年级",
    examType: "期末",
    year: "2024",
    sourceName: "自制样题",
    questionType: "解答题",
    knowledgePoints: ["函数"],
  };
}

function addQuestion(bank: QuestionBank, content: QuestionContent, subject = "数学"): QuestionVersionRecord {
  const version = bank.createQuestion(content);
  bank.setClassification(version.questionId, classified(subject));
  return version;
}

function addWhole(basket: Basket, version: QuestionVersionRecord) {
  const result = basket.addToBasket(version.questionId, version.id, null);
  if (result.status !== "added") throw new Error("整题加入不应要求确认");
  return result.item;
}

function addSub(basket: Basket, version: QuestionVersionRecord, subQuestionId: string) {
  const result = basket.addToBasket(version.questionId, version.id, subQuestionId);
  if (result.status !== "added") throw new Error("独立小问加入不应要求确认");
  return result.item;
}

function independentMath(): QuestionContent {
  const content = math();
  content.stem = [];
  for (const sub of content.subQuestions) sub.dependsOn = [];
  return content;
}

test("创建单科试卷与小节；题目按小节与位置排序，跨学科加入被拒绝", () => {
  const { bank, basket, paper } = open();
  const created = paper.createPaper({ title: "九年级数学期末", stage: "初中", subject: "数学", grade: "九年级" });
  expect(created).toMatchObject({ title: "九年级数学期末", stage: "初中", subject: "数学", grade: "九年级" });

  const mathVersion = addQuestion(bank, math());
  const mathItem = addWhole(basket, mathVersion);
  const chineseVersion = addQuestion(bank, note(), "语文");
  const chineseItem = addWhole(basket, chineseVersion);

  const first = paper.addSection(created.id, "一、选择题");
  const second = paper.addSection(created.id, "二、解答题");
  expect([first.position, second.position]).toEqual([1, 2]);

  const added = paper.addBasketItem(created.id, second.id, mathItem.id);
  expect(added).toMatchObject({
    paperId: created.id,
    sectionId: second.id,
    position: 1,
    questionId: mathVersion.questionId,
    questionVersionId: mathVersion.id,
    score: 10,
    defaultScore: 10,
    blankSpace: "medium",
    scoring: { mode: "original" },
    scoringState: "original",
  });

  expect(() => paper.addBasketItem(created.id, first.id, chineseItem.id)).toThrow("题目学科与试卷不一致");

  const detail = paper.getPaper(created.id);
  expect(detail.sections.map((section) => section.title)).toEqual(["一、选择题", "二、解答题"]);
  expect(detail.sections[0].items).toEqual([]);
  expect(detail.sections[1].items.map((item) => item.id)).toEqual([added.id]);
  expect(detail.totalScore).toBe(10);
});

test("缺少分类的题目不能加入试卷", () => {
  const { bank, basket, paper } = open();
  const created = paper.createPaper({ title: "数学卷", stage: "初中", subject: "数学", grade: "九年级" });
  const section = paper.addSection(created.id, "解答题");
  const version = bank.createQuestion(math());
  const item = addWhole(basket, version);
  expect(() => paper.addBasketItem(created.id, section.id, item.id)).toThrow("题目缺少分类");
});

test("默认分值：整题取组选答总分，小问集合取原分值合计，缺分值时拒绝", () => {
  const { bank, basket, paper } = open();
  const chinesePaper = paper.createPaper({ title: "语文卷", stage: "初中", subject: "语文", grade: "九年级" });
  const chineseSection = paper.addSection(chinesePaper.id, "写作");
  const exerciseVersion = addQuestion(bank, exercise(), "语文");
  const exerciseItem = addWhole(basket, exerciseVersion);
  expect(paper.addBasketItem(chinesePaper.id, chineseSection.id, exerciseItem.id).score).toBe(30);

  const mathPaper = paper.createPaper({ title: "数学卷", stage: "初中", subject: "数学", grade: "九年级" });
  const mathSection = paper.addSection(mathPaper.id, "解答题");
  const content = independentMath();
  const version = addQuestion(bank, content);
  const subset = addSub(basket, version, "part-2");
  expect(paper.addBasketItem(mathPaper.id, mathSection.id, subset.id).score).toBe(6);

  const missing = independentMath();
  missing.subQuestions[1].originalScore = null;
  const missingVersion = addQuestion(bank, missing);
  const missingSubset = addSub(basket, missingVersion, "part-2");
  expect(() => paper.addBasketItem(mathPaper.id, mathSection.id, missingSubset.id)).toThrow("请填写卷内分值");
  const filled = paper.addBasketItem(mathPaper.id, mathSection.id, missingSubset.id, 7);
  expect(filled).toMatchObject({ score: 7, scoringState: "needsAdjustment" });
});

test("组选答候选分值不同时可由教师填写卷内分值入卷并标记待调整", () => {
  const { bank, basket, paper } = open();
  const created = paper.createPaper({ title: "语文卷", stage: "初中", subject: "语文", grade: "九年级" });
  const section = paper.addSection(created.id, "写作");
  const content = exercise();
  content.subQuestions[1].originalScore = 20;
  const version = addQuestion(bank, content, "语文");
  const item = addWhole(basket, version);
  expect(() => paper.addBasketItem(created.id, section.id, item.id)).toThrow("请填写卷内分值");
  const filled = paper.addBasketItem(created.id, section.id, item.id, 25);
  expect(filled).toMatchObject({ score: 25, scoringState: "needsAdjustment" });
});

test("卷内改分进入 needsAdjustment，调整评分点或只输出答案后解除", () => {
  const { bank, basket, paper } = open();
  const created = paper.createPaper({ title: "数学卷", stage: "初中", subject: "数学", grade: "九年级" });
  const section = paper.addSection(created.id, "解答题");
  const version = addQuestion(bank, independentMath());
  const item = paper.addBasketItem(created.id, section.id, addSub(basket, version, "part-2").id);
  expect(item.scoringState).toBe("original");

  const changed = paper.setItemScore(item.id, 4);
  expect(changed).toMatchObject({ score: 4, scoringState: "needsAdjustment", scoring: { mode: "original" } });
  expect(() => paper.setItemScoring(item.id, {
    mode: "adjusted",
    points: [{ id: "p1", description: "按步给分", score: 5, slotIds: [] }],
  })).toThrow("评分点合计与卷内分值不一致");

  const adjusted = paper.setItemScoring(item.id, {
    mode: "adjusted",
    points: [
      { id: "p1", description: "列出关系", score: 2, slotIds: [] },
      { id: "p2", description: "得出结论", score: 2, slotIds: [] },
    ],
  });
  expect(adjusted.scoringState).toBe("adjusted");

  expect(paper.setItemScore(item.id, 6).scoringState).toBe("original");

  paper.setItemScore(item.id, 4);
  const answerOnly = paper.setItemScoring(item.id, { mode: "answerOnly", note: "评分标准待补" });
  expect(answerOnly.scoringState).toBe("answerOnly");
});

test("内嵌旧分值列为冲突，逐项确认后才标记已确认", () => {
  const { bank, basket, paper } = open();
  const created = paper.createPaper({ title: "数学卷", stage: "初中", subject: "数学", grade: "九年级" });
  const section = paper.addSection(created.id, "解答题");
  const content = independentMath();
  content.subQuestions[1].prompt = [paragraph("利用第(1)问的结果，求最大值。（6 分）")];
  const version = addQuestion(bank, content);
  const item = paper.addBasketItem(created.id, section.id, addSub(basket, version, "part-2").id);
  expect(item.scoreConflicts).toEqual([]);

  paper.setItemScore(item.id, 4);
  const conflict = { subQuestionId: "part-2", value: 6, text: "6 分", key: "part-2|6|6 分", confirmed: false };
  expect(paper.getPaper(created.id).sections[0].items[0].scoreConflicts).toEqual([conflict]);

  expect(() => paper.confirmScoreConflict(item.id, "part-2|6|8 分")).toThrow("分值冲突不存在");
  const confirmed = paper.confirmScoreConflict(item.id, conflict.key);
  expect(confirmed.scoreConflicts).toEqual([{ ...conflict, confirmed: true }]);
  expect(paper.getPaper(created.id).sections[0].items[0].scoreConflicts).toEqual([{ ...conflict, confirmed: true }]);
});

test("卷内留白可调，未知档位被拒绝", () => {
  const { bank, basket, paper } = open();
  const created = paper.createPaper({ title: "数学卷", stage: "初中", subject: "数学", grade: "九年级" });
  const section = paper.addSection(created.id, "解答题");
  const version = addQuestion(bank, math());
  const item = paper.addBasketItem(created.id, section.id, addWhole(basket, version).id);
  expect(paper.setItemBlankSpace(item.id, "large").blankSpace).toBe("large");
  expect(() => paper.setItemBlankSpace(item.id, "huge" as never)).toThrow("留白档位无效");
});

test("题目顺序稳定、跨小节移动与删除后重新编号，总分随卷内分值更新", () => {
  const { bank, basket, paper } = open();
  const created = paper.createPaper({ title: "数学卷", stage: "初中", subject: "数学", grade: "九年级" });
  const first = paper.addSection(created.id, "一、基础题");
  const second = paper.addSection(created.id, "二、综合题");
  const mathVersion = addQuestion(bank, math());
  const noteVersion = addQuestion(bank, note());
  const thirdVersion = addQuestion(bank, exercise(), "数学");

  const a = paper.addBasketItem(created.id, first.id, addWhole(basket, mathVersion).id);
  const b = paper.addBasketItem(created.id, first.id, addWhole(basket, noteVersion).id);
  const c = paper.addBasketItem(created.id, second.id, addWhole(basket, thirdVersion).id);
  const originalContent = JSON.stringify(bank.getQuestionVersion(mathVersion.id)?.content);

  paper.moveItem(c.id, first.id, 1);
  let detail = paper.getPaper(created.id);
  expect(detail.sections[0].items.map((item) => item.id)).toEqual([c.id, a.id, b.id]);
  expect(detail.sections[0].items.map((item) => item.position)).toEqual([1, 2, 3]);
  expect(detail.sections[1].items).toEqual([]);
  expect(detail.totalScore).toBe(10 + 5 + 30);

  paper.setItemScore(a.id, 8);
  expect(paper.getPaper(created.id).totalScore).toBe(8 + 5 + 30);

  paper.removeItem(b.id);
  detail = paper.getPaper(created.id);
  expect(detail.sections[0].items.map((item) => item.id)).toEqual([c.id, a.id]);
  expect(detail.sections[0].items.map((item) => item.position)).toEqual([1, 2]);
  expect(() => paper.removeSection(first.id)).toThrow("小节内仍有题目，不能删除");
  paper.removeSection(second.id);
  expect(paper.getPaper(created.id).sections.map((section) => section.id)).toEqual([first.id]);

  expect(JSON.stringify(bank.getQuestionVersion(mathVersion.id)?.content)).toBe(originalContent);
});
