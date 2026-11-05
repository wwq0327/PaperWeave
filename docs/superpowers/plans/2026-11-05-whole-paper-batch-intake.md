# 整卷批量建档与整卷审核 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 整卷任务的成功批次结果一键批量建档为待核题目（整卷分类继承、AI 每题题型/知识点合并、共享材料去重建立草稿并关联），整卷审核页按原卷顺序批量确认通过；重复建档幂等、重复候选由教师显式处理、不覆盖已审核版本。

**Architecture:** 新增 `whole_paper_intakes` 表（数据版本 7→8），按 `(task_id, batch_index, question_index)` 唯一记录每题建档状态，并存构建好的题目内容 JSON 供「建修订版」复用。新增 `src/main/whole-paper-intake.ts` 主进程模块：`create` 两遍法（先跨题去重建立材料草稿，再逐题 `aiQuestionToIntake` → `buildContent` → `Intake.save(submit:true)`，逐题捕获错误不中断整批）；`list` 关联题目最新版本实时状态并用 `contentReviewProblems` 计算通过门槛；`resolve` 处理重复候选（跳过/建修订版=对已有题追加版本）。界面在 `WholePaperPanel` 增加建档区与整卷审核区；批量通过复用现有 `question:setContentStatus/setAnswerStatus` IPC 循环。

**Tech Stack:** Electron 主进程 TypeScript、SQLite（better-sqlite3 风格 `DatabaseSync`）、React 渲染层、Vitest 单测、Playwright E2E（`PAPERWEAVE_AI_FAKE` 固定响应）。

**Spec:** [整卷自动录题开发需求 V1](../../整卷自动录题开发需求-V1.md) + [Issue #146](https://github.com/wwq0327/PaperWeave/issues/146)（#130 子任务）

## Global Constraints

- 不新增依赖；复用既有结构：`aiQuestionToIntake`（src/shared/ai-intake.ts:29）、`buildContent`（src/shared/intake.ts:441，返回 `{ content: QuestionContent | null, problems: string[] }`）、`Intake.save`（src/main/intake.ts:17，新建命中重复返回 `{saved:false, duplicate}`；带 questionId 追加版本）、`contentReviewProblems`（src/shared/review.ts:22）、`bank.knowledgePointCandidates(stage, subject, AI_LIMITS.tagCount)`（src/main/ai.ts:126 同款取法）。
- 分类为 8 字段 `Classification`（stage/subject/grade/examType/year/sourceName/questionType/knowledgePoints，src/shared/question.ts:83）；状态枚举 `ReviewStatus = "draft"|"pending"|"approved"`、`AnswerStatus = "missing"|"pending"|"approved"`（src/shared/question.ts:4-6）。
- 重复定义 = 同考试 + 同分部 + 同原题号（trim 后），空原题号不判重（`ExamStore.findDuplicate`，src/main/exams.ts:236）。
- 建档即提交待核：`Intake.save({..., submit: true})`；待核项不混入正式题库，批量通过才推进 approved。
- 共享材料建议去重键 = `title.trim() + "|" + content.trim()`；材料一律建为 `draft` 状态（沿用 `bank.createMaterial`，src/main/question-bank.ts:376）。
- 幂等键 `(task_id, batch_index, question_index)`：重复建档、失败批次重跑后补建档都不得产生重复记录或覆盖已建题。
- 数据版本 `DATA_VERSION` 7→8（src/main/database.ts:4）；迁移在既有 `if (version < N)` 块链内追加，风格照抄 v7 块（src/main/database.ts:210-235）。
- 桥接口 79→82，同步 `scripts/verify-packaged-app.mjs`、`scripts/verify-packaged-install.mjs`、`tests/e2e/security.spec.ts` 中的计数断言。
- IPC 命名沿用 `wholePaper:intakeCreate/intakeList/intakeResolve`，第一参 `examId` 并校验任务归属（照 `wholePaper:detail`，src/main/exam-ipc.ts:100-106）；所有 handler 先 `permitted(event)`。
- 真实模型调用不在本计划范围（#61，需当次授权）；E2E 只用 `PAPERWEAVE_AI_FAKE` 固定响应。
- 每任务独立提交；分支 `codex/issue-146-whole-paper-batch-intake`；合并 main 已预授权（PaperWeave CLAUDE.md 授权与自动执行节）。

## Review Focus

1. 任务有进行中批次时建档——读到一半的结果不能建档，`create` 必须拒绝。
2. 单题校验失败（题干为空等 `buildContent` problems）——该题记 `failed`，其余照建，整批不中断。
3. 重复建档 / 失败批次重试成功后补建档——已有记录原样保留，只补新成功批次的题。
4. 重复候选选「建修订版」——对已有题追加版本（身份不变、版本+1、状态回落待核），已审核旧版本内容不变；选「跳过」仅改记录状态。
5. 跨题共享材料建议——只建一次材料草稿、各题都关联；重复建档不重建材料。
6. 分类继承——整卷分类为底，AI 每题 `questionType`/`knowledgePoints` 按 `aiQuestionToIntake` 规则合并（候选内并知识点、候选外进 newTags 不落库）；整卷分类校验失败拒绝建档。

---

### Task 1: 共享类型 + 数据版本 8

**Files:**
- Create: `src/shared/whole-paper-intake.ts`
- Modify: `src/main/database.ts`（DATA_VERSION 与迁移块）
- Test: `tests/unit/main/whole-paper-intake.test.ts`（建表与唯一约束，Task 2 继续用此文件）

**Interfaces:**
- Consumes: 无（纯类型 + DDL）。
- Produces:
  - `wholePaperIntakeStatuses = ["created", "duplicate", "failed", "skipped", "revised"] as const`，`WholePaperIntakeStatus`（联合类型）
  - `WholePaperIntakeSummary { created: number; duplicates: number; failed: number; existing: number; materials: number }`
  - `WholePaperIntakeItem { id: string; batchIndex: number; questionIndex: number; originalNumber: string; page: number; status: WholePaperIntakeStatus; message: string; questionId: string | null; versionId: string | null; contentStatus: ReviewStatus | null; answerStatus: AnswerStatus | null; preview: string; problems: string[]; materialIds: string[] }`
  - DB 表 `whole_paper_intakes`，列：`id TEXT PK, task_id TEXT NOT NULL, batch_index INTEGER NOT NULL, question_index INTEGER NOT NULL, original_number TEXT NOT NULL DEFAULT '', page INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, message TEXT NOT NULL DEFAULT '', question_id TEXT, version_id TEXT, content TEXT NOT NULL DEFAULT '', classification TEXT NOT NULL DEFAULT '', material_ids TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE (task_id, batch_index, question_index)`，索引 `whole_paper_intakes_task ON whole_paper_intakes(task_id)`

- [ ] **Step 1: 写失败测试**

在 `tests/unit/main/whole-paper-intake.test.ts` 建 `setup()`（照抄 `tests/unit/main/whole-paper-store.test.ts:15-24` 的 tmpdir + Database + ExamStore.importPaper 模式），第一个测试：

```ts
test("数据版本 8：整卷建档记录表带任务内唯一约束", () => {
  const { db } = setup();
  expect(db.version()).toBe(8);
  const now = new Date().toISOString();
  const insert = () => db.transaction((s) => {
    s.prepare("INSERT INTO whole_paper_intakes (id, task_id, batch_index, question_index, status, created_at, updated_at) VALUES ('r1','t',0,0,'created',?,?)").run(now, now);
  });
  insert();
  expect(() => insert()).toThrow(); // UNIQUE(task_id, batch_index, question_index)
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/unit/main/whole-paper-intake.test.ts`
Expected: FAIL（表不存在 / user_version 仍是 7）

- [ ] **Step 3: 实现类型与迁移**

`src/shared/whole-paper-intake.ts` 按 Interfaces 写出三个导出（import `ReviewStatus, AnswerStatus` from `./question`）。`src/main/database.ts`：`DATA_VERSION = 8`；在 v7 块之后追加 `if (version < 8)` 块建表 + 索引 + `PRAGMA user_version = 8`，风格照抄 v7 块。

- [ ] **Step 4: 跑测试确认通过 + 全量单测回归**

Run: `npx vitest run tests/unit/main/whole-paper-intake.test.ts && npm run check`
Expected: PASS；全量单测无回归

- [ ] **Step 5: Commit**

```bash
git add src/shared/whole-paper-intake.ts src/main/database.ts tests/unit/main/whole-paper-intake.test.ts
git commit -m "feat: 整卷建档记录表与共享类型 (#146)"
```

---

### Task 2: 主进程批量建档模块

**Files:**
- Create: `src/main/whole-paper-intake.ts`
- Test: `tests/unit/main/whole-paper-intake.test.ts`（Task 1 文件继续）

**Interfaces:**
- Consumes: Task 1 类型；`WholePaperStore.get`（src/main/whole-paper-store.ts:63）；`aiQuestionToIntake`（src/shared/ai-intake.ts:29）；`buildContent`（src/shared/intake.ts:441）；`Intake.save`（src/main/intake.ts:17）；`QuestionBank.createMaterial`（:376）、`getLatestQuestionVersion`（:233）、`knowledgePointCandidates`；`ExamStore.getExam`；`contentReviewProblems`（src/shared/review.ts:22）；`classificationProblem`、`buildSearchText`（src/shared/question.ts）；`AI_LIMITS.tagCount`（src/shared/ai.ts）。
- Produces:
  - `export class WholePaperIntake { constructor(db: Database, tasks: WholePaperStore, intake: Intake, bank: QuestionBank, exams: ExamStore) }`
  - `create(taskId: string, classification: Classification): WholePaperIntakeSummary`
  - `list(taskId: string): WholePaperIntakeItem[]`
  - `resolve(taskId: string, recordId: string, action: "skip" | "revise"): void`

`create` 行为规约：
1. `tasks.get(taskId)`；任一批次 `status === "running"` → 抛「整卷任务正在执行，请等待完成后再建档」。
2. `classificationProblem(classification)` 非空 → 抛错。
3. 已存在键集合 = `SELECT batch_index, question_index FROM whole_paper_intakes WHERE task_id = ?`；候选 = 所有 `status === "succeeded" && result` 批次中的 `result.questions`，跳过已存在键。候选为空 → 返回 `{created:0, duplicates:0, failed:0, existing: <已存在条数>, materials:0}`。
4. 每个候选先算一次 `aiQuestionToIntake(question, classification, sectionTitle, tagCandidates)`（`sectionTitle` = `exams.getExam(task.examId).sections` 中 task.sectionId 的 title；`tagCandidates` = `bank.knowledgePointCandidates(classification.stage, classification.subject, AI_LIMITS.tagCount)`），缓存 derived 结果。
5. 材料一遍：全部候选的 `derived.materials` 按去重键 `title.trim() + "|" + content.trim()` 去重，`bank.createMaterial({ title, content: [{ kind: "text", text: suggestion.content }], source: suggestion.source })`（材料 content 的纯文本块与 IntakeWorkbench.tsx:573 等价），得 `materialId`；每个候选记住自己的 materialIds。
6. 逐题：把 materialIds 写入 form（`form.materials` 追加 `{materialId, versionId, title, status}`、`subQuestions` 每个 `materialIds` 并入——等价 IntakeWorkbench.tsx:575-579）；`buildContent(form)`，`content === null` → 记录 `failed`（message = problems.join("；")）；否则 `intake.save({ examId: task.examId, sectionId: task.sectionId, content: built.content, classification: derived.form.classification, submit: true })`：`saved: true` → 记录 `created`（写 question_id/version_id）；`saved: false` → 记录 `duplicate`（question_id = duplicate.questionId，message = `原题号「${originalNumber}」已存在：第 ${duplicate.version} 版，原卷第 ${duplicate.source.pdfPage} 页`）。每题 try/catch，异常记 `failed`（message = 错误文本）。无论成败都存 `content`（built.content 或 derived 后 build 前最近可得内容——built.content 为 null 时存 `JSON.stringify(derived.form)` 之外不需要，revise 只用于 duplicate 记录，duplicate 时 built.content 必非 null）与 `classification`（`JSON.stringify(derived.form.classification)`）、`material_ids` JSON。
7. 每题一条 INSERT；不在一个大事务里（单题失败不回滚他人）。返回 summary，`materials` = 本次新建材料数。

`list` 行为规约：按 `(batch_index, question_index)` 排序返回；`question_id` 存在时取 `bank.getLatestQuestionVersion(question_id)`：`contentStatus/answerStatus/versionId` 用最新值，`preview = buildSearchText(latest.content).replace(/\s+/g, " ").trim().slice(0, 120)`；`problems = contentReviewProblems({ content: latest.content, classification: JSON.parse(row.classification), materials: <row.material_ids 每个 id 的最新材料版本 { versionId, title, status }> })`（材料最新版本用 `db.read` 查 `material_versions` 按 material_id 取 MAX(version) 一行，ReviewMaterial 形状见 src/shared/review.ts:9-19）；最新版本缺失（题被外部删除）→ `contentStatus/answerStatus = null`、`problems = ["题目已不存在"]`。

`resolve` 行为规约：行必须存在且 `status === "duplicate"`，否则抛错；`"skip"` → 改 `skipped`；`"revise"` → `JSON.parse` 行的 content/classification，`intake.save({ examId, sectionId, questionId: row.question_id, content, classification, submit: true })`（对重复题追加版本，旧版本不动），更新行 `status = "revise"→"revised"`、`version_id = saved.versionId`；`updated_at` 刷新。

- [ ] **Step 1: 写失败测试**

`tests/unit/main/whole-paper-intake.test.ts` 增测试（setup 沿用 Task 1；新增 `intakeOf(...)` 辅助构造 `Intake`/`QuestionBank`/`WholePaperIntake`，任务用 `WholePaperStore.create` + 直接 `store.save(id, rev, state)` 写入 succeeded 结果，结果题用 `AiDraft` 形状，两题共享同一条材料建议）：

```ts
test("建档：分类继承、材料去重、提交待核，重复建档幂等", () => { /* 断言 summary {created:2, materials:1}；list 2 条 created、problems 含材料未审核；listExamQuestions(exam.id) 2 题且 contentStatus pending；再次 create → created:0 existing:2，题目仍 2 */ });
test("重复候选：记录 duplicate，可跳过或建修订版，已审核旧版本不覆盖", () => { /* 预先用 Intake.save 建 originalNumber "1" 的题并 setContentStatus approved；建档 → duplicates:1 created:1；resolve skip → skipped；另一任务 resolve revise → 该题版本+1、内容换为 AI 内容、状态回落 pending、第 1 版内容不变 */ });
test("单题校验失败记 failed 且不中断整批；进行中批次拒绝建档", () => { /* 第二题 stem 全空且 parts 全空 → buildContent problems → failed:1 created:1；批次 status 改 running → create 抛错 */ });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/unit/main/whole-paper-intake.test.ts`
Expected: FAIL（`WholePaperIntake` 未定义）

- [ ] **Step 3: 实现 `src/main/whole-paper-intake.ts`**

按上述规约实现。INSERT/SELECT/UPDATE 用 `db.transaction`/`db.read`（模式见 src/main/exams.ts:135,181）；时间戳 `new Date().toISOString()`；行 id `randomUUID()`。

- [ ] **Step 4: 跑测试确认通过 + 全量回归**

Run: `npx vitest run tests/unit/main/whole-paper-intake.test.ts && npm run check`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/whole-paper-intake.ts tests/unit/main/whole-paper-intake.test.ts
git commit -m "feat: 整卷识别结果批量建档与重复候选处理 (#146)"
```

---

### Task 3: IPC 与 preload 桥

**Files:**
- Modify: `src/main/exam-ipc.ts`（在 `wholePaper:detail` 之后加三个 handler；`registerExamIpc` 形参增 `wholeIntake: WholePaperIntake`）
- Modify: `src/main/main.ts`（或实际装配 `Intake`/`WholePaperStore` 的入口文件；`new WholePaperIntake(...)` 并传入注册函数）
- Modify: `src/preload.ts`、`src/renderer/env.d.ts`
- Modify: `scripts/verify-packaged-app.mjs`、`scripts/verify-packaged-install.mjs`、`tests/e2e/security.spec.ts`（桥计数 79→82）

**Interfaces:**
- Consumes: Task 2 的 `WholePaperIntake`。
- Produces:
  - channel `wholePaper:intakeCreate(examId, taskId, classification)` / `wholePaper:intakeList(examId, taskId)` / `wholePaper:intakeResolve(examId, taskId, recordId, action)`；归属校验照 `wholePaper:detail`（任务 examId 不符抛「整卷任务不属于该考试」）。
  - preload 平铺三接口：`createWholePaperIntake(examId, taskId, classification)`、`listWholePaperIntakes(examId, taskId)`、`resolveWholePaperIntake(examId, taskId, recordId, action)`；env.d.ts 同步类型。

- [ ] **Step 1: 写失败测试**

`tests/e2e/security.spec.ts` 桥计数断言 79→82（该文件已有断言，改数字即为「失败测试」：preload 尚未加，计数不对）。不改 security.spec 也行——用 Step 3 后的 E2E 兜底；本 Task 以 Task 5 的 E2E 为验证主体，此处先把三个脚本/文件中的计数改掉。

- [ ] **Step 2: 跑相关 E2E 确认失败**

Run: `npx playwright test tests/e2e/security.spec.ts`
Expected: FAIL（桥接口数 79 ≠ 82）

- [ ] **Step 3: 实现 handler、装配、preload 与类型**

按 Interfaces 实现；handler 内 `text()` 校验字符串参数（照 exam-ipc.ts 现有用法）；`wholePaper:intakeResolve` 的 action 校验仅允许 `"skip" | "revise"`。

- [ ] **Step 4: 跑 security E2E 确认通过**

Run: `npx playwright test tests/e2e/security.spec.ts`
Expected: PASS（其余 E2E 在 Task 5 后全量跑）

- [ ] **Step 5: Commit**

```bash
git add src/main/exam-ipc.ts src/main/main.ts src/preload.ts src/renderer/env.d.ts scripts/verify-packaged-app.mjs scripts/verify-packaged-install.mjs tests/e2e/security.spec.ts
git commit -m "feat: 整卷建档与审核 IPC 及桥接口 (#146)"
```

---

### Task 4: 界面——建档区与整卷审核区

**Files:**
- Modify: `src/renderer/WholePaperPanel.tsx`（93 行 → 约 300 行）
- Test: `tests/e2e/whole-paper-intake.spec.ts`（Task 5 写；本 Task 先用现有 `tests/e2e/intake-ai.spec.ts` 回归确认面板无破环）

**Interfaces:**
- Consumes: Task 3 三个桥接口；既有 `setContentStatus/setAnswerStatus` 桥（preload 已暴露）；`detail.results`（`WholePaperTaskDetail`，src/shared/whole-paper-view.ts:13）。
- Produces: 无新模块；WholePaperPanel 内部新增：
  - 建档区 `region aria-label="整卷批量建档"`：分类 8 字段表单（学段 select 小学/初中/高中，其余 text；知识点逗号分隔 parsePoints 同款）；计数行（成功 N 批 M 题、材料建议 K 条、失败批提示）；「批量建档」→ 确认区 `region aria-label="确认批量建档"`（复数明细 + 「确认建档」/「取消」）。
  - 审核区 `region aria-label="整卷审核"`：筛选 chips（全部/待核/重复候选/失败/已通过）；每行：checkbox（仅 `status ∈ created|revised` 且 `problems.length === 0` 可选）、`第N批 · 原卷第N页 · 题N`、preview、实时状态徽章（contentStatus/answerStatus：待核/已通过）、problems 列表、「定位原页」（复用 `onPageChange(item.page)`）、duplicate 行「跳过」「建修订版」按钮；「批量确认通过(N)」按钮。

批量通过逻辑：对选中项逐个 `setContentStatus(item.versionId, "approved")`，`item.answerStatus === "pending"` 时再 `setAnswerStatus(item.versionId, "approved")`，完成后刷新 `listWholePaperIntakes`；单项失败用页面错误条提示但不中断。

- [ ] **Step 1: 跑现有 E2E 确认基线绿**

Run: `npx playwright test tests/e2e/intake-ai.spec.ts`
Expected: PASS（改动前基线）

- [ ] **Step 2: 实现建档区与审核区**

按 Interfaces 实现；分类表单默认值 `{ stage: "初中", subject: "", grade: "", examType: "", year: "", sourceName: "", questionType: "", knowledgePoints: [] }`；建档成功/失败消息用页面 `role="status"`/`role="alert"` 条。

- [ ] **Step 3: 跑基线 E2E 确认无回归 + check**

Run: `npx playwright test tests/e2e/intake-ai.spec.ts && npm run check`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/renderer/WholePaperPanel.tsx
git commit -m "feat: 录题工作台整卷批量建档与整卷审核界面 (#146)"
```

---

### Task 5: E2E 全链路

**Files:**
- Create: `tests/e2e/whole-paper-intake.spec.ts`

**Interfaces:**
- Consumes: Task 3/4 的界面与桥；`tests/e2e/intake-ai.spec.ts:50-64` 的 `importExam` 模式（dialog mock + `two-pages.pdf` 夹具）；`tests/e2e/intake-ai.spec.ts:158-231` 的准备/发送/轮询模式；`tests/unit/fixtures/questions` 的题目夹具；`PAPERWEAVE_AI_FAKE=ok`。

- [ ] **Step 1: 写失败测试**

三个用例：

```ts
test("整卷建档：分类继承、整卷审核批量通过与材料门槛", async () => {
  /* seedTagCandidates；fake ok；导入→准备→发送→等已处理；建档区填分类（学科 语文）→确认建档
     → 见「已建档 2 题」；审核区 2 行待核、problems 含材料未审核、checkbox 禁用
     → 题目审核页把「固定响应材料」推进到已审核 → 回来 checkbox 可用 → 全选批量通过
     → 两行徽章变已通过 */
});
test("重复建档幂等：再次建档不产生重复题", async () => {
  /* 上流程后再次确认建档 → 见「现有 2 题」类提示；本卷题目列表仍 2 题 */
});
test("重复候选：同卷同号记录候选，建修订版追加版本且不覆盖旧版", async () => {
  /* 启动前 node 侧建考试+分部+originalNumber「1」的已审核题；UI 导入同一 PDF 返回已有考试
     → 准备→发送→建档 → 审核区：题 1 重复候选（含跳过/建修订版）、题 2 已建
     → 建修订版 → 行变修订版待核；本卷题目共 2 题（非 3） */
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx playwright test tests/e2e/whole-paper-intake.spec.ts`
Expected: FAIL（无建档区/审核区）

- [ ] **Step 3: 实现并跑通**

Task 4 已实现界面；本步修测试与实现间的不一致直至通过。注意 `题目审核` 页材料推进的按钮名与步数沿用 `tests/e2e/review.spec.ts` 的既有用法。

- [ ] **Step 4: 跑整卷相关 E2E 全量**

Run: `npx playwright test tests/e2e/whole-paper-intake.spec.ts tests/e2e/intake-ai.spec.ts tests/e2e/review.spec.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tests/e2e/whole-paper-intake.spec.ts
git commit -m "test: 整卷批量建档与审核端到端用例 (#146)"
```

---

### Task 6: 全量验证与收尾

**Files:**
- Modify: `docs/HANDOFF.md`（接续摘要更新）
- Modify: GitHub Issue #146 / #130（验收状态评论）

**Interfaces:**
- Consumes: Task 1-5 全部产出。

- [ ] **Step 1: 重建打包产物并跑打包侧测试**

Run: `npm run package && npm run test:packaged-app && npm run test:packaged-db`
Expected: PASS（桥接口 82 个等全绿；`test-packaged-upgrade` 走 v6→v8 迁移链，若脚本内有硬编码版本号断言一并修正）

- [ ] **Step 2: 全量检查与 E2E**

Run: `npm run check && npm run test:e2e`
Expected: PASS（单测、类型、全部 E2E）

- [ ] **Step 3: 更新 HANDOFF 并提交**

接续摘要记录：#146 完成内容、验证项与计数（253+ 单测、E2E N 项、packaged-app 82 接口）；#130 保持开放（剩 DOCX、扫描、跨批合并、真实验收）。

```bash
git add docs/HANDOFF.md
git commit -m "docs: 更新整卷批量建档接续摘要 (#146)"
```

- [ ] **Step 4: PR、合并与 Issue 更新**

```bash
git push -u origin codex/issue-146-whole-paper-batch-intake
gh pr create --title "feat: 整卷识别结果批量建档与整卷审核 (#146)" --body "<证据与验收状态：单测/E2E/packaged 全绿；#146 验收清单逐条；#130 保持开放>"
gh pr merge --squash  # 仓库惯例为 merge commit（保留逐条提交），按最近 PR #144 惯例用 merge
```

GitHub：勾选 Issue #146 验收清单并评论证据后关闭 #146；在 #130 评论进度；其余 Issue 不动。

---

## Self-Review 记录

- 需求覆盖：#146 范围 5 条——参数继承（Task 2 规约 4/6）、批量建档+重复候选（Task 2）、持久化幂等（Task 1 表 + Task 2 规约 3）、整卷审核页（Task 4）、异常集中列出（Task 4 筛选 chips + failed 行）；验收清单「待核不混入、重跑/重复导入不产生重复、不覆盖已审核」由 Task 2 单测与 Task 5 E2E 钉住。DOCX/扫描/真实模型不在本计划（另立）。
- Review Focus 6 条均有归属测试：1→Task 2 单测（进行中拒绝）、2→Task 2 单测（failed 不中断）、3→Task 2 单测 + Task 5 幂等用例、4→Task 2 单测（revise 版本断言）、5→Task 2 单测（materials:1）、6→Task 5 用例 1（分类继承断言）。
- 类型一致性：`WholePaperIntakeSummary`/`Item` 字段在 Task 1/2/4/5 间一致；`versionId` 语义在 list 中解析为最新版本，批量通过用它审批。
