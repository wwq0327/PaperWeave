import { DatabaseSync } from "node:sqlite";

const DATA_VERSION = 4;

/** 主进程持有的唯一数据库写入口；不向渲染进程暴露 SQL。 */
export class Database {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA foreign_keys = ON");
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
      if (version < 3) {
        this.db.exec(`
          CREATE TABLE questions (id TEXT PRIMARY KEY, created_at TEXT NOT NULL) STRICT;
          CREATE TABLE question_versions (
            id TEXT PRIMARY KEY,
            question_id TEXT NOT NULL REFERENCES questions(id),
            version INTEGER NOT NULL,
            content TEXT NOT NULL,
            content_status TEXT NOT NULL CHECK (content_status IN ('draft', 'pending', 'approved')),
            answer_status TEXT NOT NULL CHECK (answer_status IN ('missing', 'pending', 'approved')),
            created_at TEXT NOT NULL,
            UNIQUE (question_id, version)
          ) STRICT;
          CREATE TABLE materials (id TEXT PRIMARY KEY, created_at TEXT NOT NULL) STRICT;
          CREATE TABLE material_versions (
            id TEXT PRIMARY KEY,
            material_id TEXT NOT NULL REFERENCES materials(id),
            version INTEGER NOT NULL,
            title TEXT NOT NULL,
            content TEXT NOT NULL,
            source TEXT NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('draft', 'pending', 'approved')),
            created_at TEXT NOT NULL,
            UNIQUE (material_id, version)
          ) STRICT;
          CREATE TABLE question_material_refs (
            question_version_id TEXT NOT NULL REFERENCES question_versions(id),
            material_version_id TEXT NOT NULL REFERENCES material_versions(id),
            PRIMARY KEY (question_version_id, material_version_id)
          ) STRICT;
          CREATE INDEX question_versions_question ON question_versions(question_id, version);
          CREATE INDEX material_versions_material ON material_versions(material_id, version);
          CREATE INDEX question_material_refs_material ON question_material_refs(material_version_id);
          PRAGMA user_version = 3
        `);
      }
      if (version < 4) {
        this.db.exec(`
          ALTER TABLE questions ADD COLUMN stage TEXT NOT NULL DEFAULT '';
          ALTER TABLE questions ADD COLUMN subject TEXT NOT NULL DEFAULT '';
          ALTER TABLE questions ADD COLUMN grade TEXT NOT NULL DEFAULT '';
          ALTER TABLE questions ADD COLUMN exam_type TEXT NOT NULL DEFAULT '';
          ALTER TABLE questions ADD COLUMN year TEXT NOT NULL DEFAULT '';
          ALTER TABLE questions ADD COLUMN source_name TEXT NOT NULL DEFAULT '';
          ALTER TABLE questions ADD COLUMN question_type TEXT NOT NULL DEFAULT '';
          ALTER TABLE question_versions ADD COLUMN search_text TEXT NOT NULL DEFAULT '';
          CREATE TABLE question_knowledge_points (
            question_id TEXT NOT NULL REFERENCES questions(id),
            value TEXT NOT NULL,
            PRIMARY KEY (question_id, value)
          ) STRICT;
          CREATE INDEX questions_classification ON questions(stage, subject, grade);
          CREATE INDEX question_knowledge_points_value ON question_knowledge_points(value);
          PRAGMA user_version = 4
        `);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** 同一连接上的事务入口；供题库等主进程模块使用，嵌套调用由调用方避免。 */
  transaction<T>(fn: (db: DatabaseSync) => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn(this.db);
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** 只读查询入口；不开始写事务。 */
  read<T>(fn: (db: DatabaseSync) => T): T {
    return fn(this.db);
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
