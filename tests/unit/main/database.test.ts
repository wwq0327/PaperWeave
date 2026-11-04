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
  expect(raw.prepare("PRAGMA user_version").get()?.user_version).toBe(1);
  raw.close();
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
