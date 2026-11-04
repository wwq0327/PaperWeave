import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { AttachmentStore } from "../../../src/main/attachments";
import { Database } from "../../../src/main/database";
import { ImportStore } from "../../../src/main/import-store";
import { QuestionBank } from "../../../src/main/question-bank";
import type { QuestionBlock } from "../../../src/shared/question";

const directories: string[] = [];
function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  directories.push(dir);
  return dir;
}
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

const frontmatter = (id: string, type: string, extra = "") => `---
题目编号: ${id}
学段: 初中
年级: 九年级
题型: ${type}
板块: 数与式
来源: 自制样题
年份: 2024
审核状态: 已入库
知识点一级: 数与式
知识点二级: 整式运算
核心素养:
  - 运算能力
${extra}---
`;

function makeMathVault(compliant = false): { root: string; wiki: string } {
  const root = temp("paperweave-mathvault-");
  const wiki = join(root, "wiki");
  mkdirSync(join(wiki, "计算题"), { recursive: true });
  mkdirSync(join(wiki, "综合题"), { recursive: true });
  mkdirSync(join(wiki, "by-year"), { recursive: true });
  mkdirSync(join(wiki, "images"), { recursive: true });
  writeFileSync(join(wiki, "images", "math-fig.png"), png);
  writeFileSync(join(wiki, "计算题", "M2024-TEST-019.md"), `${frontmatter("M2024-TEST-019", "计算题", "配图:\n  - images/math-fig.png\n")}
## 题目正文

1. 计算 $x^2+1$ 的值。（5分）

## 答案

$2$
`);
  writeFileSync(join(wiki, "by-year", "M2024-TEST-019.md"), `${frontmatter("M2024-TEST-019", "计算题")}
## 题目正文

旧副本内容，不应被扫描选中。
`);
  const proofreadBody = compliant
    ? "1. 合成第 25 题。\n\n（1）求值。（3分）\n\n（2）在直线 KD 被排除的条件下作图。（4分）\n\n（3）探究乘积是否为定值，并说明理由。（5分）\n"
    : "1. 合成第 25 题。\n\n（1）求值。（3分）\n\n（2）说明理由。（4分）\n\n（3）直接证明结论。（5分）\n";
  writeFileSync(join(wiki, "综合题", "M2023-NCZK-025.md"), `${frontmatter("M2023-NCZK-025", "综合题")}
## 题目正文

${proofreadBody}
## 答案

合成答案。
`);
  return { root, wiki };
}

function open() {
  const data = temp("paperweave-mathvault-data-");
  const db = new Database(join(data, "paperweave.sqlite"));
  const attachments = new AttachmentStore(data);
  const store = new ImportStore(db, attachments);
  return { db, attachments, store, bank: new QuestionBank(db) };
}

test("扫描 mathVault：按文件名去重、分类、公式、配图与原分值", () => {
  const { store } = open();
  const { root } = makeMathVault();
  const scan = store.scan("mathvault", root);
  expect(scan.rows).toHaveLength(2);
  const normal = scan.rows.find((row) => row.sourceKey === "mathvault:M2024-TEST-019");
  expect(normal).toMatchObject({ status: "importable", section: "数与式", pdfPage: 1, originalNumber: "1" });
  expect(normal?.classification).toMatchObject({ stage: "初中", subject: "数学", grade: "九年级", questionType: "计算题", sourceName: "自制样题", year: "2024" });
  expect(normal?.classification.knowledgePoints).toEqual(expect.arrayContaining(["数与式", "整式运算", "运算能力"]));
  expect(normal?.preview).toContain("计算");
  expect(normal?.preview).not.toContain("旧副本");
  const sub = normal?.incoming?.subQuestions[0];
  expect(sub?.originalScore).toBe(5);
  expect(JSON.stringify(sub?.prompt)).toContain("\"latex\":\"x^2+1\"");
  expect(sub?.prompt.some((block) => block.type === "image")).toBe(true);
  expect(scan.rows.find((row) => row.sourceKey === "mathvault:M2023-NCZK-025")?.needsProofread).toBe(true);
});

test("导入 mathVault：公式与图可读取，默认待核", () => {
  const { store, bank, attachments } = open();
  const { root } = makeMathVault();
  const scan = store.scan("mathvault", root);
  const result = store.apply({ scanId: scan.scanId, rows: [{ sourceKey: "mathvault:M2024-TEST-019", action: "import" }] });
  expect(result.imported).toBe(1);
  const found = bank.searchQuestions({ keyword: "计算" });
  expect(found[0]).toMatchObject({ contentStatus: "pending", answerStatus: "pending", source: { section: "数与式", originalNumber: "1" } });
  const content = bank.getQuestionVersion(found[0].versionId)!.content;
  const image = content.subQuestions[0].prompt.find((block): block is Extract<QuestionBlock, { type: "image" }> => block.type === "image")!;
  expect(attachments.read(image.id).data.equals(png)).toBe(true);
});

test("第 25 题未满足校勘条件时需显式确认，记录保留校勘说明", () => {
  const { db, store, bank } = open();
  const { root } = makeMathVault();
  const scan = store.scan("mathvault", root);
  const row = scan.rows.find((entry) => entry.sourceKey === "mathvault:M2023-NCZK-025")!;
  expect(row.status).toBe("importable");
  expect(row.needsProofread).toBe(true);
  expect(row.reasons.join("；")).toContain("待校勘");
  expect(() => store.apply({ scanId: scan.scanId, rows: [{ sourceKey: row.sourceKey, action: "import" }] })).toThrow("待校勘");
  const applied = store.apply({ scanId: scan.scanId, rows: [{ sourceKey: row.sourceKey, action: "import", acknowledgeProofread: true }] });
  expect(applied.imported).toBe(1);
  const found = bank.searchQuestions({ keyword: "合成第 25 题" });
  expect(found).toHaveLength(1);
  const record = bank.getQuestionVersion(found[0].versionId);
  expect(record?.content.subQuestions).toHaveLength(3);
  expect(store.history()[0].summary.imported).toBe(1);
  const recordRow = db.read((sqlite) => sqlite.prepare("SELECT detail FROM import_records WHERE kind = 'mathvault' AND source_key = ?").get(row.sourceKey) as { detail: string });
  expect(JSON.parse(recordRow.detail).proofread).toBe("acknowledged");
  expect(store.scan("mathvault", root).rows.find((entry) => entry.sourceKey === row.sourceKey)?.status).toBe("duplicate");
});

test("第 25 题满足排除条件与探究设问时不标待校勘", () => {
  const { store } = open();
  const { root } = makeMathVault(true);
  const scan = store.scan("mathvault", root);
  const row = scan.rows.find((entry) => entry.sourceKey === "mathvault:M2023-NCZK-025")!;
  expect(row.needsProofread).toBe(false);
  expect(row.reasons.join("；")).not.toContain("待校勘");
});
