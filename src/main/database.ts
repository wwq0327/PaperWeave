import { DatabaseSync } from "node:sqlite";

const DATA_VERSION = 7;

/** 主进程持有的唯一数据库写入口；不向渲染进程暴露 SQL。 */
export class Database {
  private readonly db: DatabaseSync;
  private maintenanceReason: string | null = null;

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
      if (version < 5) {
        this.db.exec(`
          CREATE TABLE basket_items (
            id TEXT PRIMARY KEY,
            question_id TEXT NOT NULL REFERENCES questions(id),
            question_version_id TEXT NOT NULL REFERENCES question_versions(id),
            sub_question_ids TEXT NOT NULL,
            primary_sub_question_id TEXT,
            position INTEGER NOT NULL,
            created_at TEXT NOT NULL
          ) STRICT;
          CREATE INDEX basket_items_position ON basket_items(position);
          CREATE TABLE papers (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            stage TEXT NOT NULL,
            subject TEXT NOT NULL,
            grade TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          ) STRICT;
          CREATE TABLE paper_sections (
            id TEXT PRIMARY KEY,
            paper_id TEXT NOT NULL REFERENCES papers(id),
            title TEXT NOT NULL,
            position INTEGER NOT NULL
          ) STRICT;
          CREATE TABLE paper_items (
            id TEXT PRIMARY KEY,
            paper_id TEXT NOT NULL REFERENCES papers(id),
            section_id TEXT NOT NULL REFERENCES paper_sections(id),
            position INTEGER NOT NULL,
            question_id TEXT NOT NULL REFERENCES questions(id),
            question_version_id TEXT NOT NULL REFERENCES question_versions(id),
            sub_question_ids TEXT NOT NULL,
            score REAL NOT NULL,
            blank_space TEXT NOT NULL CHECK (blank_space IN ('none', 'small', 'medium', 'large')),
            scoring TEXT NOT NULL,
            score_conflict_confirmations TEXT NOT NULL DEFAULT '[]',
            created_at TEXT NOT NULL
          ) STRICT;
          CREATE TABLE paper_finalizations (
            id TEXT PRIMARY KEY,
            paper_id TEXT NOT NULL REFERENCES papers(id),
            student_pdf TEXT NOT NULL,
            teacher_pdf TEXT NOT NULL,
            snapshot TEXT NOT NULL,
            student_sha256 TEXT NOT NULL,
            teacher_sha256 TEXT NOT NULL,
            created_at TEXT NOT NULL
          ) STRICT;
        `);
        const rows = this.db.prepare("SELECT id, content FROM question_versions").all() as { id: string; content: string }[];
        const update = this.db.prepare("UPDATE question_versions SET content = ? WHERE id = ?");
        for (const row of rows) update.run(this.upgradeQuestionContent(row.id, row.content), row.id);
        this.db.exec("PRAGMA user_version = 5");
      }
      if (version < 6) {
        this.db.exec(`
          CREATE TABLE exams (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            stage TEXT NOT NULL CHECK (stage IN ('小学', '初中', '高中')),
            subject TEXT NOT NULL,
            grade TEXT NOT NULL,
            region TEXT NOT NULL DEFAULT '',
            exam_type TEXT NOT NULL DEFAULT '',
            year TEXT NOT NULL DEFAULT '',
            source_name TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          ) STRICT;
          CREATE TABLE exam_sections (
            id TEXT PRIMARY KEY,
            exam_id TEXT NOT NULL REFERENCES exams(id),
            title TEXT NOT NULL,
            subject TEXT NOT NULL DEFAULT '',
            position INTEGER NOT NULL
          ) STRICT;
          CREATE INDEX exam_sections_exam ON exam_sections(exam_id, position);
          CREATE TABLE original_files (
            id TEXT PRIMARY KEY,
            sha256 TEXT NOT NULL UNIQUE,
            relative_path TEXT NOT NULL UNIQUE,
            original_name TEXT NOT NULL,
            size INTEGER NOT NULL,
            created_at TEXT NOT NULL
          ) STRICT;
          CREATE TABLE exam_originals (
            exam_id TEXT NOT NULL REFERENCES exams(id),
            file_id TEXT NOT NULL REFERENCES original_files(id),
            role TEXT NOT NULL CHECK (role IN ('paper', 'answer', 'rubric', 'answer_sheet')),
            created_at TEXT NOT NULL,
            PRIMARY KEY (exam_id, file_id, role)
          ) STRICT;
          CREATE INDEX exam_originals_file ON exam_originals(file_id, role);
          CREATE TABLE question_exams (
            question_id TEXT NOT NULL REFERENCES questions(id),
            exam_id TEXT NOT NULL REFERENCES exams(id),
            section_id TEXT REFERENCES exam_sections(id),
            created_at TEXT NOT NULL,
            PRIMARY KEY (question_id, exam_id)
          ) STRICT;
          CREATE INDEX question_exams_exam ON question_exams(exam_id, section_id);
          PRAGMA user_version = 6
        `);
      }
      if (version < 7) {
        this.db.exec(`
          CREATE TABLE import_batches (
            id TEXT PRIMARY KEY,
            kind TEXT NOT NULL,
            root TEXT NOT NULL,
            created_at TEXT NOT NULL,
            summary TEXT NOT NULL
          ) STRICT;
          CREATE TABLE import_records (
            id TEXT PRIMARY KEY,
            batch_id TEXT NOT NULL REFERENCES import_batches(id),
            kind TEXT NOT NULL,
            source_key TEXT NOT NULL,
            source_hash TEXT NOT NULL,
            target_question_id TEXT,
            target_version_id TEXT,
            decision TEXT NOT NULL,
            detail TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE (kind, source_key)
          ) STRICT;
          CREATE INDEX import_records_source ON import_records(kind, source_key);
          PRAGMA user_version = 7
        `);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** 版本 4 内容升级：按评分点合计补原分值；小问材料保守填入整组材料。失败即整次迁移回滚。 */
  private upgradeQuestionContent(versionId: string, raw: string): string {
    const fail = (): never => { throw new Error(`题目版本内容无法迁移：${versionId}`); };
    let content: unknown;
    try { content = JSON.parse(raw); } catch { return fail(); }
    if (typeof content !== "object" || content === null || Array.isArray(content)) return fail();
    const value = content as { materials?: unknown; subQuestions?: unknown };
    if (!Array.isArray(value.materials) || !Array.isArray(value.subQuestions)) return fail();
    const materialIds: string[] = [];
    for (const ref of value.materials) {
      const materialId = typeof ref === "object" && ref !== null ? (ref as { materialId?: unknown }).materialId : undefined;
      if (typeof materialId !== "string") return fail();
      materialIds.push(materialId);
    }
    const subQuestions = value.subQuestions.map((sub) => {
      if (typeof sub !== "object" || sub === null || Array.isArray(sub)) return fail();
      const item = sub as Record<string, unknown>;
      if (!Array.isArray(item.scoring)) return fail();
      let originalScore: number | null = null;
      if (item.scoring.length > 0) {
        let sum = 0;
        for (const point of item.scoring) {
          const score = typeof point === "object" && point !== null ? (point as { score?: unknown }).score : undefined;
          if (typeof score !== "number" || !Number.isFinite(score)) return fail();
          sum += score;
        }
        originalScore = Math.round(sum * 100) / 100;
      }
      return { ...item, originalScore, materialIds: [...materialIds] };
    });
    return JSON.stringify({ ...(content as object), subQuestions });
  }

  /** 同一连接上的事务入口；供题库等主进程模块使用，嵌套调用由调用方避免。 */
  transaction<T>(fn: (db: DatabaseSync) => T): T {
    this.assertWritable();
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

  /** 备份等维护操作期间拒绝新的写入，读取与数据库快照不受影响。 */
  beginMaintenance(reason: string): void {
    if (this.maintenanceReason !== null) throw new Error(`已有维护操作进行中：${this.maintenanceReason}`);
    this.maintenanceReason = reason;
  }

  endMaintenance(): void {
    this.maintenanceReason = null;
  }

  get maintenance(): string | null {
    return this.maintenanceReason;
  }

  private assertWritable(): void {
    if (this.maintenanceReason !== null) throw new Error(`${this.maintenanceReason}进行中，暂不可编辑`);
  }

  dataVersion(): number {
    return (this.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  }

  integrityCheck(): string {
    return (this.db.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check;
  }

  /** 生成一致的数据库快照；路径通过绑定参数传入，不能在事务中运行。 */
  snapshotTo(path: string): void {
    this.db.prepare("VACUUM INTO ?").run(path);
  }

  /** 只读查询入口；不开始写事务。 */
  read<T>(fn: (db: DatabaseSync) => T): T {
    return fn(this.db);
  }

  getSetting(key: string): string | undefined {
    return (this.db.prepare("SELECT value FROM app_settings WHERE key = ?").get(key) as { value: string } | undefined)?.value;
  }

  setSetting(key: string, value: string): void {
    this.assertWritable();
    this.db.prepare("INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  getDraft(): string | undefined {
    return (this.db.prepare("SELECT document FROM editor_drafts WHERE id = ?").get("m0") as { document: string } | undefined)?.document;
  }

  saveDraft(document: string): void {
    this.assertWritable();
    this.db.prepare("INSERT INTO editor_drafts (id, document) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET document = excluded.document").run("m0", document);
  }

  close(): void {
    this.db.close();
  }
}
