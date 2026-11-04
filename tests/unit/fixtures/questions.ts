import type { Block } from "../../../src/shared/document";
import type { QuestionContent } from "../../../src/shared/question";

export const paragraph = (text: string): Block => ({ type: "paragraph", runs: [{ type: "text", text, style: "普通" }] });

/** 二选一习作：两个候选各 30 分，选 1 篇，组总分 30。 */
export function exercise(): QuestionContent {
  return {
    stem: [paragraph("从下面两题中任选一题作文。")],
    subQuestions: [
      {
        id: "task-a",
        originalLabel: "题一",
        prompt: [paragraph("以“那一刻”为题写一篇记叙文。")],
        options: [],
        slots: [],
        answers: [],
        scoring: [{ id: "score-a", description: "符合题意，结构完整", score: 30, slotIds: [] }],
        dependsOn: [],
      },
      {
        id: "task-b",
        originalLabel: "题二",
        prompt: [paragraph("以“改变”为题写一篇记叙文。")],
        options: [],
        slots: [],
        answers: [],
        scoring: [{ id: "score-b", description: "符合题意，结构完整", score: 30, slotIds: [] }],
        dependsOn: [],
      },
    ],
    materials: [],
    selection: { mode: "choose", required: 1, candidates: ["task-a", "task-b"] },
    source: { section: "语文·写作", pdfPage: 8, originalNumber: "17" },
  };
}

/** 留言条：一个作答位置，格式 2 + 内容 2 + 表达 1 = 5 分。 */
export function note(): QuestionContent {
  return {
    stem: [paragraph("根据情境写一张留言条。")],
    subQuestions: [
      {
        id: "note-1",
        originalLabel: "(3)",
        prompt: [paragraph("同学不在家，请代写留言条说明还书一事。")],
        options: [],
        slots: [{ id: "note-slot", label: "留言条", kind: "text", required: true, interchangeableWith: [] }],
        answers: [{ slotId: "note-slot", blocks: [paragraph("示例答案")], variants: [] }],
        scoring: [
          { id: "format", description: "格式正确", score: 2, slotIds: ["note-slot"] },
          { id: "content", description: "内容完整", score: 2, slotIds: ["note-slot"] },
          { id: "express", description: "表达清楚", score: 1, slotIds: ["note-slot"] },
        ],
        dependsOn: [],
      },
    ],
    materials: [],
    selection: { mode: "all" },
    source: { section: "语文·积累运用", pdfPage: 4, originalNumber: "15" },
  };
}

/** 数学综合题：小问 (2) 依赖前问 (1)。 */
export function math(): QuestionContent {
  return {
    stem: [paragraph("已知函数 f(x) 满足给定条件。")],
    subQuestions: [
      {
        id: "part-1",
        originalLabel: "(1)",
        prompt: [paragraph("求 f(1) 的值。")],
        options: [],
        slots: [{ id: "p1-slot", label: "答案", kind: "text", required: true, interchangeableWith: [] }],
        answers: [{ slotId: "p1-slot", blocks: [paragraph("3")], variants: [] }],
        scoring: [{ id: "p1-score", description: "得出 f(1)=3", score: 4, slotIds: ["p1-slot"] }],
        dependsOn: [],
      },
      {
        id: "part-2",
        originalLabel: "(2)",
        prompt: [paragraph("利用第(1)问的结果，求最大值。")],
        options: [],
        slots: [],
        answers: [],
        scoring: [{ id: "p2-score", description: "得出最大值", score: 6, slotIds: [] }],
        dependsOn: ["part-1"],
      },
    ],
    materials: [],
    selection: { mode: "all" },
    source: { section: "数学·解答题", pdfPage: 7, originalNumber: "23" },
  };
}
