import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { AttachmentStore } from "../../../src/main/attachments";
import { Database } from "../../../src/main/database";
import { ImportStore } from "../../../src/main/import-store";
import { QuestionBank } from "../../../src/main/question-bank";
import { hasContent } from "../../../src/shared/question";

const directories: string[] = [];
function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  directories.push(dir);
  return dir;
}
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

function questionFile(overrides: { image?: string | null; passage?: string; body?: string; answer?: string; questionType?: string } = {}): string {
  const passageLink = overrides.passage === undefined ? "  - \"[[R2024-TEST-01]]\"" : overrides.passage === "" ? " []" : `  - "[[${overrides.passage}]]"`;
  const imageLine = overrides.image === null ? "" : `![合成示意图](../../images/${overrides.image ?? "fig.png"})\n\n`;
  return `---
题目编号: Q2024-TEST-002
题型: ${overrides.questionType ?? "阅读理解"}
板块: 文学类文本
来源: 自制样题
年份: 2024
审核状态: 已入库
知识点一级: 文学类文本
知识点二级: 小说阅读
关联Passage:
${passageLink}
tags: [合成, 阅读]
---

## 题目正文

${overrides.body ?? "阅读下面的合成材料，完成下面小题。"}

${imageLine}（1）合成第一问。（4分）

（2）合成第二问。（6分）

## 答案

${overrides.answer ?? "（1）合成答案一。\n\n（2）合成答案二。"}

## 解析

（1）合成解析一。

（2）合成解析二。
`;
}

function choiceFile(): string {
  return `---
题目编号: Q2023-TEST-001
题型: 选择题
板块: 积累与运用
来源: 自制样题
年份: 2023
审核状态: 待入库
知识点一级: 字音
---

## 题目正文

1. 合成选择题。

A. 甲选项
B. 乙选项
C. 丙选项
D. 丁选项

## 答案

B
`;
}

function makeTiku(): { root: string; wiki: string } {
  const root = temp("paperweave-tiku-");
  const wiki = join(root, "wiki");
  mkdirSync(join(wiki, "by-type", "04-文学类文本"), { recursive: true });
  mkdirSync(join(wiki, "by-type", "01-积累与运用"), { recursive: true });
  mkdirSync(join(wiki, "passages"), { recursive: true });
  mkdirSync(join(wiki, "images"), { recursive: true });
  writeFileSync(join(wiki, "images", "fig.png"), png);
  writeFileSync(join(wiki, "by-type", "04-文学类文本", "Q2024-TEST-002.md"), questionFile());
  writeFileSync(join(wiki, "by-type", "01-积累与运用", "Q2023-TEST-001.md"), choiceFile());
  writeFileSync(join(wiki, "passages", "R2024-TEST-01.md"), "---\npassage_title: 合成材料\n---\n合成材料正文。\n");
  return { root, wiki };
}

function open() {
  const data = temp("paperweave-import-data-");
  const db = new Database(join(data, "paperweave.sqlite"));
  const attachments = new AttachmentStore(data);
  const store = new ImportStore(db, attachments);
  return { db, attachments, store, bank: new QuestionBank(db) };
}

test("扫描 Tiku：题号、分类、来源、材料关联、分值、答案与配图", () => {
  const { store } = open();
  const { root, wiki } = makeTiku();
  const scan = store.scan("tiku", root);
  expect(scan.summary.importable).toBe(2);
  const reading = scan.rows.find((row) => row.sourceKey === "Q2024-TEST-002");
  expect(reading).toBeDefined();
  expect(reading).toMatchObject({
    status: "importable",
    section: "文学类文本",
    pdfPage: 1,
    originalNumber: "2",
  });
  expect(reading?.classification).toMatchObject({
    stage: "初中",
    subject: "语文",
    grade: "九年级",
    examType: "阅读理解",
    year: "2024",
    sourceName: "自制样题",
    questionType: "阅读理解",
  });
  expect(reading?.classification.knowledgePoints).toEqual(expect.arrayContaining(["文学类文本", "小说阅读", "合成", "阅读"]));
  expect(reading?.reasons).toContain("页码待补（按第 1 页）");
  const content = reading?.incoming;
  expect(content?.materials).toHaveLength(1);
  expect(content?.subQuestions).toHaveLength(2);
  expect(content?.subQuestions[0].originalScore).toBe(4);
  expect(content?.subQuestions[1].originalScore).toBe(6);
  expect(content?.subQuestions[0].materialIds).toEqual([content?.materials[0].materialId]);
  expect(content?.stem.some((block) => block.type === "image")).toBe(true);
  expect(hasContent(content?.subQuestions[0].answers[0].blocks ?? [])).toBe(true);
  expect(hasContent(content?.subQuestions[1].explanation ?? [])).toBe(true);
  expect(existsSync(join(wiki, "images", "fig.png"))).toBe(true);
});

test("扫描 Tiku：选择题选项与答案分拆，题干不含选项文本", () => {
  const { store } = open();
  const { root } = makeTiku();
  const scan = store.scan("tiku", root);
  const choice = scan.rows.find((row) => row.sourceKey === "Q2023-TEST-001");
  expect(choice?.status).toBe("importable");
  expect(choice?.originalNumber).toBe("1");
  const sub = choice?.incoming?.subQuestions[0];
  expect(sub?.options.map((option) => option.label)).toEqual(["A", "B", "C", "D"]);
  expect(JSON.stringify(sub?.prompt)).not.toContain("甲选项");
  expect(JSON.stringify(sub?.answers)).toContain("B");
});

test("缺图、材料失链与解析失败逐条列入阻断原因", () => {
  const { store } = open();
  const { root, wiki } = makeTiku();
  writeFileSync(join(wiki, "by-type", "04-文学类文本", "Q2024-TEST-002.md"), questionFile({ image: "missing.png", passage: "R2024-MISSING" }));
  writeFileSync(join(wiki, "by-type", "01-积累与运用", "Q2023-TEST-001.md"), "没有 frontmatter 的合成内容\n");
  const scan = store.scan("tiku", root);
  const reading = scan.rows.find((row) => row.sourceKey === "Q2024-TEST-002");
  expect(reading?.status).toBe("blocked");
  expect(reading?.reasons.join("；")).toContain("缺图");
  expect(reading?.reasons.join("；")).toContain("材料失链");
  const broken = scan.rows.find((row) => row.sourceKey === "Q2023-TEST-001");
  expect(broken?.status).toBe("blocked");
  expect(broken?.reasons.join("；")).toContain("frontmatter");
  expect(scan.summary.blocked).toBe(2);
});

test("缺图阻断项补图后单条重新校验可导入，其余条目不受影响", () => {
  const { db, store, bank } = open();
  const { root, wiki } = makeTiku();
  writeFileSync(join(wiki, "by-type", "04-文学类文本", "Q2024-TEST-002.md"), questionFile({ image: "missing.png" }));
  const scan = store.scan("tiku", root);
  const blocked = scan.rows.find((row) => row.sourceKey === "Q2024-TEST-002")!;
  expect(blocked.status).toBe("blocked");
  expect(blocked.problems).toEqual(["缺图：../../images/missing.png"]);
  const problem = blocked.problems![0];
  const corrected = store.correct(
    { scanId: scan.scanId, sourceKey: blocked.sourceKey, action: "attachImage", problem },
    { data: png, path: join(wiki, "images", "fig.png"), alt: "补入示意图" },
  );
  expect(corrected.status).toBe("importable");
  expect(corrected.problems).toEqual([]);
  expect(corrected.reasons.join("；")).not.toContain("缺图");
  expect(corrected.incoming?.subQuestions[0].prompt.some((block) => block.type === "image" && block.alt === "补入示意图")).toBe(true);
  const result = store.apply({ scanId: scan.scanId, rows: [{ sourceKey: blocked.sourceKey, action: "import" }] });
  expect(result).toMatchObject({ imported: 1, revised: 0, skipped: 0 });
  expect(bank.searchQuestions({ keyword: "合成第一问" })).toHaveLength(1);
  expect(db.read((sqlite) => (sqlite.prepare("SELECT count(*) AS count FROM questions").get() as { count: number }).count)).toBe(1);
  const record = db.read((sqlite) => sqlite.prepare("SELECT detail FROM import_records WHERE kind = 'tiku' AND source_key = ?").get(blocked.sourceKey) as { detail: string });
  expect(JSON.parse(record.detail).corrections).toEqual(["补图：缺图：../../images/missing.png"]);
});

test("材料失链确认不带材料后单条导入，未修正的阻断仍被拒绝", () => {
  const { store, bank } = open();
  const { root, wiki } = makeTiku();
  writeFileSync(join(wiki, "by-type", "04-文学类文本", "Q2024-TEST-002.md"), questionFile({ passage: "R2024-MISSING" }));
  const scan = store.scan("tiku", root);
  const blocked = scan.rows.find((row) => row.sourceKey === "Q2024-TEST-002")!;
  expect(blocked.status).toBe("blocked");
  const problem = blocked.problems!.find((item) => item.startsWith("材料失链"))!;
  expect(problem).toBe("材料失链：R2024-MISSING");
  expect(() => store.apply({ scanId: scan.scanId, rows: [{ sourceKey: blocked.sourceKey, action: "import" }] })).toThrow("阻断");
  expect(() => store.correct(
    { scanId: scan.scanId, sourceKey: blocked.sourceKey, action: "attachImage", problem },
    { data: png, path: join(wiki, "images", "fig.png"), alt: "补图" },
  )).toThrow("补图");
  const corrected = store.correct({ scanId: scan.scanId, sourceKey: blocked.sourceKey, action: "dropProblem", problem });
  expect(corrected.status).toBe("importable");
  const result = store.apply({ scanId: scan.scanId, rows: [{ sourceKey: blocked.sourceKey, action: "import" }] });
  expect(result.imported).toBe(1);
  const found = bank.searchQuestions({ keyword: "合成第一问" })[0];
  const detail = bank.getQuestionVersion(found.versionId);
  expect(detail?.content.materials).toEqual([]);
});

test("来源变化时给出字段级差异：题干、答案、分类、材料与图片分别标记", () => {
  const { store } = open();
  const { root, wiki } = makeTiku();
  const first = store.scan("tiku", root);
  store.apply({ scanId: first.scanId, rows: [{ sourceKey: "Q2024-TEST-002", action: "import" }] });
  writeFileSync(join(wiki, "by-type", "04-文学类文本", "Q2024-TEST-002.md"), questionFile({
    image: null,
    questionType: "现代文阅读",
    body: "修改后的合成题干。",
    answer: "（1）修改后的答案一。\n\n（2）合成答案二。",
  }));
  writeFileSync(join(wiki, "passages", "R2024-TEST-01.md"), "---\npassage_title: 合成材料\n---\n修改后的材料正文。\n");
  const row = store.scan("tiku", root).rows.find((entry) => entry.sourceKey === "Q2024-TEST-002")!;
  expect(row.status).toBe("changed");
  const diff = row.diff ?? [];
  expect(diff.some((item) => item.field === "题号")).toBe(false);
  expect(diff.find((item) => item.field === "分类")).toMatchObject({ change: "modified" });
  expect(diff.find((item) => item.field === "题干")?.before).toContain("阅读下面的合成材料");
  expect(diff.find((item) => item.field === "题干")?.after).toContain("修改后的合成题干");
  expect(diff.find((item) => item.field === "答案")?.after).toContain("修改后的答案一");
  expect(diff.find((item) => item.field === "材料")?.after).toContain("修改后的材料正文");
  expect(diff.find((item) => item.field === "图片")).toMatchObject({ change: "removed" });
});

test("执行导入：题目待核、答案待核、材料关联与配图落库，旧状态只入记录", () => {
  const { db, store, bank } = open();
  const { root } = makeTiku();
  const scanView = store.scan("tiku", root);
  const scanId = scanView.scanId;
  const scan = scanView;
  const result = store.apply({ scanId, rows: scan.rows.map((row) => ({ sourceKey: row.sourceKey, action: "import" as const })) });
  expect(result).toMatchObject({ imported: 2, revised: 0, skipped: 0 });
  const found = bank.searchQuestions({ keyword: "合成第一问" });
  expect(found).toHaveLength(1);
  expect(found[0]).toMatchObject({ contentStatus: "pending", answerStatus: "pending" });
  const detail = bank.getQuestionVersion(found[0].versionId);
  expect(detail?.content.materials).toHaveLength(1);
  expect(detail?.content.subQuestions[0].materialIds).toEqual([detail?.content.materials[0].materialId]);
  expect(JSON.stringify(detail?.content.stem)).not.toContain("![");
  const importedContent = detail!.content;
  const material = db.read((sqlite) => sqlite.prepare("SELECT status FROM material_versions WHERE id = ?").get(importedContent.materials[0].versionId) as { status: string });
  expect(material.status).toBe("pending");
  const record = db.read((sqlite) => sqlite.prepare("SELECT detail FROM import_records WHERE kind = 'tiku' AND source_key = ?").get("Q2024-TEST-002") as { detail: string });
  expect(JSON.parse(record.detail).legacyStatus).toBe("已入库");
  const batch = store.history()[0];
  expect(batch).toMatchObject({ kind: "tiku", summary: { imported: 2, revised: 0, skipped: 0 } });
});

test("重复扫描不新增题目；来源变化展示差异，修订后身份不变、版本加一", () => {
  const { store, bank } = open();
  const { root, wiki } = makeTiku();
  const first = store.scan("tiku", root);
  const applied = store.apply({ scanId: first.scanId, rows: [{ sourceKey: "Q2024-TEST-002", action: "import" }] });
  expect(applied.imported).toBe(1);

  const again = store.scan("tiku", root);
  const duplicate = again.rows.find((row) => row.sourceKey === "Q2024-TEST-002");
  expect(duplicate?.status).toBe("duplicate");
  expect(duplicate?.incoming).toBeUndefined();
  expect(duplicate?.target?.questionId).toBeDefined();
  expect(() => store.apply({ scanId: again.scanId, rows: [{ sourceKey: "Q2024-TEST-002", action: "import" }] })).toThrow("已导入");

  writeFileSync(join(wiki, "passages", "R2024-TEST-01.md"), "---\npassage_title: 合成材料\n---\n修订后的合成材料正文。\n");
  const changedScan = store.scan("tiku", root);
  const changed = changedScan.rows.find((row) => row.sourceKey === "Q2024-TEST-002");
  expect(changed?.status).toBe("changed");
  expect(changed?.canRevise).toBe(true);
  expect(changed?.target?.preview).toBeTruthy();
  expect(changed?.incoming).toBeDefined();
  const revised = store.apply({ scanId: changedScan.scanId, rows: [{ sourceKey: "Q2024-TEST-002", action: "revise" }] });
  expect(revised.revised).toBe(1);
  const latest = bank.getLatestQuestionVersion(duplicate!.target!.questionId);
  expect(latest?.version).toBe(2);
  expect(latest?.contentStatus).toBe("pending");
  expect(JSON.stringify(latest?.content.materials)).toBeTruthy();
});

test("目标题已人工修改时标记为已修改，禁止自动修订；保留当前会记录决定", () => {
  const { store, bank } = open();
  const { root, wiki } = makeTiku();
  const first = store.scan("tiku", root);
  store.apply({ scanId: first.scanId, rows: [{ sourceKey: "Q2024-TEST-002", action: "import" }] });
  const questionId = store.scan("tiku", root).rows.find((row) => row.sourceKey === "Q2024-TEST-002")!.target!.questionId;
  const latest = bank.getLatestQuestionVersion(questionId)!;
  bank.saveQuestionVersion(questionId, latest.content);
  writeFileSync(join(wiki, "passages", "R2024-TEST-01.md"), "---\npassage_title: 合成材料\n---\n第二次修订的材料。\n");
  const scan = store.scan("tiku", root);
  const row = scan.rows.find((entry) => entry.sourceKey === "Q2024-TEST-002");
  expect(row?.status).toBe("target_modified");
  expect(row?.canRevise).toBe(false);
  expect(() => store.apply({ scanId: scan.scanId, rows: [{ sourceKey: "Q2024-TEST-002", action: "revise" }] })).toThrow("人工修改");
  const skipped = store.apply({ scanId: scan.scanId, rows: [{ sourceKey: "Q2024-TEST-002", action: "skip" }] });
  expect(skipped.skipped).toBe(1);
  expect(store.scan("tiku", root).rows.find((entry) => entry.sourceKey === "Q2024-TEST-002")?.status).toBe("duplicate");
});

test("仅修改目标分类后再扫描标记为已修改，展示分类差异且不覆盖", () => {
  const { store, bank } = open();
  const { root } = makeTiku();
  const first = store.scan("tiku", root);
  store.apply({ scanId: first.scanId, rows: [{ sourceKey: "Q2024-TEST-002", action: "import" }] });
  const questionId = store.scan("tiku", root).rows.find((row) => row.sourceKey === "Q2024-TEST-002")!.target!.questionId;
  const classification = bank.getQuestionClassification(questionId)!;
  bank.setClassification(questionId, { ...classification, knowledgePoints: ["修改后知识点"] });

  const scan = store.scan("tiku", root);
  const row = scan.rows.find((entry) => entry.sourceKey === "Q2024-TEST-002");
  expect(row?.status).toBe("target_modified");
  const classificationDiff = row?.diff?.find((item) => item.field === "分类");
  expect(classificationDiff?.before).toContain("修改后知识点");
  expect(classificationDiff?.after).toContain("小说阅读");
  expect(() => store.apply({ scanId: scan.scanId, rows: [{ sourceKey: "Q2024-TEST-002", action: "revise" }] })).toThrow("人工修改");
  const skipped = store.apply({ scanId: scan.scanId, rows: [{ sourceKey: "Q2024-TEST-002", action: "skip" }] });
  expect(skipped.skipped).toBe(1);
  expect(bank.getQuestionClassification(questionId)?.knowledgePoints).toEqual(["修改后知识点"]);
});

test("批次中后续条目失败时整体回滚，先前条目也不落库", () => {
  const { db, store, bank } = open();
  const { root, wiki } = makeTiku();
  const first = store.scan("tiku", root);
  store.apply({ scanId: first.scanId, rows: [{ sourceKey: "Q2024-TEST-002", action: "import" }] });
  const questionId = store.scan("tiku", root).rows.find((row) => row.sourceKey === "Q2024-TEST-002")!.target!.questionId;
  writeFileSync(join(wiki, "passages", "R2024-TEST-01.md"), "---\npassage_title: 合成材料\n---\n用于回滚测试的材料。\n");
  const scan = store.scan("tiku", root);
  db.transaction((sqlite) => {
    sqlite.prepare("DELETE FROM question_material_refs WHERE question_version_id IN (SELECT id FROM question_versions WHERE question_id = ?)").run(questionId);
    sqlite.prepare("DELETE FROM question_versions WHERE question_id = ?").run(questionId);
    sqlite.prepare("DELETE FROM question_knowledge_points WHERE question_id = ?").run(questionId);
    sqlite.prepare("DELETE FROM question_exams WHERE question_id = ?").run(questionId);
    sqlite.prepare("DELETE FROM basket_items WHERE question_id = ?").run(questionId);
    sqlite.prepare("DELETE FROM questions WHERE id = ?").run(questionId);
  });
  const batchesBefore = store.history().length;
  expect(() => store.apply({
    scanId: scan.scanId,
    rows: [
      { sourceKey: "Q2023-TEST-001", action: "import" },
      { sourceKey: "Q2024-TEST-002", action: "revise" },
    ],
  })).toThrow("题目不存在");
  expect(store.history()).toHaveLength(batchesBefore);
  expect(db.read((sqlite) => (sqlite.prepare("SELECT count(*) AS count FROM questions").get() as { count: number }).count)).toBe(0);
  expect(bank.searchQuestions({ keyword: "合成选择题" })).toHaveLength(0);
});

test("修订失败整体回滚，不留下半批题目、记录或批次", () => {
  const { db, store, bank } = open();
  const { root } = makeTiku();
  const first = store.scan("tiku", root);
  store.apply({ scanId: first.scanId, rows: [{ sourceKey: "Q2024-TEST-002", action: "import" }] });
  const before = bank.searchQuestions({ keyword: "合成第一问" })[0];
  const batchesBefore = store.history().length;
  const scan = store.scan("tiku", root);
  expect(() => store.apply({
    scanId: scan.scanId,
    rows: [
      { sourceKey: "Q2023-TEST-001", action: "import" },
      { sourceKey: "Q2024-TEST-002", action: "import" },
    ],
  })).toThrow();
  expect(store.history()).toHaveLength(batchesBefore);
  expect(db.read((sqlite) => (sqlite.prepare("SELECT count(*) AS count FROM questions").get() as { count: number }).count)).toBe(1);
  expect(bank.getLatestQuestionVersion(before.questionId)?.version).toBe(1);
});
