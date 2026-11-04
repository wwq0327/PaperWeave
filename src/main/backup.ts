import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  BACKUP_DATABASE_PATH,
  BACKUP_FORMAT,
  BACKUP_FORMAT_VERSION,
  parseBackupManifest,
  type BackupFileEntry,
  type BackupManifest,
  type BackupSummary,
} from "../shared/backup";
import { Database } from "./database";

const REQUEST_FILE = "restore-request.json";
const DATA_ITEMS = ["paperweave.sqlite", "paperweave.sqlite-wal", "paperweave.sqlite-shm", "attachments", "originals", "papers"];
const FINALIZATION_ID = /^[a-f0-9-]{36}$/;
const ATTACHMENT = /^[a-f0-9]{64}$/;
const ORIGINAL = /^[a-f0-9]{64}\.pdf$/;
const RESTORE_DIR = /^\.restore-(?:staging|previous)-[a-f0-9-]{36}$/;

export type { BackupSummary };

export interface PreparedRestore {
  staging: string;
  summary: BackupSummary;
}

function stamp(date: Date): string {
  const value = (number: number) => String(number).padStart(2, "0");
  return `${date.getFullYear()}${value(date.getMonth() + 1)}${value(date.getDate())}-${value(date.getHours())}${value(date.getMinutes())}${value(date.getSeconds())}`;
}

function regularFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

function realDirectory(path: string): boolean {
  try {
    const stat = lstatSync(path);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

async function hashFile(path: string): Promise<{ size: number; sha256: string }> {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(path)) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    hash.update(data);
    size += data.length;
  }
  return { size, sha256: hash.digest("hex") };
}

async function copyWithHash(source: string, destination: string): Promise<{ size: number; sha256: string }> {
  mkdirSync(dirname(destination), { recursive: true });
  const hash = createHash("sha256");
  let size = 0;
  await pipeline(
    createReadStream(source),
    new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        hash.update(chunk);
        size += chunk.length;
        callback(null, chunk);
      },
    }),
    createWriteStream(destination, { flags: "wx" }),
  );
  return { size, sha256: hash.digest("hex") };
}

async function readManifest(directory: string, currentDataVersion: number): Promise<BackupManifest> {
  const file = join(directory, "manifest.json");
  if (!regularFile(file)) throw new Error("备份清单缺失");
  try {
    return parseBackupManifest(JSON.parse(readFileSync(file, "utf8")), currentDataVersion);
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("备份清单无法解析");
    throw error;
  }
}

function summaryOf(manifest: BackupManifest, name: string): BackupSummary {
  return {
    name,
    createdAt: manifest.createdAt,
    dataVersion: manifest.dataVersion,
    appVersion: manifest.appVersion,
    fileCount: manifest.files.length,
    totalBytes: manifest.totalBytes,
  };
}

async function verifyManifest(directory: string, currentDataVersion: number): Promise<{ manifest: BackupManifest; summary: BackupSummary }> {
  if (!realDirectory(directory)) throw new Error("备份目录无效");
  const manifest = await readManifest(directory, currentDataVersion);
  for (const entry of manifest.files) {
    const file = join(directory, entry.path);
    if (!regularFile(file)) throw new Error(`备份文件缺失：${entry.path}`);
    const actual = await hashFile(file);
    if (actual.size !== entry.size || actual.sha256 !== entry.sha256) throw new Error(`备份文件校验失败：${entry.path}`);
  }
  return { manifest, summary: summaryOf(manifest, basename(directory)) };
}

/** 独立校验备份：清单结构、版本、路径、文件存在性与校验值。 */
export async function inspectBackup(directory: string, currentDataVersion: number): Promise<BackupSummary> {
  return (await verifyManifest(directory, currentDataVersion)).summary;
}

export class BackupService {
  constructor(
    private readonly db: Database,
    private readonly userData: string,
    private readonly appVersion: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async create(destinationParent: string): Promise<BackupSummary> {
    if (!realDirectory(destinationParent)) throw new Error("备份位置无效");
    const createdAt = this.now();
    const name = `PaperWeave-backup-${stamp(createdAt)}`;
    const destination = join(destinationParent, name);
    if (existsSync(destination)) throw new Error("备份目录已存在");
    const temporary = join(destinationParent, `.${name}.tmp-${randomUUID()}`);
    this.db.beginMaintenance("备份");
    try {
      mkdirSync(temporary, { recursive: true });
      const files: BackupFileEntry[] = [];
      const snapshot = join(temporary, BACKUP_DATABASE_PATH);
      mkdirSync(dirname(snapshot), { recursive: true });
      this.db.snapshotTo(snapshot);
      const compact = new Database(snapshot);
      try {
        if (compact.integrityCheck() !== "ok") throw new Error("备份数据库完整性检查失败");
        compact.transaction((sqlite) => {
          sqlite.prepare("DELETE FROM app_settings WHERE key IN ('pdf.pending', 'paper.pending')").run();
        });
      } finally {
        compact.close();
      }
      files.push({ path: BACKUP_DATABASE_PATH, ...(await hashFile(snapshot)) });

      const attachments = join(this.userData, "attachments");
      if (realDirectory(attachments)) {
        for (const entry of readdirSync(attachments).sort()) {
          if (!ATTACHMENT.test(entry) || !regularFile(join(attachments, entry))) continue;
          files.push({ path: `attachments/${entry}`, ...(await copyWithHash(join(attachments, entry), join(temporary, "attachments", entry))) });
        }
      }

      const refs = this.db.read((sqlite) => sqlite.prepare("SELECT relative_path FROM original_files").all() as { relative_path: string }[]);
      for (const ref of refs) {
        if (!/^originals\/[a-f0-9]{64}\.pdf$/.test(ref.relative_path) || !regularFile(join(this.userData, ref.relative_path))) {
          throw new Error(`原卷文件缺失：${ref.relative_path}`);
        }
      }
      const originals = join(this.userData, "originals");
      if (realDirectory(originals)) {
        for (const entry of readdirSync(originals).sort()) {
          if (!ORIGINAL.test(entry) || !regularFile(join(originals, entry))) continue;
          files.push({ path: `originals/${entry}`, ...(await copyWithHash(join(originals, entry), join(temporary, "originals", entry))) });
        }
      }

      const finalizations = this.db.read((sqlite) => sqlite.prepare("SELECT id, student_pdf, teacher_pdf FROM paper_finalizations ORDER BY id").all() as { id: string; student_pdf: string; teacher_pdf: string }[]);
      for (const row of finalizations) {
        if (!FINALIZATION_ID.test(row.id)) throw new Error(`定稿标识无效：${row.id}`);
        for (const [kind, source] of [["student", row.student_pdf], ["teacher", row.teacher_pdf]] as const) {
          if (!regularFile(source)) throw new Error(`定稿 PDF 缺失：${row.id}/${kind}`);
          files.push({ path: `papers/${row.id}/${kind}.pdf`, ...(await copyWithHash(source, join(temporary, "papers", row.id, `${kind}.pdf`))) });
        }
      }

      const manifest: BackupManifest = {
        format: BACKUP_FORMAT,
        formatVersion: BACKUP_FORMAT_VERSION,
        dataVersion: this.db.dataVersion(),
        appVersion: this.appVersion,
        createdAt: createdAt.toISOString(),
        totalBytes: files.reduce((sum, file) => sum + file.size, 0),
        files,
      };
      writeFileSync(join(temporary, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
      if (existsSync(destination)) throw new Error("备份目录已存在");
      renameSync(temporary, destination);
      return summaryOf(manifest, name);
    } catch (error) {
      rmSync(temporary, { recursive: true, force: true });
      throw error;
    } finally {
      this.db.endMaintenance();
    }
  }

  /** 校验并准备恢复：复制到独立暂存目录，迁移、改写定稿路径，最后写入待恢复请求。 */
  async prepareRestore(source: string): Promise<PreparedRestore> {
    const request = join(this.userData, REQUEST_FILE);
    if (existsSync(request)) throw new Error("已有待恢复的备份，请重启应用完成或取消");
    const { manifest, summary } = await verifyManifest(source, this.db.dataVersion());
    const id = randomUUID();
    const stagingName = `.restore-staging-${id}`;
    const previousName = `.restore-previous-${id}`;
    const staging = join(this.userData, stagingName);
    this.db.beginMaintenance("恢复");
    try {
      mkdirSync(staging, { recursive: true });
      for (const entry of manifest.files) {
        const copied = await copyWithHash(join(source, entry.path), join(staging, entry.path));
        if (copied.size !== entry.size || copied.sha256 !== entry.sha256) throw new Error(`备份文件校验失败：${entry.path}`);
      }
      const staged = new Database(join(staging, BACKUP_DATABASE_PATH));
      try {
        if (staged.integrityCheck() !== "ok") throw new Error("备份数据库完整性检查失败");
        const finalizations = staged.read((sqlite) => sqlite.prepare("SELECT id FROM paper_finalizations").all() as { id: string }[]);
        for (const row of finalizations) {
          if (!FINALIZATION_ID.test(row.id)) throw new Error(`备份定稿标识无效：${row.id}`);
        }
        staged.transaction((sqlite) => {
          const update = sqlite.prepare("UPDATE paper_finalizations SET student_pdf = ?, teacher_pdf = ? WHERE id = ?");
          for (const row of finalizations) {
            update.run(join(this.userData, "papers", row.id, "student.pdf"), join(this.userData, "papers", row.id, "teacher.pdf"), row.id);
          }
        });
        const refs = staged.read((sqlite) => sqlite.prepare("SELECT relative_path FROM original_files").all() as { relative_path: string }[]);
        for (const ref of refs) {
          if (!/^originals\/[a-f0-9]{64}\.pdf$/.test(ref.relative_path) || !regularFile(join(staging, ref.relative_path))) {
            throw new Error(`备份原卷文件缺失：${ref.relative_path}`);
          }
        }
      } finally {
        staged.close();
      }
      writeFileSync(request, JSON.stringify({ staging: stagingName, previous: previousName }), { flag: "wx" });
      return { staging: stagingName, summary };
    } catch (error) {
      rmSync(staging, { recursive: true, force: true });
      throw error;
    } finally {
      this.db.endMaintenance();
    }
  }
}

function restoreRequest(userData: string): { staging: string; previous: string } | null {
  const file = join(userData, REQUEST_FILE);
  if (!regularFile(file)) {
    rmSync(file, { force: true });
    return null;
  }
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    if (typeof value.staging !== "string" || typeof value.previous !== "string") throw new Error("invalid");
    if (!RESTORE_DIR.test(value.staging) || !RESTORE_DIR.test(value.previous)) throw new Error("invalid");
    return { staging: value.staging, previous: value.previous };
  } catch {
    rmSync(file, { force: true });
    return null;
  }
}

function moveItems(source: string, destination: string): void {
  for (const item of DATA_ITEMS) {
    const from = join(source, item);
    if (!existsSync(from)) continue;
    const to = join(destination, item);
    rmSync(to, { recursive: true, force: true });
    renameSync(from, to);
  }
}

function rollback(previous: string, userData: string, removeExtras: boolean): void {
  for (const item of DATA_ITEMS) {
    const from = join(previous, item);
    const to = join(userData, item);
    if (existsSync(from)) {
      rmSync(to, { recursive: true, force: true });
      renameSync(from, to);
    } else if (removeExtras) {
      rmSync(to, { recursive: true, force: true });
    }
  }
}

function opens(path: string): boolean {
  if (!regularFile(path)) return false;
  try {
    const db = new Database(path);
    const ok = db.integrityCheck() === "ok";
    db.close();
    return ok;
  } catch {
    return false;
  }
}

/** 启动前应用待恢复请求；切换后新库打不开则回滚原库，验证前原库一直保留。 */
export function applyPendingRestore(userData: string): { restored: boolean; rolledBack: boolean } {
  const request = restoreRequest(userData);
  if (request === null) return { restored: false, rolledBack: false };
  const staging = join(userData, request.staging);
  const previous = join(userData, request.previous);
  const requestFile = join(userData, REQUEST_FILE);
  const cleanup = () => {
    for (const target of [staging, previous, requestFile]) {
      try {
        rmSync(target, { recursive: true, force: true });
      } catch {
        // 清理失败不阻断启动；数据已验证可用，残留目录留待下次处理。
      }
    }
  };

  if (realDirectory(previous)) {
    if (!regularFile(join(previous, ".complete"))) {
      rollback(previous, userData, false);
      cleanup();
      return { restored: false, rolledBack: true };
    }
    if (opens(join(userData, "paperweave.sqlite"))) {
      cleanup();
      return { restored: true, rolledBack: false };
    }
    rollback(previous, userData, true);
    cleanup();
    return { restored: false, rolledBack: true };
  }

  if (!realDirectory(staging) || !regularFile(join(staging, BACKUP_DATABASE_PATH))) {
    rmSync(staging, { recursive: true, force: true });
    rmSync(requestFile, { force: true });
    return { restored: false, rolledBack: false };
  }

  try {
    mkdirSync(previous, { recursive: true });
    moveItems(userData, previous);
    writeFileSync(join(previous, ".complete"), "", { flag: "wx" });
    moveItems(staging, userData);
    const stagedDb = join(staging, BACKUP_DATABASE_PATH);
    if (regularFile(stagedDb)) renameSync(stagedDb, join(userData, "paperweave.sqlite"));
  } catch {
    rollback(previous, userData, false);
    cleanup();
    return { restored: false, rolledBack: true };
  }

  if (opens(join(userData, "paperweave.sqlite"))) {
    cleanup();
    return { restored: true, rolledBack: false };
  }
  rollback(previous, userData, true);
  cleanup();
  return { restored: false, rolledBack: true };
}
