# M1 题库检索与选题依赖实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在题目模型之上增加分类标注、组合检索与题干关键词搜索，以及小问选题依赖分析，为 M1 的筛题与题篮提供接口。

**Architecture:** 分类标注挂在题目身份上，可变且不生成新版本；检索按每题最新版本返回。可搜索文本在建版本时只从题干与选项生成，避免答案、解析和评分进入检索。依赖分析是纯函数，返回直接/传递前问、共享材料、组选答候选与题组指令依赖。

**Tech Stack:** TypeScript（strict）、`node:sqlite`、Vitest。

**Spec:** Issue #31（https://github.com/wwq0327/PaperWeave/issues/31），需求依据 `docs/产品需求文档-V1.md` REQ-04。

## Global Constraints

- 测试夹具只用自制合成内容，不收录真实题目文字。
- 分类标注可变，不改变题目版本与内容审核状态。
- 关键词只检索题干、选项与题组指令，不检索答案、解析、评分点或材料正文。
- 检索只返回每题最新版本；历史版本状态不参与过滤。
- 数据版本 3 → 4，旧数据保留，更高版本拒绝打开。
- 本任务不做界面、IPC、题篮与组卷。

## Review Focus

- 修改分类后不能生成新版本，也不能把已审核题悄悄降为待核。
- 关键词命中不能泄漏答案、解析或评分内容。
- 审核状态过滤必须按最新版本，不能被旧版本的已审核状态误命中。
- 传递前问必须完整且按原顺序；直接前问与传递前问分别给出。
- 组选答候选与共享材料必须出现在依赖结果里，独立可用判定不能漏项。
- 分类字段的未知值、重复知识点和超长文本必须拒绝，不能静默截断。

---

### Task 1: 分类、可搜索文本与依赖分析

**Files:**
- Modify: `src/shared/question.ts`
- Modify: `tests/unit/fixtures/questions.ts`（新增阅读题组夹具）
- Test: `tests/unit/shared/question.test.ts`

**Interfaces:**
- Produces:
  - `type Stage = "小学" | "初中" | "高中"`
  - `interface Classification { stage: Stage; subject: string; grade: string; examType: string; year: string; sourceName: string; questionType: string; knowledgePoints: string[] }`
  - `classificationProblem(value: unknown): string | null`
  - `isClassification(value: unknown): value is Classification`
  - `buildSearchText(content: QuestionContent): string`
  - `interface SelectionDependencies { subQuestionId: string; directPrevious: string[]; previous: string[]; materialIds: string[]; groupCandidates: string[]; usesGroupStem: boolean; independent: boolean }`
  - `selectionDependencies(content: QuestionContent, subQuestionId: string): SelectionDependencies`

- [ ] **Step 1: 写失败测试**

在 `tests/unit/shared/question.test.ts` 增加：

```ts
test("接受完整分类并拒绝未知学段、重复知识点和未知字段", ...);
test("可搜索文本只含题组指令、小问题干与选项", ...);
// 断言包含题干/选项文字；不包含 answers、explanation、scoring 中的文字
test("传递前问按原顺序返回，直接前问单列", ...);
// 阅读题组 read-4 → [read-1, read-2, read-3]，directPrevious=[read-3]
test("共享材料与组选答候选进入依赖结果", ...);
test("无题组指令、无材料、无前问的小问判定为独立可用", ...);
test("不存在的小问标识被拒绝", ...);
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/unit/shared/question.test.ts`
Expected: FAIL，导出缺失。

- [ ] **Step 3: 实现**

- `Classification` 校验：阶段限三值；学科、年级必填非空；考试类型、学年、来源可空；题型可空；知识点 0–30 个、去重、每个 1–100 字符；所有字符串上限 200；未知字段拒绝。
- `buildSearchText`：按顺序拼接 `stem`、每个小问的 `prompt` 与 `options`（含标签），文本取段落文字与公式 LaTeX，表格取单元格，图片取 alt；合并空白，截到 20000 字符。
- `selectionDependencies`：
  - `directPrevious = sub.dependsOn`（去重、保持声明顺序）。
  - `previous` = 传递闭包，按 `content.subQuestions` 原顺序输出。
  - `materialIds` = `content.materials` 的 `materialId` 去重。
  - `groupCandidates` = 组选答为 `choose` 且当前小问是候选时，返回全部候选；否则空。
  - `usesGroupStem = hasContent(content.stem)`。
  - `independent = !usesGroupStem && previous.length === 0 && materialIds.length === 0 && groupCandidates.length === 0`。
  - 小问不存在时抛 `小问不存在`。

在夹具中新增 `readingGroup()`：四个小问 read-1…read-4，read-2 依赖 read-1，read-3 依赖 read-2，read-4 依赖 read-3；共享材料 `material-a`；题组指令非空；`selection: { mode: "all" }`。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/unit/shared/question.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交并 push**

```bash
git add docs/superpowers/plans/2026-11-04-m1-question-search.md docs/README.md src/shared/question.ts tests/unit/fixtures/questions.ts tests/unit/shared/question.test.ts
git commit -m "feat: 题目分类、可搜索文本与选题依赖分析（#31）"
git push -u origin feat/31-question-search
```

---

### Task 2: 数据版本 4 迁移

**Files:**
- Modify: `src/main/database.ts`
- Test: `tests/unit/main/database.test.ts`

**Interfaces:**
- Produces：数据版本 4；`questions` 增加 `stage`、`subject`、`grade`、`exam_type`、`year`、`source_name`、`question_type`；`question_versions` 增加 `search_text TEXT NOT NULL DEFAULT ''`；新表 `question_knowledge_points(question_id, value)` 与分类索引。

- [ ] **Step 1: 写失败测试**

更新现有版本断言为 4，并新增：

```ts
test("版本 3 升级到 4 时保留题目与审核状态，并增加分类列", ...);
// 手工建 v3 的 questions/question_versions 两表与一行数据，user_version=3
// 打开后 user_version=4；题目行仍在；PRAGMA table_info 含新列；知识点表存在
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/unit/main/database.test.ts`
Expected: FAIL，版本仍为 3 或列不存在。

- [ ] **Step 3: 实现**

`DATA_VERSION = 4`；`version < 4` 时执行 `ALTER TABLE` 与建表建索引（见 Interfaces）。迁移仍在现有事务内完成。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/unit/main/database.test.ts && npm run check`
Expected: PASS。

- [ ] **Step 5: 提交并 push**

```bash
git add src/main/database.ts tests/unit/main/database.test.ts
git commit -m "feat: 数据版本 4 分类与检索字段迁移（#31）"
git push
```

---

### Task 3: 分类录入、读取与更新

**Files:**
- Modify: `src/main/question-bank.ts`
- Test: `tests/unit/main/question-bank.test.ts`

**Interfaces:**
- Produces（追加到 `QuestionBank`）：
  - `createQuestion(content: unknown, classification?: unknown): QuestionVersionRecord`（第二参数可选，旧调用不变）
  - `getQuestionClassification(questionId: string): Classification | undefined`
  - `setClassification(questionId: string, value: unknown): Classification`

- [ ] **Step 1: 写失败测试**

```ts
test("创建题目时写入分类，读取一致；未提供分类时返回 undefined", ...);
test("修改分类不生成新版本，也不改变内容审核状态", ...);
test("修改分类时知识点整体替换", ...);
test("非法分类被拒绝且不留下部分更新", ...);
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/unit/main/question-bank.test.ts`
Expected: FAIL，方法不存在。

- [ ] **Step 3: 实现**

- `createQuestion` 在同一事务内写 `questions` 分类列与 `question_knowledge_points`。
- `setClassification` 在同一事务内更新题目行并整体替换知识点；题目不存在时报错。
- 读取时组装分类；`stage` 为空视为未标分类，返回 `undefined`；已有值与校验不符时抛“分类数据损坏”。
- `insertQuestionVersion` 同时写入 `search_text = buildSearchText(content)`。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/unit/main/question-bank.test.ts && npm run check`
Expected: PASS。

- [ ] **Step 5: 提交并 push**

```bash
git add src/main/question-bank.ts tests/unit/main/question-bank.test.ts
git commit -m "feat: 题目分类录入、读取与更新（#31）"
git push
```

---

### Task 4: 组合检索与题干关键词

**Files:**
- Modify: `src/main/question-bank.ts`
- Test: `tests/unit/main/question-bank.test.ts`

**Interfaces:**
- Produces：
  - `interface QuestionFilter { stage?: Stage; subject?: string; grade?: string; examType?: string; year?: string; sourceName?: string; questionType?: string; knowledgePoint?: string; keyword?: string; contentStatus?: ReviewStatus; answerStatus?: AnswerStatus; limit?: number }`
  - `interface QuestionSummary { questionId: string; versionId: string; version: number; contentStatus: ReviewStatus; answerStatus: AnswerStatus; classification: Classification | undefined; preview: string; source: SourcePosition; materialIds: string[] }`
  - `searchQuestions(filter?: unknown): QuestionSummary[]`

- [ ] **Step 1: 写失败测试**

```ts
test("两项以上筛选条件命中目标题，无结果返回空列表", ...);
test("关键词只命中题干与选项，不命中答案、解析或材料正文", ...);
test("审核状态按最新版本过滤，历史版本不误命中", ...);
test("分类更新后按新分类可检索到，旧分类不再命中", ...);
test("非法筛选条件被拒绝", ...); // 未知字段、limit 越界、非法审核状态
test("结果包含题干预览、来源、材料标识与最新版本状态", ...);
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/unit/main/question-bank.test.ts`
Expected: FAIL，方法不存在。

- [ ] **Step 3: 实现**

- 校验筛选对象：未知字段、非法状态、`limit` 非 1–200 整数、字符串超长均拒绝。
- SQL 只连接每题最新版本；`keyword` 用 `instr(latest.search_text, ?) > 0`；分类条件等值匹配；知识点用 `EXISTS`。
- 默认 `limit = 50`；按最新版本创建时间倒序。
- 结果解析最新版本内容，返回 `source`、`materialIds` 与 `preview`（可搜索文本前 120 字，合并空白）。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/unit/main/question-bank.test.ts && npm run check`
Expected: PASS。

- [ ] **Step 5: 提交并 push**

```bash
git add src/main/question-bank.ts tests/unit/main/question-bank.test.ts
git commit -m "feat: 组合筛选与题干关键词检索（#31）"
git push
```

---

### Task 5: 文档、回归与 PR

**Files:**
- Modify: `docs/HANDOFF.md`
- Modify: `docs/基线记录.md`

- [ ] **Step 1: 更新交接与基线**

HANDOFF 增加 Issue #31 记录（分类、检索、依赖分析、未验项）。基线记录增加数据版本 4 与检索/标注说明。

- [ ] **Step 2: 全量检查**

Run: `npm run check`
Expected: 全部通过。

- [ ] **Step 3: 提交并 push**

```bash
git add docs/HANDOFF.md docs/基线记录.md
git commit -m "docs: 交接检索与选题依赖（#31）"
git push
```

- [ ] **Step 4: 提交 PR**

PR 关联 `Refs #31` 或 `Closes #31`（全部验收项完成时关闭），正文包含改动范围、测试命令与结果、验收清单、未验项。合并前做整分支独立评审。

---

## Self-Review

- 需求覆盖：REQ-04 的组合筛选、关键词、审核状态、分类修改、依赖提示均有任务与测试；界面与题篮按 Issue 范围排除。
- 类型一致：`Classification` 在 Task 1 定义、Task 3/4 使用；`QuestionFilter`/`QuestionSummary` 在 Task 4 定义。
- 风险项均有测试：分类不改版本、关键词不泄漏答案、审核状态取最新、传递依赖顺序、材料与组选答、迁移保留。
- 比例：计划只定接口、规则与测试断言，不复写实现代码。
