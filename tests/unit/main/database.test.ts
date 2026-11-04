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
  expect(raw.prepare("PRAGMA user_version").get()?.user_version).toBe(3);
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
  expect(raw.prepare("PRAGMA user_version").get()?.user_version).toBe(3);
  const tables = raw.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all().map((row) => (row as { name: string }).name);
  for (const table of ["questions", "question_versions", "materials", "material_versions", "question_material_refs"]) expect(tables).toContain(table);
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
