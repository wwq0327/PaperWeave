import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { Basket } from "../../../src/main/basket";
import { Database } from "../../../src/main/database";
import { QuestionBank } from "../../../src/main/question-bank";
import type { QuestionContent } from "../../../src/shared/question";
import { math, note } from "../fixtures/questions";

const directories: string[] = [];
function open() {
  const dir = mkdtempSync(join(tmpdir(), "paperweave-basket-"));
  directories.push(dir);
  const path = join(dir, "题库.sqlite");
  const db = new Database(path);
  return { db, bank: new QuestionBank(db), basket: new Basket(db), path };
}
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function independent(): QuestionContent {
  const content = note();
  content.stem = [];
  return content;
}

test("独立小问直接入篮，列出题目版本与小问集合", () => {
  const { bank, basket } = open();
  const created = bank.createQuestion(independent());
  const result = basket.addToBasket(created.questionId, created.id, "note-1");
  expect(result.status).toBe("added");
  const items = basket.listBasket();
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({
    questionId: created.questionId,
    questionVersionId: created.id,
    version: 1,
    subQuestionIds: ["note-1"],
    primarySubQuestionId: "note-1",
    position: 1,
  });
  expect(items[0].dependencies.reasons).toEqual(["独立小问"]);
});

test("有前问依赖时先返回报告，确认后才写入", () => {
  const { bank, basket } = open();
  const content = math();
  content.stem = [];
  const created = bank.createQuestion(content);
  const report = basket.addToBasket(created.questionId, created.id, "part-2");
  expect(report).toEqual({
    status: "confirmation_required",
    selection: {
      subQuestionIds: ["part-1", "part-2"],
      materialIds: [],
      wholeGroup: false,
      reasons: ["直接前问：part-1"],
    },
  });
  expect(basket.listBasket()).toEqual([]);

  const added = basket.addToBasket(created.questionId, created.id, "part-2", true);
  expect(added.status).toBe("added");
  if (added.status !== "added") throw new Error("应已加入");
  expect(added.item.subQuestionIds).toEqual(["part-1", "part-2"]);
  expect(basket.listBasket()).toHaveLength(1);
});

test("重复加入或小问被覆盖时拒绝，不产生重复行", () => {
  const { bank, basket } = open();
  const content = math();
  content.stem = [];
  const created = bank.createQuestion(content);
  basket.addToBasket(created.questionId, created.id, "part-2", true);
  expect(() => basket.addToBasket(created.questionId, created.id, "part-2", true)).toThrow("已在题篮");
  expect(() => basket.addToBasket(created.questionId, created.id, "part-1", true)).toThrow("已在题篮");
  expect(basket.listBasket()).toHaveLength(1);
});

test("移除单项与清空题篮", () => {
  const { bank, basket } = open();
  const first = bank.createQuestion(independent());
  const second = bank.createQuestion(independent());
  const a = basket.addToBasket(first.questionId, first.id, "note-1");
  const b = basket.addToBasket(second.questionId, second.id, "note-1");
  if (a.status !== "added" || b.status !== "added") throw new Error("应已加入");
  expect(basket.listBasket().map((item) => item.id)).toEqual([a.item.id, b.item.id]);

  basket.removeBasketItem(a.item.id);
  expect(basket.listBasket().map((item) => item.id)).toEqual([b.item.id]);

  basket.clearBasket();
  expect(basket.listBasket()).toEqual([]);
});

test("拒绝不存在或不属于该题的版本", () => {
  const { bank, basket } = open();
  const first = bank.createQuestion(independent());
  const second = bank.createQuestion(independent());
  expect(() => basket.addToBasket(first.questionId, "missing-version", "note-1")).toThrow("题目版本不存在");
  expect(() => basket.addToBasket(first.questionId, second.id, "note-1")).toThrow("题目版本不属于该题");
});

test("题篮固定题目版本，不随题库新版自动切换", () => {
  const { bank, basket } = open();
  const created = bank.createQuestion(independent());
  basket.addToBasket(created.questionId, created.id, "note-1");
  bank.saveQuestionVersion(created.questionId, independent());
  const [item] = basket.listBasket();
  expect(item.questionVersionId).toBe(created.id);
  expect(item.version).toBe(1);
});
