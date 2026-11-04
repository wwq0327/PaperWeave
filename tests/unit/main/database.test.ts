import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, test } from "vitest";
import { Database } from "../../../src/main/database";

const directories: string[] = [];
function dbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "paperweave-db-"));
  directories.push(dir);
  return join(dir, "题库.sqlite");
}
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

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
  expect(raw.prepare("PRAGMA user_version").get()?.user_version).toBe(4);
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
  expect(raw.prepare("PRAGMA user_version").get()?.user_version).toBe(4);
  const tables = raw.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all().map((row) => (row as { name: string }).name);
  for (const table of ["questions", "question_versions", "materials", "material_versions", "question_material_refs"]) expect(tables).toContain(table);
  raw.close();
});

test("版本 3 升级到 4 时保留题目与审核状态，并增加分类列", () => {
  const path = dbPath();
  const old = new DatabaseSync(path);
  old.exec(`
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
    INSERT INTO questions VALUES ('q1', '2026-11-01T00:00:00Z');
    INSERT INTO question_versions VALUES ('v1', 'q1', 1, '{}', 'pending', 'approved', '2026-11-01T00:00:00Z');
    PRAGMA user_version = 3
  `);
  old.close();
  const db = new Database(path);
  db.close();
  const raw = new DatabaseSync(path);
  expect(raw.prepare("PRAGMA user_version").get()?.user_version).toBe(4);
  expect(raw.prepare("SELECT content_status, answer_status, search_text FROM question_versions WHERE id = 'v1'").get()).toEqual({ content_status: "pending", answer_status: "approved", search_text: "" });
  const columns = raw.prepare("PRAGMA table_info(questions)").all().map((row) => (row as { name: string }).name);
  for (const column of ["stage", "subject", "grade", "exam_type", "year", "source_name", "question_type"]) expect(columns).toContain(column);
  const tables = raw.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all().map((row) => (row as { name: string }).name);
  expect(tables).toContain("question_knowledge_points");
  const indexes = raw.prepare("SELECT name FROM sqlite_schema WHERE type = 'index'").all().map((row) => (row as { name: string }).name);
  expect(indexes).toContain("questions_classification");
  expect(indexes).toContain("question_knowledge_points_value");
  raw.close();
});

test("事务失败时回滚", () => {
  const path = dbPath();
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
