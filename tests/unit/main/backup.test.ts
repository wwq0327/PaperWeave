import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database } from "../../../src/main/database";
import { applyPendingRestore, BackupService, inspectBackup } from "../../../src/main/backup";

const dirs: string[] = [];
function temp(prefix: string) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function seed(data: string, marker: string) {
  const db = new Database(path.join(data, "paperweave.sqlite"));
  mkdirSync(path.join(data, "attachments"), { recursive: true });
  mkdirSync(path.join(data, "originals"), { recursive: true });
  const attachment = "b".repeat(64);
  writeFileSync(path.join(data, "attachments", attachment), "配图内容");
  const original = "c".repeat(64);
  writeFileSync(path.join(data, "originals", `${original}.pdf`), "%PDF-1.4\n合成原卷\n");
  writeFileSync(path.join(data, "ai-key.bin"), "不得进入备份");
  db.setSetting("marker", marker);
  const paperId = "00000000-0000-0000-0000-000000000001";
  const finalizationId = "10000000-0000-0000-0000-000000000001";
  const external = temp("paperweave-finalized-");
  const student = path.join(external, "学生卷.pdf");
  const teacher = path.join(external, "教师答案卷.pdf");
  writeFileSync(student, "%PDF-1.4\n学生卷\n");
  writeFileSync(teacher, "%PDF-1.4\n教师卷\n");
  db.transaction((sqlite) => {
    sqlite.prepare("INSERT INTO papers (id, title, stage, subject, grade, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(paperId, "合成卷", "初中", "数学", "九年级", "2026-11-05T00:00:00.000Z", "2026-11-05T00:00:00.000Z");
    sqlite.prepare("INSERT INTO paper_finalizations (id, paper_id, student_pdf, teacher_pdf, snapshot, student_sha256, teacher_sha256, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(finalizationId, paperId, student, teacher, "{}", "d".repeat(64), "e".repeat(64), "2026-11-05T00:00:00.000Z");
  });
  return { db, attachment, original, finalizationId, student, teacher };
}

const clock = () => new Date(2026, 10, 5, 14, 25, 30);

describe("备份创建与检查", () => {
  it("收集数据库快照、附件、原卷与定稿 PDF，清单可校验且不含密钥", async () => {
    const data = temp("paperweave-data-");
    const { db, attachment, original, finalizationId } = seed(data, "题库 A");
    const destination = temp("paperweave-dest-");
    const service = new BackupService(db, data, "1.0.0", clock);
    const summary = await service.create(destination);
    db.close();

    expect(summary.name).toBe("PaperWeave-backup-20261105-142530");
    const directory = path.join(destination, summary.name);
    expect(existsSync(path.join(directory, "manifest.json"))).toBe(true);
    expect(existsSync(path.join(directory, "attachments", attachment))).toBe(true);
    expect(existsSync(path.join(directory, "originals", `${original}.pdf`))).toBe(true);
    expect(existsSync(path.join(directory, "papers", finalizationId, "student.pdf"))).toBe(true);
    expect(existsSync(path.join(directory, "papers", finalizationId, "teacher.pdf"))).toBe(true);
    expect(existsSync(path.join(directory, "ai-key.bin"))).toBe(false);
    expect(existsSync(path.join(directory, "database", "paperweave.sqlite-wal"))).toBe(false);

    const inspected = await inspectBackup(directory, 7);
    expect(inspected.fileCount).toBe(5);
    expect(inspected.totalBytes).toBe(summary.totalBytes);
    const manifest = JSON.parse(readFileSync(path.join(directory, "manifest.json"), "utf8")) as { totalBytes: number; files: { path: string }[] };
    expect(manifest.files.map((file) => file.path).sort()).toEqual([
      `attachments/${attachment}`,
      "database/paperweave.sqlite",
      `originals/${original}.pdf`,
      `papers/${finalizationId}/student.pdf`,
      `papers/${finalizationId}/teacher.pdf`,
    ].sort());
    expect(manifest.totalBytes).toBe(summary.totalBytes);
  });

  it("拒绝覆盖已有备份目录", async () => {
    const data = temp("paperweave-data-");
    const { db } = seed(data, "题库 A");
    const destination = temp("paperweave-dest-");
    const service = new BackupService(db, data, "1.0.0", clock);
    await service.create(destination);
    await expect(service.create(destination)).rejects.toThrow("备份目录已存在");
    db.close();
  });

  it("检查时拒绝缺文件、校验值不符与更高数据版本", async () => {
    const data = temp("paperweave-data-");
    const { db, attachment } = seed(data, "题库 A");
    const destination = temp("paperweave-dest-");
    const service = new BackupService(db, data, "1.0.0", clock);
    const summary = await service.create(destination);
    db.close();
    const directory = path.join(destination, summary.name);

    const attachmentFile = path.join(directory, "attachments", attachment);
    writeFileSync(attachmentFile, "被篡改");
    await expect(inspectBackup(directory, 7)).rejects.toThrow("备份文件校验失败");
    rmSync(attachmentFile);
    await expect(inspectBackup(directory, 7)).rejects.toThrow("备份文件缺失");

    const manifestPath = path.join(directory, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, dataVersion: 99 }));
    await expect(inspectBackup(directory, 7)).rejects.toThrow("备份数据版本高于当前应用");
  });
});

describe("恢复暂存与切换", () => {
  it("恢复后数据库、原卷、配图与定稿 PDF 可用，定稿路径改写到当前数据目录", async () => {
    const source = temp("paperweave-source-");
    const { db, finalizationId, student } = seed(source, "题库 A");
    const destination = temp("paperweave-dest-");
    const backup = await new BackupService(db, source, "1.0.0", clock).create(destination);
    db.close();
    const backupDir = path.join(destination, backup.name);

    const target = temp("paperweave-target-");
    const targetSeed = seed(target, "题库 B");
    const service = new BackupService(targetSeed.db, target, "1.0.0", clock);
    await service.prepareRestore(backupDir);
    targetSeed.db.close();

    const result = applyPendingRestore(target);
    expect(result).toEqual({ restored: true, rolledBack: false });
    const restored = new Database(path.join(target, "paperweave.sqlite"));
    expect(restored.getSetting("marker")).toBe("题库 A");
    expect(existsSync(path.join(target, "attachments", "b".repeat(64)))).toBe(true);
    expect(existsSync(path.join(target, "originals", `${"c".repeat(64)}.pdf`))).toBe(true);
    const row = restored.read((sqlite) => sqlite.prepare("SELECT student_pdf FROM paper_finalizations WHERE id = ?").get(finalizationId)) as { student_pdf: string };
    expect(row.student_pdf).toBe(path.join(target, "papers", finalizationId, "student.pdf"));
    expect(readFileSync(row.student_pdf, "utf8")).toContain("学生卷");
    expect(student).not.toBe(row.student_pdf);
    restored.close();
    expect(existsSync(path.join(target, "restore-request.json"))).toBe(false);
  });

  it("切换后新库无法打开时回滚原库并保留可启动状态", async () => {
    const source = temp("paperweave-source-");
    const { db } = seed(source, "题库 A");
    const destination = temp("paperweave-dest-");
    const backup = await new BackupService(db, source, "1.0.0", clock).create(destination);
    db.close();

    const target = temp("paperweave-target-");
    const targetSeed = seed(target, "题库 B");
    const service = new BackupService(targetSeed.db, target, "1.0.0", clock);
    const prepared = await service.prepareRestore(path.join(destination, backup.name));
    targetSeed.db.close();
    writeFileSync(path.join(target, prepared.staging, "database", "paperweave.sqlite"), "损坏的数据库");

    const result = applyPendingRestore(target);
    expect(result.rolledBack).toBe(true);
    const old = new Database(path.join(target, "paperweave.sqlite"));
    expect(old.getSetting("marker")).toBe("题库 B");
    old.close();
    expect(existsSync(path.join(target, "restore-request.json"))).toBe(false);
  });

  it("缺少待恢复暂存目录时清掉请求并保持原库", () => {
    const target = temp("paperweave-target-");
    const { db } = seed(target, "题库 B");
    db.close();
    writeFileSync(path.join(target, "restore-request.json"), JSON.stringify({ staging: ".restore-staging-" + "a".repeat(36), previous: ".restore-previous-" + "a".repeat(36) }));
    const result = applyPendingRestore(target);
    expect(result).toEqual({ restored: false, rolledBack: false });
    expect(existsSync(path.join(target, "restore-request.json"))).toBe(false);
    const old = new Database(path.join(target, "paperweave.sqlite"));
    expect(old.getSetting("marker")).toBe("题库 B");
    old.close();
  });
});

describe("备份写入暂停", () => {
  it("维护期间拒绝设置与事务写入，结束后恢复", () => {
    const data = temp("paperweave-data-");
    const { db } = seed(data, "题库 A");
    db.beginMaintenance("备份");
    expect(() => db.setSetting("marker", "被改")).toThrow("备份进行中，暂不可编辑");
    expect(() => db.transaction((sqlite) => sqlite.prepare("DELETE FROM papers").run())).toThrow("备份进行中，暂不可编辑");
    expect(db.getSetting("marker")).toBe("题库 A");
    expect(() => db.beginMaintenance("恢复")).toThrow("已有维护操作进行中");
    db.endMaintenance();
    db.setSetting("marker", "恢复后可写");
    expect(db.getSetting("marker")).toBe("恢复后可写");
    db.close();
  });
});
