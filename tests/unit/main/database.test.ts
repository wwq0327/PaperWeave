import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, test } from "vitest";
import { Database } from "../../../src/main/database";
import type { QuestionContent } from "../../../src/shared/question";

const directories: string[] = [];
function dbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "paperweave-db-"));
  directories.push(dir);
  return join(dir, "题库.sqlite");
}
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/** 版本 4 及更早的内容格式：小问没有原分值与小问材料。 */
type LegacyContent = Omit<QuestionContent, "subQuestions"> & {
  subQuestions: Omit<QuestionContent["subQuestions"][number], "originalScore" | "materialIds">[];
};

function legacyContent(): LegacyContent {
  return {
    stem: [{ type: "paragraph", runs: [{ type: "text", text: "旧题干", style: "普通" }] }],
    subQuestions: [{
      id: "s1",
      originalLabel: "(1)",
      prompt: [{ type: "paragraph", runs: [{ type: "text", text: "旧小问", style: "普通" }] }],
      explanation: [],
      options: [],
      slots: [],
      answers: [],
      scoring: [{ id: "p1", description: "要点", score: 2, slotIds: [] }],
      dependsOn: [],
    }],
    materials: [],
    selection: { mode: "all" },
    source: { section: "语文", pdfPage: 1, originalNumber: "1" },
  };
}

const questionVersionsV3Schema = `
  CREATE TABLE questions (id TEXT PRIMARY KEY, created_at TEXT NOT NULL) STRICT;
  CREATE TABLE question_versions (
    id TEXT PRIMARY KEY,
    question_id TEXT NOT NULL REFERENCES questions(id),
    version INTEGER NOT NULL,
    content TEXT NOT NULL,
    content_status TEXT NOT NULL CHECK (content_status IN ('draft', 'pending', 'approved')),
    answer_status TEXT NOT NULL CHECK (answer_status IN ('missing', 'pending', 'approved')),
    created_at TEXT NOT NULL,
    UNIQUE (question_id, version)
  ) STRICT;
`;

const questionsV4Columns = `
  ALTER TABLE questions ADD COLUMN stage TEXT NOT NULL DEFAULT '';
  ALTER TABLE questions ADD COLUMN subject TEXT NOT NULL DEFAULT '';
  ALTER TABLE questions ADD COLUMN grade TEXT NOT NULL DEFAULT '';
  ALTER TABLE questions ADD COLUMN exam_type TEXT NOT NULL DEFAULT '';
  ALTER TABLE questions ADD COLUMN year TEXT NOT NULL DEFAULT '';
  ALTER TABLE questions ADD COLUMN source_name TEXT NOT NULL DEFAULT '';
  ALTER TABLE questions ADD COLUMN question_type TEXT NOT NULL DEFAULT '';
  ALTER TABLE question_versions ADD COLUMN search_text TEXT NOT NULL DEFAULT '';
`;

test("首次建库、写入、更新并重开", () => {
  const path = dbPath();
  const db = new Database(path);
  expect(db.getSetting("标题")).toBeUndefined();
  db.setSetting("标题", "中文");
  db.setSetting("标题", "拾题成卷");
  db.close();
  const reopened = new Database(path);
  expect(reopened.getSetting("标题")).toBe("拾题成卷");
  reopened.close();
  const raw = new DatabaseSync(path);
  expect(raw.prepare("PRAGMA user_version").get()?.user_version).toBe(8);
  raw.close();
});

test("版本 2 升级到 3 时保留设置与草稿，并建好题目表", () => {
  const path = dbPath();
  const old = new DatabaseSync(path);
  old.exec("CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT; INSERT INTO app_settings VALUES ('标题', '旧库'); CREATE TABLE editor_drafts (id TEXT PRIMARY KEY, document TEXT NOT NULL) STRICT; INSERT INTO editor_drafts VALUES ('m0', '旧草稿'); PRAGMA user_version = 2");
  old.close();
  const db = new Database(path);
  expect(db.getSetting("标题")).toBe("旧库");
  expect(db.getDraft()).toBe("旧草稿");
  db.close();
  const raw = new DatabaseSync(path);
  expect(raw.prepare("PRAGMA user_version").get()?.user_version).toBe(8);
  const tables = raw.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all().map((row) => (row as { name: string }).name);
  for (const table of ["questions", "question_versions", "materials", "material_versions", "question_material_refs", "import_batches", "import_records"]) expect(tables).toContain(table);
  raw.close();
});

test("版本 3 升级到 4 时保留题目与审核状态，并增加分类列", () => {
  const path = dbPath();
  const old = new DatabaseSync(path);
  old.exec(`${questionVersionsV3Schema}
    INSERT INTO questions VALUES ('q1', '2026-11-01T00:00:00Z');
    PRAGMA user_version = 3
  `);
  old.prepare("INSERT INTO question_versions VALUES ('v1', 'q1', 1, ?, 'pending', 'approved', '2026-11-01T00:00:00Z')").run(JSON.stringify(legacyContent()));
  old.close();
  const db = new Database(path);
  db.close();
  const raw = new DatabaseSync(path);
  expect(raw.prepare("PRAGMA user_version").get()?.user_version).toBe(8);
  expect(raw.prepare("SELECT content_status, answer_status, search_text FROM question_versions WHERE id = 'v1'").get()).toEqual({ content_status: "pending", answer_status: "approved", search_text: "" });
  const migrated = JSON.parse((raw.prepare("SELECT content FROM question_versions WHERE id = 'v1'").get() as { content: string }).content);
  expect(migrated.subQuestions[0].originalScore).toBe(2);
  const columns = raw.prepare("PRAGMA table_info(questions)").all().map((row) => (row as { name: string }).name);
  for (const column of ["stage", "subject", "grade", "exam_type", "year", "source_name", "question_type"]) expect(columns).toContain(column);
  const tables = raw.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all().map((row) => (row as { name: string }).name);
  expect(tables).toContain("question_knowledge_points");
  const indexes = raw.prepare("SELECT name FROM sqlite_schema WHERE type = 'index'").all().map((row) => (row as { name: string }).name);
  expect(indexes).toContain("questions_classification");
  expect(indexes).toContain("question_knowledge_points_value");
  raw.close();
});

function v4Database(path: string, contents: string[]): void {
  const old = new DatabaseSync(path);
  old.exec(questionVersionsV3Schema);
  old.exec(questionsV4Columns);
  old.exec("PRAGMA user_version = 4");
  old.prepare("INSERT INTO questions (id, created_at) VALUES ('q1', '2026-11-01T00:00:00Z')").run();
  const insert = old.prepare("INSERT INTO question_versions (id, question_id, version, content, content_status, answer_status, created_at, search_text) VALUES (?, 'q1', ?, ?, 'pending', 'approved', '2026-11-01T00:00:00Z', '')");
  contents.forEach((content, index) => insert.run(`v${index + 1}`, index + 1, content));
  old.close();
}

function legacyGroup(): ReturnType<typeof legacyContent> {
  const content = legacyContent();
  content.subQuestions.push({
    id: "s2",
    originalLabel: "(2)",
    prompt: [{ type: "paragraph", runs: [{ type: "text", text: "旧小问二", style: "普通" }] }],
    explanation: [],
    options: [],
    slots: [],
    answers: [],
    scoring: [],
    dependsOn: ["s1"],
  });
  content.materials = [{ materialId: "material-a", versionId: "material-a-v1" }];
  return content;
}

test("版本 4 升级到 6 时补齐原分值与小问材料，并建好组卷与考试表", () => {
  const path = dbPath();
  const original = legacyGroup();
  v4Database(path, [JSON.stringify(original)]);
  const db = new Database(path);
  db.close();
  const raw = new DatabaseSync(path);
  expect(raw.prepare("PRAGMA user_version").get()?.user_version).toBe(8);
  const migrated = JSON.parse((raw.prepare("SELECT content FROM question_versions WHERE id = 'v1'").get() as { content: string }).content);
  expect(migrated.subQuestions[0].originalScore).toBe(2);
  expect(migrated.subQuestions[1].originalScore).toBeNull();
  expect(migrated.subQuestions[0].materialIds).toEqual(["material-a"]);
  expect(migrated.subQuestions[1].materialIds).toEqual(["material-a"]);
  expect(migrated.stem).toEqual(original.stem);
  expect(migrated.subQuestions[0].prompt).toEqual(original.subQuestions[0].prompt);
  const tables = raw.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all().map((row) => (row as { name: string }).name);
  for (const table of ["basket_items", "papers", "paper_sections", "paper_items", "paper_finalizations", "exams", "exam_sections", "original_files", "exam_originals", "question_exams"]) expect(tables).toContain(table);
  const indexes = raw.prepare("SELECT name FROM sqlite_schema WHERE type = 'index'").all().map((row) => (row as { name: string }).name);
  expect(indexes).toContain("basket_items_position");
  raw.close();
});

test("版本 4 内容迁移失败时整次回滚，不留下半升级数据库", () => {
  const path = dbPath();
  v4Database(path, ["不是 JSON"]);
  expect(() => new Database(path)).toThrow();
  const raw = new DatabaseSync(path);
  expect(raw.prepare("PRAGMA user_version").get()?.user_version).toBe(4);
  expect(raw.prepare("SELECT content FROM question_versions WHERE id = 'v1'").get()).toEqual({ content: "不是 JSON" });
  const tables = raw.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all().map((row) => (row as { name: string }).name);
  expect(tables).not.toContain("basket_items");
  raw.close();
});

test("事务失败时回滚", () => {  const path = dbPath();
  const db = new Database(path);
  expect(() => db.transaction((sqlite) => {
    sqlite.prepare("INSERT INTO app_settings (key, value) VALUES (?, ?)").run("回滚", "不应保留");
    throw new Error("模拟失败");
  })).toThrow("模拟失败");
  expect(db.getSetting("回滚")).toBeUndefined();
  db.close();
  const reopened = new Database(path);
  expect(reopened.getSetting("回滚")).toBeUndefined();
  reopened.close();
});

test("拒绝更高版本或未识别的现有数据库，不改动原数据", () => {
  for (const future of [true, false]) {
    const path = dbPath();
    const raw = new DatabaseSync(path);
    raw.exec(`CREATE TABLE existing (value TEXT); INSERT INTO existing VALUES ('保留'); ${future ? "PRAGMA user_version = 99" : ""}`);
    raw.close();
    expect(() => new Database(path)).toThrow();
    const check = new DatabaseSync(path);
    expect(check.prepare("SELECT value FROM existing").get()?.value).toBe("保留");
    expect(check.prepare("PRAGMA user_version").get()?.user_version).toBe(future ? 99 : 0);
    check.close();
  }
});

 test("从版本 1 升级且保留已有数据", () => {
  const path = dbPath();
  const old = new DatabaseSync(path);
  old.exec("CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT; INSERT INTO app_settings VALUES ('a', '旧值'); PRAGMA user_version = 1");
  old.close();
  const db = new Database(path);
  expect(db.getSetting("a")).toBe("旧值");
  db.saveDraft("草稿");
  db.close();
  const reopened = new Database(path);
  expect(reopened.getDraft()).toBe("草稿");
  reopened.close();
});

test("升级前生成旧版本快照，迁移成功后仍可打开旧库", () => {
  const path = dbPath();
  const old = new DatabaseSync(path);
  old.exec("CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT; INSERT INTO app_settings VALUES ('标题', '旧值'); PRAGMA user_version = 1");
  old.close();
  const db = new Database(path);
  expect(db.getSetting("标题")).toBe("旧值");
  db.close();

  const directory = join(dirname(path), ".migration-backups");
  const snapshots = readdirSync(directory);
  expect(snapshots).toHaveLength(1);
  expect(snapshots[0]).toMatch(/^paperweave-v1-.+\.sqlite$/);
  const snapshot = new DatabaseSync(join(directory, snapshots[0]));
  expect(snapshot.prepare("PRAGMA user_version").get()?.user_version).toBe(1);
  expect(snapshot.prepare("SELECT value FROM app_settings WHERE key = '标题'").get()?.value).toBe("旧值");
  const tables = snapshot.prepare("SELECT name FROM sqlite_schema WHERE name = 'questions'").all();
  expect(tables).toHaveLength(0);
  snapshot.close();
});

test("迁移失败时保留旧库与迁移前快照，并在错误中给出快照路径", () => {
  const path = dbPath();
  v4Database(path, ["不是 JSON"]);
  let message = "";
  try {
    new Database(path);
  } catch (error) {
    message = String(error);
  }
  expect(message).toContain("迁移前快照");

  const directory = join(dirname(path), ".migration-backups");
  const snapshots = readdirSync(directory);
  expect(snapshots).toHaveLength(1);
  expect(message).toContain(join(directory, snapshots[0]));
  const snapshot = new DatabaseSync(join(directory, snapshots[0]));
  expect(snapshot.prepare("PRAGMA user_version").get()?.user_version).toBe(4);
  expect(snapshot.prepare("SELECT content FROM question_versions WHERE id = 'v1'").get()).toEqual({ content: "不是 JSON" });
  snapshot.close();

  const original = new DatabaseSync(path);
  expect(original.prepare("PRAGMA user_version").get()?.user_version).toBe(4);
  expect(original.prepare("SELECT content FROM question_versions WHERE id = 'v1'").get()).toEqual({ content: "不是 JSON" });
  original.close();
});

test("新建库与已是最新版本不生成迁移快照", () => {
  const path = dbPath();
  new Database(path).close();
  new Database(path).close();
  expect(existsSync(join(dirname(path), ".migration-backups"))).toBe(false);
});
