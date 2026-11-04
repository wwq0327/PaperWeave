import { randomUUID } from "node:crypto";
import { basketSelection, type BasketSelection } from "../shared/basket";
import type { QuestionContent } from "../shared/question";
import type { Database } from "./database";
import { QuestionBank } from "./question-bank";

export interface BasketItem {
  id: string;
  questionId: string;
  questionVersionId: string;
  version: number;
  subQuestionIds: string[];
  primarySubQuestionId: string | null;
  position: number;
  createdAt: string;
}

export interface BasketItemRecord extends BasketItem {
  content: QuestionContent;
  dependencies: BasketSelection;
}

export type BasketAddResult =
  | { status: "confirmation_required"; selection: BasketSelection }
  | { status: "added"; item: BasketItem };

interface BasketRow {
  id: string;
  question_id: string;
  question_version_id: string;
  sub_question_ids: string;
  primary_sub_question_id: string | null;
  position: number;
  created_at: string;
  version: number;
}

/** 单一当前题篮；保存题目版本快照，不随题库新版自动切换。 */
export class Basket {
  private readonly bank: QuestionBank;

  constructor(private readonly db: Database) {
    this.bank = new QuestionBank(db);
  }

  addToBasket(questionId: string, questionVersionId: string, subQuestionId: string | null, confirmDependencies = false): BasketAddResult {
    const version = this.bank.getQuestionVersion(questionVersionId);
    if (version === undefined) throw new Error("题目版本不存在");
    if (version.questionId !== questionId) throw new Error("题目版本不属于该题");
    const selection = basketSelection(version.content, subQuestionId);
    const requiresConfirmation = subQuestionId !== null
      && (selection.subQuestionIds.length > 1 || selection.materialIds.length > 0);
    if (requiresConfirmation && !confirmDependencies) return { status: "confirmation_required", selection };
    return this.db.transaction((sqlite) => {
      const rows = sqlite.prepare("SELECT question_version_id, sub_question_ids FROM basket_items").all() as { question_version_id: string; sub_question_ids: string }[];
      for (const row of rows) {
        if (row.question_version_id !== questionVersionId) continue;
        const existing = JSON.parse(row.sub_question_ids) as string[];
        if (existing.some((id) => selection.subQuestionIds.includes(id))) throw new Error("已在题篮");
      }
      const next = sqlite.prepare("SELECT COALESCE(MAX(position), 0) + 1 AS position FROM basket_items").get() as { position: number };
      const item: BasketItem = {
        id: randomUUID(),
        questionId,
        questionVersionId,
        version: version.version,
        subQuestionIds: selection.subQuestionIds,
        primarySubQuestionId: subQuestionId,
        position: next.position,
        createdAt: new Date().toISOString(),
      };
      sqlite.prepare("INSERT INTO basket_items (id, question_id, question_version_id, sub_question_ids, primary_sub_question_id, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(item.id, item.questionId, item.questionVersionId, JSON.stringify(item.subQuestionIds), item.primarySubQuestionId, item.position, item.createdAt);
      return { status: "added" as const, item };
    });
  }

  removeBasketItem(id: string): void {
    this.db.transaction((sqlite) => {
      const removed = sqlite.prepare("DELETE FROM basket_items WHERE id = ?").run(id);
      if (removed.changes === 0) throw new Error("题篮项不存在");
    });
  }

  listBasket(): BasketItemRecord[] {
    return this.db.read((sqlite) => {
      const rows = sqlite.prepare("SELECT * FROM basket_items ORDER BY position, id").all() as unknown as BasketRow[];
      return rows.map((row) => {
        const version = this.bank.getQuestionVersion(row.question_version_id);
        if (version === undefined) throw new Error("题篮数据损坏");
        return {
          id: row.id,
          questionId: row.question_id,
          questionVersionId: row.question_version_id,
          version: version.version,
          subQuestionIds: JSON.parse(row.sub_question_ids) as string[],
          primarySubQuestionId: row.primary_sub_question_id,
          position: row.position,
          createdAt: row.created_at,
          content: version.content,
          dependencies: basketSelection(version.content, row.primary_sub_question_id),
        };
      });
    });
  }

  clearBasket(): void {
    this.db.transaction((sqlite) => { sqlite.prepare("DELETE FROM basket_items").run(); });
  }
}
