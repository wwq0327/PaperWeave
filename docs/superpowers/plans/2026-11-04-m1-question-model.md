# M1 题目结构与版本审核模型实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为题库建立可版本化、可审核、可检查依赖的题目数据模型与 SQLite 存储，支撑 M1 后续的检索、组卷与定稿。

**Architecture:** 题目与材料各有稳定身份，内容以不可变版本快照保存。已审核版本修改时生成新版本并回到待核；旧版本、旧引用不变。题目版本通过引用表记录所用材料版本，便于反查受影响题目。出卷就绪检查为纯函数，数据库层只负责装配数据。

**Tech Stack:** TypeScript（strict）、`node:sqlite`、Vitest。

**Spec:** Issue #28（https://github.com/wwq0327/PaperWeave/issues/28），需求依据 `docs/产品需求文档-V1.md` REQ-03。

## Global Constraints

- 测试夹具只用自制合成内容，不收录真实题目文字。
- 所有对外结构严格校验，未知字段、悬空引用、依赖成环一律拒绝，不静默丢弃。
- SQLite 仍由主进程 `Database` 单入口持有；数据版本 2 → 3，旧数据保留，更高版本拒绝打开。
- 不新增依赖，不引入 ORM。
- 本任务不做界面、不做 IPC、不做检索与组卷。

## Review Focus

- 已审核题目或材料被修改时，旧版本必须保持原内容和原状态，新版本状态为待核。
- 材料更新后，仍引用旧材料版本的题目必须全部列为受影响；已采用新版的题目不再列出。
- 答案／评分缺失不得静默放行：未确认时阻断，教师确认后通过并在教师版标注。
- 依赖只能指向同组中位置在前的小问；跨组、后向和成环引用必须拒绝。
- 二选一候选分值不同或候选不足时，总分计算必须显式报冲突，不得擅自相加。

---

### Task 1: 共享题目结构、校验与组选答计分

**Files:**
- Create: `src/shared/question.ts`
- Modify: `src/shared/document.ts`（导出 `isBlock` / `isBlockList`，`isDraft` 复用）
- Test: `tests/unit/shared/question.test.ts`

**Interfaces:**
- Produces:
  - `type ReviewStatus = "draft" | "pending" | "approved"`（草稿／待核／已审核）
  - `type AnswerStatus = "missing" | "pending" | "approved"`（待补／待核／已审核）
  - `interface SourcePosition { section: string; pdfPage: number; originalNumber: string }`
  - `interface AnswerSlot { id: string; label: string; kind: "text" | "choice" | "blank"; required: boolean; interchangeableWith: string[] }`
  - `interface AnswerKey { slotId: string | null; blocks: Block[]; variants: string[] }`
  - `interface ScoringPoint { id: string; description: string; score: number; slotIds: string[] }`
  - `interface SubQuestion { id: string; originalLabel: string; prompt: Block[]; options: { label: string; content: Block[] }[]; slots: AnswerSlot[]; answers: AnswerKey[]; scoring: ScoringPoint[]; dependsOn: string[] }`
  - `type SelectionRule = { mode: "all" } | { mode: "choose"; required: number; candidates: string[] }`
  - `interface QuestionContent { stem: Block[]; subQuestions: SubQuestion[]; materials: { materialId: string; versionId: string }[]; selection: SelectionRule; source: SourcePosition }`
  - `questionContentProblem(value: unknown): string | null`
  - `isQuestionContent(value: unknown): value is QuestionContent`
  - `hasContent(blocks: Block[]): boolean`
  - `selectionScore(content: QuestionContent): { total: number; conflict: string | null }`

- [ ] **Step 1: 写失败测试**

在 `tests/unit/shared/question.test.ts` 建立三个自制夹具并断言：

```ts
const p = (text: string): Block => ({ type: "paragraph", runs: [{ type: "text", text, style: "普通" }] });

// 二选一习作：两个候选各 30 分，选 1 篇，组总分 30
// 留言条：一个作答位置，格式 2 + 内容 2 + 表达 1 = 5 分
// 数学综合题：小问 (2) 的 dependsOn 指向 (1)

test("接受二选一习作、分项评分与依赖前问的自制结构", ...);   // isQuestionContent 三个夹具均为 true
test("二选一按同分候选计组总分 30，留言条计 5", ...);       // selectionScore().total
test("候选分值不同时返回冲突而不相加", ...);                 // conflict 非空
test("拒绝未知字段、重复标识、悬空引用和悬空依赖", ...);     // 逐项 false / problem 非空
test("拒绝指向后置或跨组小问的依赖", ...);                   // dependsOn 只能是同组更早的小问
test("拒绝非法的组选答规则", ...);                           // required 越界、candidates 不存在或重复
test("换行和空白内容不算已填写", ...);                       // hasContent 对空段落/空白公式为 false
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/unit/shared/question.test.ts`
Expected: FAIL，`src/shared/question.ts` 不存在或导出缺失。

- [ ] **Step 3: 实现**

`src/shared/document.ts` 提取并导出块校验（行为不变）：

```ts
export function isBlock(value: unknown): value is Block
export function isBlockList(value: unknown): value is Block[]
```

`src/shared/question.ts` 实现结构校验。规则要点：
- 字符串长度上限：标识 64、标签 200、说明 2000、小问号 50。
- 标识统一 `^[A-Za-z0-9_-]{1,64}$`。
- 小问 1–99 个且标识唯一；每个小问内 slot / scoring 标识唯一。
- `AnswerKey.slotId` 必须是本小问已存在的 slot；`ScoringPoint.slotIds` 同理。
- `interchangeableWith` 必须指向同小问的 slot，且互为引用。
- `dependsOn` 必须指向同组更早出现的小问，去重且不含自身（顺序即校验，天然无环）。
- `materials` 按 `materialId` 去重。
- `selection.mode === "choose"` 时 `required` 为不小于 1 的整数、不超过候选数，`candidates` 为已存在且不重复的小问标识。
- `source.pdfPage` 为 1–2000 的整数。
- `selectionScore`：`all` 为全部小问评分点之和；`choose` 取候选小问分值，候选分值不一致或候选不足时返回 `conflict`，总分保留两位小数。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/unit/shared/question.test.ts && npx vitest run tests/unit/shared/document.test.ts`
Expected: 全部 PASS。

- [ ] **Step 5: 提交并 push**

```bash
git add docs/superpowers/plans/2026-11-04-m1-question-model.md docs/README.md src/shared/question.ts src/shared/document.ts tests/unit/shared/question.test.ts
git commit -m "feat: 题目结构与组选答校验（#28）"
git push -u origin feat/28-question-model
```

---

### Task 2: 出卷就绪检查

**Files:**
- Modify: `src/shared/question.ts`
- Test: `tests/unit/shared/question.test.ts`

**Interfaces:**
- Produces:
  - `interface ReadinessInput { content: QuestionContent; contentStatus: ReviewStatus; answerStatus: AnswerStatus; confirmAnswerGap: boolean; materialStatuses: Record<string, ReviewStatus | undefined> }`
  - `interface Readiness { ready: boolean; blockers: string[]; notices: string[]; requiresAnswerConfirmation: boolean }`
  - `questionReadiness(input: ReadinessInput): Readiness`

- [ ] **Step 1: 写失败测试**

```ts
test("内容未审核时阻断并说明原因", ...);
test("必要材料缺失或未审核时阻断", ...);          // materialStatuses 无此版本 / 状态非 approved
test("小问题干为空时阻断", ...);                  // prompt 为空段落
test("仅答案或评分待补时要求教师确认", ...);        // confirmAnswerGap=false → ready=false, requiresAnswerConfirmation=true
test("教师确认答案待补后通过并给出教师版提示", ...); // confirmAnswerGap=true → ready=true, notices 非空
test("内容与材料均已审核且答案齐全时直接通过", ...); // ready=true, 无阻断
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/unit/shared/question.test.ts`
Expected: FAIL，`questionReadiness` 未导出。

- [ ] **Step 3: 实现**

阻断项按顺序收集：
1. `contentStatus !== "approved"` → `题目内容尚未审核`。
2. 每个小问 `hasContent(prompt) === false` → `小问「标签」缺少题干`。
3. `content.materials` 中每个版本：`materialStatuses[versionId]` 未定义 → `材料「materialId」缺失`；非 `approved` → `材料「materialId」尚未审核`。
4. `answerStatus !== "approved"`：先置 `requiresAnswerConfirmation = true`；未确认时阻断 `答案或评分尚未齐全，需教师确认后出卷`，确认后只加提示 `答案或评分尚未齐全，教师版将标注待补`。
`ready = blockers.length === 0`。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/unit/shared/question.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交并 push**

```bash
git add src/shared/question.ts tests/unit/shared/question.test.ts
git commit -m "feat: 出卷就绪检查与答案待补确认（#28）"
git push
```

---

### Task 3: 数据版本 3 迁移与事务入口

**Files:**
- Modify: `src/main/database.ts`
- Test: `tests/unit/main/database.test.ts`

**Interfaces:**
- Produces:
  - `Database.transaction<T>(fn: (db: DatabaseSync) => T): T`（`BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK`）
  - 数据版本 3 表：`questions`、`question_versions`、`materials`、`material_versions`、`question_material_refs`

表结构（STRICT，启用外键）：

```sql
questions(id TEXT PRIMARY KEY, created_at TEXT NOT NULL)
question_versions(id TEXT PRIMARY KEY, question_id TEXT NOT NULL REFERENCES questions(id),
  version INTEGER NOT NULL, content TEXT NOT NULL,
  content_status TEXT NOT NULL CHECK (content_status IN ('draft','pending','approved')),
  answer_status TEXT NOT NULL CHECK (answer_status IN ('missing','pending','approved')),
  created_at TEXT NOT NULL, UNIQUE(question_id, version))
materials(id TEXT PRIMARY KEY, created_at TEXT NOT NULL)
material_versions(id TEXT PRIMARY KEY, material_id TEXT NOT NULL REFERENCES materials(id),
  version INTEGER NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, source TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft','pending','approved')),
  created_at TEXT NOT NULL, UNIQUE(material_id, version))
question_material_refs(question_version_id TEXT NOT NULL REFERENCES question_versions(id),
  material_version_id TEXT NOT NULL REFERENCES material_versions(id),
  PRIMARY KEY(question_version_id, material_version_id))
```

索引：`question_versions(question_id, version)`、`material_versions(material_id, version)`、`question_material_refs(material_version_id)`。

- [ ] **Step 1: 写失败测试**

在 `tests/unit/main/database.test.ts` 更新版本断言并新增：

```ts
test("版本 2 升级到 3 时保留设置与草稿，并建好题目表", ...);
// 手工建 v2 库：settings + editor_drafts + user_version=2
// new Database(path) 后 user_version=3；旧值可读；questions 表存在
test("事务失败时回滚", ...); // transaction 内先插入再抛错，重开后表内无此行
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/unit/main/database.test.ts`
Expected: FAIL，版本仍为 2、`transaction` 不存在。

- [ ] **Step 3: 实现**

- 构造函数中 `PRAGMA foreign_keys = ON`。
- `DATA_VERSION = 3`；`version < 3` 时建表并 `PRAGMA user_version = 3`。
- `transaction` 方法如上；注意迁移本身仍用现有 BEGIN/COMMIT 流程，不与 `transaction` 嵌套。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/unit/main/database.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交并 push**

```bash
git add src/main/database.ts tests/unit/main/database.test.ts
git commit -m "feat: 数据版本 3 题目模型迁移与事务入口（#28）"
git push
```

---

### Task 4: 题目与材料的创建、版本与审核状态

**Files:**
- Create: `src/main/question-bank.ts`
- Test: `tests/unit/main/question-bank.test.ts`

**Interfaces:**
- Consumes: Task 1 的类型与校验；Task 3 的 `Database.transaction` 与表。
- Produces:
  - `interface QuestionVersionRecord { id: string; questionId: string; version: number; content: QuestionContent; contentStatus: ReviewStatus; answerStatus: AnswerStatus; createdAt: string }`
  - `interface MaterialVersionRecord { id: string; materialId: string; version: number; title: string; content: Block[]; source: string; status: ReviewStatus; createdAt: string }`
  - `class QuestionBank`：
    - `constructor(db: Database)`
    - `createQuestion(content: unknown): QuestionVersionRecord`
    - `saveQuestionVersion(questionId: string, content: unknown): QuestionVersionRecord`
    - `getQuestionVersion(versionId: string): QuestionVersionRecord | undefined`
    - `getLatestQuestionVersion(questionId: string): QuestionVersionRecord | undefined`
    - `setContentStatus(versionId: string, status: ReviewStatus): void`
    - `setAnswerStatus(versionId: string, status: AnswerStatus): void`
    - `createMaterial(input: unknown): MaterialVersionRecord`
    - `saveMaterialVersion(materialId: string, input: unknown): MaterialVersionRecord`
    - `getMaterialVersion(versionId: string): MaterialVersionRecord | undefined`
    - `setMaterialStatus(versionId: string, status: ReviewStatus): void`

状态规则：
- 新建题目／材料为 `draft` + 题目答案状态 `missing`。
- 保存新版本时：上一版本 `approved` → 新版本 `pending`；题目答案状态若原为 `approved` 同时降为 `pending`；否则继承。
- 状态只允许 `draft → pending → approved`，`pending` 可退回 `draft`（答案状态 `missing ↔ pending`）；同值幂等；`approved` 不可再改状态。

- [ ] **Step 1: 写失败测试**

新建 `tests/unit/main/question-bank.test.ts`，复用 Task 1 的二选一／留言条／数学夹具：

```ts
test("新建题目为草稿、版本 1、答案待补，重开后内容一致", ...);
test("审核通过后修改生成版本 2 并回到待核，旧版本不变", ...);
test("答案状态独立流转，已审核答案随新版本降为待核", ...);
test("拒绝非法状态跳转和已审核版本改状态", ...);
test("材料审核后修改生成新版本并待核，旧版本不变", ...);
test("拒绝非法题目内容且不留下半条记录", ...); // createQuestion 抛错后 questions 表为空
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/unit/main/question-bank.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现**

- `randomUUID()` 生成身份与版本标识，ISO 时间字符串。
- 所有写操作放入 `db.transaction`。
- 读取时 JSON 解析并用 `isQuestionContent` / `isBlockList` 校验，损坏即抛错，不返回半成品。
- `question_material_refs` 随题目版本写入并在新版本中重建。
- 题目内容中的 `materials` 引用写入前不要求材料存在？**要求存在**：保存时查询每个 `versionId` 是否存在，缺失即拒绝。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/unit/main/question-bank.test.ts && npm run check`
Expected: 全部 PASS。

- [ ] **Step 5: 提交并 push**

```bash
git add src/main/question-bank.ts tests/unit/main/question-bank.test.ts
git commit -m "feat: 题目与材料版本存储及审核流转（#28）"
git push
```

---

### Task 5: 材料影响查询、采用新版与就绪检查接入

**Files:**
- Modify: `src/main/question-bank.ts`
- Test: `tests/unit/main/question-bank.test.ts`

**Interfaces:**
- Produces（追加到 `QuestionBank`）：
  - `interface QuestionUsage { questionId: string; versionId: string; version: number; materialVersion: number }`
  - `questionsAffectedByMaterial(materialId: string): QuestionUsage[]`
  - `adoptMaterialVersion(questionId: string, materialId: string, materialVersionId: string): QuestionVersionRecord`
  - `checkReady(versionId: string, options?: { confirmAnswerGap?: boolean }): Readiness`

- [ ] **Step 1: 写失败测试**

```ts
test("一份材料被三道题引用，材料改版后三道题全部列为受影响", ...);
test("采用新版材料后生成新版本并待核，旧版本仍引用旧材料", ...);
test("已采用新版的题目不再出现在受影响列表", ...);
test("采用不存在或不属于该材料的版本被拒绝", ...);
test("就绪检查接入材料状态：材料未审核阻断，确认答案待补后通过", ...);
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/unit/main/question-bank.test.ts`
Expected: FAIL，方法不存在。

- [ ] **Step 3: 实现**

- 受影响查询：只取每题最新版本；连接引用表与材料版本；仅当所引材料版本低于该材料最新版本时计入，按题目去重，返回所引材料版本号。
- `adoptMaterialVersion`：加载题目最新版本，校验目标材料版本属于该材料且题目当前引用了该材料，替换所有该材料的版本引用后走统一的新版本保存路径。
- `checkReady`：读取版本与全部所引材料版本状态，组装 `ReadinessInput` 调用 `questionReadiness`。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/unit/main/question-bank.test.ts && npm run check`
Expected: 全部 PASS。

- [ ] **Step 5: 提交并 push**

```bash
git add src/main/question-bank.ts tests/unit/main/question-bank.test.ts
git commit -m "feat: 材料影响查询、采用新版与就绪检查（#28）"
git push
```

---

### Task 6: 文档、回归与提交 PR

**Files:**
- Modify: `docs/HANDOFF.md`
- Modify: `docs/基线记录.md`（数据版本与模型说明；若适用）
- Modify: `docs/README.md`（登记本计划）

- [ ] **Step 1: 更新交接与基线**

HANDOFF「本次接续」增加一条：Issue #28 完成内容、测试结果、未验项（无界面、M1 后续接入）。基线记录增加数据版本 3 与题目模型边界。README 文档索引加入本计划链接。

- [ ] **Step 2: 全量检查**

Run: `npm run check`
Expected: typecheck 通过，全部单测通过。

- [ ] **Step 3: 提交并 push**

```bash
git add docs/HANDOFF.md docs/基线记录.md docs/README.md
git commit -m "docs: 交接题目结构模型与数据版本 3（#28）"
git push
```

- [ ] **Step 4: 提交 PR**

PR 关联 `Refs #28`（不关闭，等待 M1 后续接入与用户复核），正文包含：改动范围、测试命令与结果、验收清单逐项状态、未验项（无界面、无平台实测）。

---

## Self-Review

- 需求覆盖：REQ-03 的题目／小问／材料／作答位置／答案／评分点、双状态、版本重审、材料影响、出卷门槛均有任务与测试；检索与组卷按 Issue 范围排除。
- 类型一致：Task 4/5 的状态与记录类型来自 Task 1/3 定义；`Readiness` 在 Task 2 定义、Task 5 使用。
- 风险项均有测试：旧版本不变、受影响列表、答案待补确认、依赖顺序、候选分值冲突。
- 比例：计划只定接口、规则与测试断言，不复写实现代码。
