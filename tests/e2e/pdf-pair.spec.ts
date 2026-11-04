import { test, expect, _electron as electron } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database } from "../../src/main/database";
import { extractPdfText } from "../../src/main/pdf-text";

// 覆盖双 PDF IPC 接线（begin/capture/finish/cancel）与原子落盘；
// 注意：两份内容当前相同，真实学生/教师内容隔离属后续 Issue #5 工作，不能据此关闭 Issue。
test("双 PDF IPC：生成、校验、打开并在取消后失效", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "paperweave-pair-"));
  const outDir = mkdtempSync(path.join(tmpdir(), "paperweave-pair-out-"));
  const app = await electron.launch({ args: [path.resolve(".vite/build/main.cjs"), `--user-data-dir=${dir}`] });
  try {
    await app.evaluate(({ dialog, shell }, target) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] });
      shell.openPath = async (file) => {
        const opened = (globalThis as typeof globalThis & { openedPdfs?: string[] }).openedPdfs ?? [];
        opened.push(file);
        (globalThis as typeof globalThis & { openedPdfs?: string[] }).openedPdfs = opened;
        return "";
      };
    }, outDir);
    const page = await app.firstWindow();
    const result = await page.evaluate(async () => {
      type Bridge = {
        beginPdfPair(): Promise<string | null>;
        captureStudentPdf(id: string): Promise<void>;
        finishPdfPair(id: string): Promise<{ directory: string; studentPath: string; teacherPath: string; openErrors: string[] }>;
        cancelPdfPair(id: string): Promise<void>;
      };
      const bridge = (window as unknown as { paperweave: Bridge }).paperweave;
      const id = await bridge.beginPdfPair();
      if (!id) throw new Error("未取得操作标识");
      await bridge.captureStudentPdf(id);
      return bridge.finishPdfPair(id);
    });
    expect(existsSync(result.studentPath)).toBe(true);
    expect(existsSync(result.teacherPath)).toBe(true);
    for (const file of [result.studentPath, result.teacherPath]) {
      expect(readFileSync(file).subarray(0, 5).toString()).toBe("%PDF-");
    }
    const opened = await app.evaluate(() => (globalThis as typeof globalThis & { openedPdfs?: string[] }).openedPdfs);
    expect(opened).toEqual([result.studentPath, result.teacherPath]);
    // 已结束的操作标识不能复用
    await expect(page.evaluate(() => {
      type Bridge = { captureStudentPdf(id: string): Promise<void> };
      return (window as unknown as { paperweave: Bridge }).paperweave.captureStudentPdf("00000000-0000-0000-0000-000000000000");
    })).rejects.toThrow(/无效或已结束/);
    // 取消后操作失效
    const canceled = await page.evaluate(async () => {
      type Bridge = {
        beginPdfPair(): Promise<string | null>;
        captureStudentPdf(id: string): Promise<void>;
        cancelPdfPair(id: string): Promise<void>;
      };
      const bridge = (window as unknown as { paperweave: Bridge }).paperweave;
      const id = await bridge.beginPdfPair();
      if (!id) throw new Error("未取得操作标识");
      await bridge.cancelPdfPair(id);
      try {
        await bridge.captureStudentPdf(id);
        return "captured";
      } catch {
        return "rejected";
      }
    });
    expect(canceled).toBe("rejected");
  } finally {
    await app.evaluate(({ app: electronApp }) => { electronApp.exit(0); }).catch(() => undefined);
    await app.close().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("界面导出双卷：两份 PDF 由各自允许的字段生成且内容不同", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "paperweave-dual-"));
  const outDir = mkdtempSync(path.join(tmpdir(), "paperweave-dual-out-"));
  const app = await electron.launch({ args: [path.resolve(".vite/build/main.cjs"), `--user-data-dir=${dir}`] });
  try {
    await app.evaluate(({ dialog, shell }, target) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] });
      shell.openPath = async () => "";
    }, outDir);
    const page = await app.firstWindow();
    await page.getByLabel("教师参考答案（仅供教师卷样张使用）").fill("参考答案：3 个苹果。");
    await page.getByRole("button", { name: "生成学生卷与教师答案卷" }).click();
    await expect(page.getByText(/学生卷与教师答案卷已保存并打开/)).toBeVisible();
    const entries = readdirSync(outDir);
    expect(entries).toHaveLength(1);
    const student = readFileSync(path.join(outDir, entries[0], "学生卷.pdf"));
    const teacher = readFileSync(path.join(outDir, entries[0], "教师答案卷.pdf"));
    expect(student.subarray(0, 5).toString()).toBe("%PDF-");
    expect(teacher.subarray(0, 5).toString()).toBe("%PDF-");
    expect(teacher.equals(student)).toBe(false);
    const studentText = (await extractPdfText(new Uint8Array(student))).pages.map((item) => item.text).join("\n").normalize("NFKC");
    const teacherText = (await extractPdfText(new Uint8Array(teacher))).pages.map((item) => item.text).join("\n").normalize("NFKC");
    expect(studentText).not.toContain("参考答案");
    expect(studentText).not.toContain("3 个苹果");
    expect(teacherText).toContain("参考答案");
    expect(teacherText).toContain("3 个苹果");
  } finally {
    await app.evaluate(({ app: electronApp }) => { electronApp.exit(0); }).catch(() => undefined);
    await app.close().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("启动时清理未完成的双卷暂存目录并清除记录", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "paperweave-recover-user-"));
  const outParent = mkdtempSync(path.join(tmpdir(), "paperweave-recover-out-"));
  const id = randomUUID();
  const pending = path.join(outParent, `.paperweave-${id}.pending`);
  const db = new Database(path.join(dir, "paperweave.sqlite"));
  db.setSetting("pdf.pending", JSON.stringify([{ id, parent: outParent }]));
  db.close();
  mkdirSync(pending);
  writeFileSync(path.join(pending, "学生卷.pdf"), "%PDF-1");
  const app = await electron.launch({ args: [path.resolve(".vite/build/main.cjs"), `--user-data-dir=${dir}`] });
  try {
    await app.firstWindow();
    expect(existsSync(pending)).toBe(false);
  } finally {
    await app.evaluate(({ app: electronApp }) => { electronApp.exit(0); }).catch(() => undefined);
    await app.close().catch(() => undefined);
  }
  const check = new Database(path.join(dir, "paperweave.sqlite"));
  expect(check.getSetting("pdf.pending")).toBe("[]");
  check.close();
  rmSync(dir, { recursive: true, force: true });
  rmSync(outParent, { recursive: true, force: true });
});
