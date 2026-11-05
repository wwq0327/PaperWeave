import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Basket } from "../../src/main/basket";
import { Database } from "../../src/main/database";
import { Paper } from "../../src/main/paper";
import { QuestionBank } from "../../src/main/question-bank";
import { math, paragraph } from "../unit/fixtures/questions";

const entry = path.resolve(".vite/build/main.cjs");

async function closeApp(app: Awaited<ReturnType<typeof electron.launch>>) {
  await app.evaluate(({ app: electronApp }) => { electronApp.exit(0); }).catch(() => undefined);
  await app.close().catch(() => undefined);
}

/** 一份已审核题与材料，组卷成一份只有该题的试卷。 */
function seedPaper(dir: string): { questionId: string; materialId: string } {
  const db = new Database(path.join(dir, "paperweave.sqlite"));
  const bank = new QuestionBank(db);
  const material = bank.createMaterial({ title: "合成共享材料", content: [paragraph("材料正文第一版")], source: "自制样题" });
  bank.setMaterialStatus(material.id, "pending");
  bank.setMaterialStatus(material.id, "approved");
  const content = math();
  content.materials = [{ materialId: material.materialId, versionId: material.id }];
  content.subQuestions[1].materialIds = [material.materialId];
  const version = bank.createQuestion(content);
  bank.setClassification(version.questionId, {
    stage: "初中",
    subject: "数学",
    grade: "九年级",
    examType: "单元测",
    year: "2026",
    sourceName: "自制样题",
    questionType: "解答题",
    knowledgePoints: ["函数"],
  });
  bank.setContentStatus(version.id, "pending");
  bank.setContentStatus(version.id, "approved");
  bank.setAnswerStatus(version.id, "pending");
  bank.setAnswerStatus(version.id, "approved");

  const paper = new Paper(db);
  const created = paper.createPaper({ title: "更新提示卷", stage: "初中", subject: "数学", grade: "九年级" });
  const section = paper.addSection(created.id, "解答题");
  const basket = new Basket(db);
  const added = basket.addToBasket(version.questionId, version.id, null);
  if (added.status !== "added") throw new Error("整题入篮不应要求确认");
  paper.addBasketItem(created.id, section.id, added.item.id);
  db.close();
  return { questionId: version.questionId, materialId: material.materialId };
}

/** 题库新增已审核第 2 版与材料第 2 版；题目仍引用材料第 1 版。 */
function addNewVersions(dir: string, ids: { questionId: string; materialId: string }): void {
  const db = new Database(path.join(dir, "paperweave.sqlite"));
  const bank = new QuestionBank(db);
  const content = bank.getLatestQuestionVersion(ids.questionId)!.content;
  const next = structuredClone(content);
  next.subQuestions[1].prompt = [paragraph("新版第二问：求最小值。")];
  next.subQuestions[1].originalScore = 8;
  const version = bank.saveQuestionVersion(ids.questionId, next);
  bank.setContentStatus(version.id, "pending");
  bank.setContentStatus(version.id, "approved");
  bank.setAnswerStatus(version.id, "approved");
  const material = bank.saveMaterialVersion(ids.materialId, { title: "合成共享材料", content: [paragraph("材料正文第二版")], source: "自制样题" });
  bank.setMaterialStatus(material.id, "approved");
  db.close();
}

test("组卷草稿提示题目与材料新版本，教师确认后才切换版本", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "paperweave-updates-"));
  const ids = seedPaper(dir);
  const first = await electron.launch({ args: [entry, `--user-data-dir=${dir}`] });
  try {
    const page = await first.firstWindow();
    await page.getByRole("button", { name: "题库与组卷" }).click();
    const item = page.locator(".paper-item-edit");
    await expect(item).toContainText("求 f(1) 的值。");
    await expect(page.getByText(/题目有新版本/)).toHaveCount(0);
    await expect(page.getByText(/材料有新版本/)).toHaveCount(0);
  } finally {
    await closeApp(first);
  }

  addNewVersions(dir, ids);

  const second = await electron.launch({ args: [entry, `--user-data-dir=${dir}`] });
  try {
    const page = await second.firstWindow();
    await page.getByRole("button", { name: "题库与组卷" }).click();
    const item = page.locator(".paper-item-edit");
    await expect(item).toContainText("求 f(1) 的值。");
    await expect(item).toContainText("题目有新版本（第 2 版）");
    await expect(item).toContainText("材料有新版本，请到题库更新题目后重新加入");

    await item.getByRole("button", { name: "更新到最新版本" }).click();
    await expect(page.getByText("已更新到题库最新版本。", { exact: true })).toBeVisible();
    await expect(item).toContainText("新版第二问：求最小值。");
    await expect(item).toContainText("待调整");
    await expect(item).not.toContainText("题目有新版本");
    await expect(item).toContainText("材料有新版本，请到题库更新题目后重新加入");
  } finally {
    await closeApp(second);
    rmSync(dir, { recursive: true, force: true });
  }
});
