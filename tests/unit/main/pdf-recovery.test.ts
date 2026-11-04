import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { recoverPendingOperations } from "../../../src/main/pdf-recovery";

const dirs: string[] = [];
const createDir = () => { const dir = mkdtempSync(join(tmpdir(), "paperweave-recover-")); dirs.push(dir); return dir; };
const pendingDir = (parent: string, id: string) => join(parent, `.paperweave-${id}.pending`);
const finalDir = (parent: string, id: string) => join(parent, `拾题成卷-样张-${id}`);
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test("暂存目录只含两份预期 PDF 时删除并清除记录", async () => {
  const dir = createDir();
  const id = randomUUID();
  mkdirSync(pendingDir(dir, id));
  writeFileSync(join(pendingDir(dir, id), "学生卷.pdf"), "%PDF-1");
  writeFileSync(join(pendingDir(dir, id), "教师答案卷.pdf"), "%PDF-1");
  const result = await recoverPendingOperations([{ id, parent: dir }]);
  expect(result).toEqual({ cleared: [id], kept: [] });
  expect(existsSync(pendingDir(dir, id))).toBe(false);
});

test("已完成的定稿目录保留，只清除记录", async () => {
  const dir = createDir();
  const id = randomUUID();
  mkdirSync(finalDir(dir, id));
  writeFileSync(join(finalDir(dir, id), "学生卷.pdf"), "%PDF-1");
  const result = await recoverPendingOperations([{ id, parent: dir }]);
  expect(result).toEqual({ cleared: [id], kept: [] });
  expect(existsSync(finalDir(dir, id))).toBe(true);
});

test("暂存目录含非预期文件时不删除，保留记录", async () => {
  const dir = createDir();
  const id = randomUUID();
  mkdirSync(pendingDir(dir, id));
  writeFileSync(join(pendingDir(dir, id), "学生卷.pdf"), "%PDF-1");
  writeFileSync(join(pendingDir(dir, id), "笔记.txt"), "保留");
  const result = await recoverPendingOperations([{ id, parent: dir }]);
  expect(result).toEqual({ cleared: [], kept: [{ id, parent: dir }] });
  expect(existsSync(join(pendingDir(dir, id), "笔记.txt"))).toBe(true);
});

test("文件都不存在时仅清除记录", async () => {
  const dir = createDir();
  const id = randomUUID();
  const result = await recoverPendingOperations([{ id, parent: dir }]);
  expect(result).toEqual({ cleared: [id], kept: [] });
});
