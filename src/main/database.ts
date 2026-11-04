import { DatabaseSync } from "node:sqlite";

const DATA_VERSION = 2;

/** 主进程持有的唯一数据库写入口；不向渲染进程暴露 SQL。 */
export class Database {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    try {
      this.migrate();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  private migrate(): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const { user_version: version } = this.db.prepare("PRAGMA user_version").get() as { user_version: number };
      if (version > DATA_VERSION) throw new Error(`不支持的数据版本：${version}`);
      if (version === 0) {
        const { count } = this.db.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").get() as { count: number };
        if (count !== 0) throw new Error("未识别的数据库，拒绝初始化");
        this.db.exec("CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT; PRAGMA user_version = 1");
      }
      if (version < 2) {
        this.db.exec("CREATE TABLE editor_drafts (id TEXT PRIMARY KEY, document TEXT NOT NULL) STRICT; PRAGMA user_version = 2");
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getSetting(key: string): string | undefined {
    return (this.db.prepare("SELECT value FROM app_settings WHERE key = ?").get(key) as { value: string } | undefined)?.value;
  }

  setSetting(key: string, value: string): void {
    this.db.prepare("INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  getDraft(): string | undefined {
    return (this.db.prepare("SELECT document FROM editor_drafts WHERE id = ?").get("m0") as { document: string } | undefined)?.document;
  }

  saveDraft(document: string): void {
    this.db.prepare("INSERT INTO editor_drafts (id, document) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET document = excluded.document").run("m0", document);
  }

  close(): void {
    this.db.close();
  }
}
