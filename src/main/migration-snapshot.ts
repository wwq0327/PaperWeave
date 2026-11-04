import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const MIGRATION_BACKUP_DIR = ".migration-backups";

function stamp(date: Date): string {
  const part = (value: number, width = 2) => String(value).padStart(width, "0");
  return `${date.getFullYear()}${part(date.getMonth() + 1)}${part(date.getDate())}-${part(date.getHours())}${part(date.getMinutes())}${part(date.getSeconds())}-${part(date.getMilliseconds(), 3)}`;
}

/** 迁移前快照放在库文件同目录的隐藏子目录；每次升级单独一份，不覆盖旧快照。 */
export function createMigrationSnapshot(dbPath: string, version: number, now = new Date()): string {
  const directory = join(dirname(dbPath), MIGRATION_BACKUP_DIR);
  mkdirSync(directory, { recursive: true });
  const target = join(directory, `paperweave-v${version}-${stamp(now)}.sqlite`);
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`);
  } finally {
    db.close();
  }
  return target;
}
