import { test, expect, _electron as electron } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database } from "../../src/main/database";
import { PAPER_JOURNAL_KEY } from "../../src/main/paper-finalization";
import { pdfPairPaths } from "../../src/main/pdf-pair";

test("启动时清理未完成的组卷定稿暂存与无记录的完成目录", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "paperweave-paper-recover-"));
  const outParent = mkdtempSync(path.join(tmpdir(), "paperweave-paper-out-"));
  const pendingId = randomUUID();
  const orphanId = randomUUID();
  const pending = pdfPairPaths(outParent, pendingId).pending;
  const orphan = pdfPairPaths(outParent, orphanId).result;
  mkdirSync(pending);
  writeFileSync(path.join(pending, "学生卷.pdf"), "%PDF-1");
  mkdirSync(orphan);
  writeFileSync(path.join(orphan, "学生卷.pdf"), "%PDF-1");
  writeFileSync(path.join(orphan, "教师答案卷.pdf"), "%PDF-1");

  const db = new Database(path.join(dir, "paperweave.sqlite"));
  db.setSetting(PAPER_JOURNAL_KEY, JSON.stringify([{ id: pendingId, parent: outParent }, { id: orphanId, parent: outParent }]));
  db.close();

  const app = await electron.launch({ args: [path.resolve(".vite/build/main.cjs"), `--user-data-dir=${dir}`] });
  try {
    await app.firstWindow();
    expect(existsSync(pending)).toBe(false);
    expect(existsSync(orphan)).toBe(false);
  } finally {
    await app.evaluate(({ app: electronApp }) => { electronApp.exit(0); }).catch(() => undefined);
    await app.close().catch(() => undefined);
  }
  const check = new Database(path.join(dir, "paperweave.sqlite"));
  expect(check.getSetting(PAPER_JOURNAL_KEY)).toBe("[]");
  check.close();
  rmSync(dir, { recursive: true, force: true });
  rmSync(outParent, { recursive: true, force: true });
});
