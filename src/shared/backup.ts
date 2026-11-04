export const BACKUP_FORMAT = "paperweave-backup";
export const BACKUP_FORMAT_VERSION = 1;
export const BACKUP_DATABASE_PATH = "database/paperweave.sqlite";

export interface BackupFileEntry {
  path: string;
  size: number;
  sha256: string;
}

export interface BackupManifest {
  format: typeof BACKUP_FORMAT;
  formatVersion: typeof BACKUP_FORMAT_VERSION;
  dataVersion: number;
  appVersion: string;
  createdAt: string;
  totalBytes: number;
  files: BackupFileEntry[];
}

export interface BackupSummary {
  name: string;
  createdAt: string;
  dataVersion: number;
  appVersion: string;
  fileCount: number;
  totalBytes: number;
}

const sha256 = /^[a-f0-9]{64}$/;
const attachmentPath = /^attachments\/[a-f0-9]{64}$/;
const originalPath = /^originals\/[a-f0-9]{64}\.pdf$/;
const finalizedPath = /^papers\/[a-f0-9-]{36}\/(?:student|teacher)\.pdf$/;

function safePath(path: string): boolean {
  if (path === "" || path.includes("\\") || path.includes("\0") || path.startsWith("/")) return false;
  const segments = path.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return false;
  return path === BACKUP_DATABASE_PATH || attachmentPath.test(path) || originalPath.test(path) || finalizedPath.test(path);
}

/** 备份清单是恢复的唯一入口；只接受已知结构、已知路径与当前数据版本以内的备份。 */
export function parseBackupManifest(value: unknown, currentDataVersion: number): BackupManifest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("备份清单缺失");
  const manifest = value as Record<string, unknown>;
  if (manifest.format !== BACKUP_FORMAT) throw new Error("不是 PaperWeave 备份");
  if (manifest.formatVersion !== BACKUP_FORMAT_VERSION) throw new Error("备份格式版本不受支持");
  if (typeof manifest.dataVersion !== "number" || !Number.isInteger(manifest.dataVersion) || manifest.dataVersion < 1) throw new Error("备份数据版本无效");
  if (manifest.dataVersion > currentDataVersion) throw new Error(`备份数据版本高于当前应用（备份 ${manifest.dataVersion}，当前 ${currentDataVersion}）`);
  if (typeof manifest.appVersion !== "string" || manifest.appVersion.trim() === "") throw new Error("备份应用版本无效");
  if (typeof manifest.createdAt !== "string" || Number.isNaN(Date.parse(manifest.createdAt))) throw new Error("备份创建时间无效");
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) throw new Error("备份清单缺少文件");

  const files: BackupFileEntry[] = [];
  const seen = new Set<string>();
  for (const entry of manifest.files) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw new Error("备份文件条目无效");
    const file = entry as Record<string, unknown>;
    if (typeof file.path !== "string" || file.path.includes("ai-key.bin")) throw new Error("备份不得包含密钥");
    if (!safePath(file.path)) throw new Error("备份文件路径无效");
    if (seen.has(file.path)) throw new Error("备份文件路径重复");
    seen.add(file.path);
    if (typeof file.size !== "number" || !Number.isInteger(file.size) || file.size < 0) throw new Error("备份文件大小无效");
    if (typeof file.sha256 !== "string" || !sha256.test(file.sha256)) throw new Error("备份文件校验值无效");
    files.push({ path: file.path, size: file.size, sha256: file.sha256 });
  }
  if (!seen.has(BACKUP_DATABASE_PATH)) throw new Error("备份缺少数据库快照");
  if (typeof manifest.totalBytes !== "number" || !Number.isInteger(manifest.totalBytes) || manifest.totalBytes < 0) throw new Error("备份总字节数无效");
  if (files.reduce((sum, file) => sum + file.size, 0) !== manifest.totalBytes) throw new Error("备份总字节数不一致");

  return {
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    dataVersion: manifest.dataVersion,
    appVersion: manifest.appVersion,
    createdAt: manifest.createdAt,
    totalBytes: manifest.totalBytes,
    files,
  };
}
