import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as io from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { writePdfPair } from "../../../src/main/pdf-pair";

const dirs: string[] = [];
const createDir = () => { const dir = mkdtempSync(join(tmpdir(), "paperweave-pair-")); dirs.push(dir); return dir; };
const pdf = (text: string) => Buffer.from(`%PDF-1.7\n${text}${" ".repeat(120)}\n%%EOF\n`);
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test("两份都写入后才出现输出目录，保留此前文件", async () => {
  const dir = createDir();
  writeFileSync(join(dir, "已有文件"), "保留");
  const id = randomUUID();
  const output = await writePdfPair(dir, id, pdf("学生"), pdf("答案"));
  expect(await writePdfPair(dir, id, pdf("学生"), pdf("答案"))).toBe(output);
  await expect(writePdfPair(dir, id, pdf("修改"), pdf("答案"))).rejects.toThrow("不同内容");
  expect(readFileSync(join(output, "学生卷.pdf"))).toEqual(pdf("学生"));
  expect(readFileSync(join(output, "教师答案卷.pdf"))).toEqual(pdf("答案"));
  expect(readFileSync(join(dir, "已有文件"), "utf8")).toBe("保留");
  expect(readdirSync(dir).filter((name) => name.endsWith(".pending"))).toEqual([]);
});

test("第二份写入失败时不留下完整目录，也不修改已有文件", async () => {
  const dir = createDir();
  writeFileSync(join(dir, "旧卷.pdf"), "旧数据");
  const failing = { ...io, writeFile: async (...args: Parameters<typeof io.writeFile>) => {
    if (String(args[0]).endsWith("教师答案卷.pdf")) throw new Error("模拟写入失败");
    return io.writeFile(...args);
  } };
  await expect(writePdfPair(dir, randomUUID(), pdf("学生"), pdf("答案"), failing)).rejects.toThrow("模拟写入失败");
  expect(readdirSync(dir)).toEqual(["旧卷.pdf"]);
  expect(readFileSync(join(dir, "旧卷.pdf"), "utf8")).toBe("旧数据");
});

test("一份无效时拒绝开始写入", async () => {
  const dir = createDir();
  await expect(writePdfPair(dir, randomUUID(), pdf("学生"), Buffer.from("不是 PDF"))).rejects.toThrow("必须都生成并校验成功");
  expect(readdirSync(dir)).toEqual([]);
});
