# 整卷自动录题 P1 实施计划

> **For agentic workers:** 本计划按任务顺序执行；每一步先写失败测试再实现。上级方案：`docs/整卷自动录题开发方案-V2.md`；Issue：#154。

**Goal:** 文字 PDF 从一次启动到待核题目全自动，并用来源锚点与覆盖清单证明没有漏题。

**Architecture:** 先让 PDF 提取保留文本块坐标与页内偏移，再扩展 AI 协议返回来源锚点、忽略区、图表/答案来源与字段级不确定项。程序用锚点做跨批合并与覆盖对账；失败的批次自动重试一次；界面提供“自动录题并建档”单入口，覆盖不干净时不自动确认。

**Tech Stack:** Electron 主进程 + TypeScript + SQLite（数据版本 10）+ React + Playwright。

**Spec:** `docs/整卷自动录题开发方案-V2.md`、GitHub Issue #154。

## Global Constraints

- 真实题库、用户原件、AI 密钥不进代码、commit、仓库、日志；测试只用自编样本与固定响应。
- 不覆盖已审核版本；待核与异常项在教师确认前不进入正式题库。
- 学生卷/教师卷答案隔离规则不因本计划改变。
- 主进程是安全边界；渲染层禁用只是提示。
- 每个任务先写会失败的测试并实际运行看到失败，再写实现；最后跑 `npm run check`、全量 E2E、`npm run test:packaged-app`、`npm run test:packaged-db`。
- shell 环境有 `ELECTRON_RUN_AS_NODE=1`，Playwright 与打包核验需 `env -u ELECTRON_RUN_AS_NODE`。

---

### Task 1: PDF 文本块坐标与分批保留

**Files:**
- Modify: `src/main/pdf-text.ts`
- Modify: `src/shared/whole-paper-batches.ts`
- Modify: `src/main/whole-paper-store.ts`
- Test: `tests/unit/main/pdf-text.test.ts`, `tests/unit/shared/whole-paper-batches.test.ts`, `tests/unit/main/whole-paper-store.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface PdfTextBlock { start: number; end: number; text: string; x: number; y: number; width: number; height: number }
  export interface PdfTextPage { page: number; text: string; blocks: PdfTextBlock[] }
  // WholePaperPage / WholePaperFragment 增加可选 blocks?: WholePaperBlock[]
  ```

- [ ] Step 1: 在 `pdf-text.test.ts` 增加失败测试：`text.pdf` 第 1 页至少 1 个文本块，块按阅读顺序排列，`start/end` 是 Unicode 码点偏移且 `page.text.slice(start,end) === block.text`（按码点切）。
- [ ] Step 2: 运行测试，确认因 `blocks` 不存在失败。
- [ ] Step 3: 实现按 `hasEOL` 聚合文本行：块起点为行首码点、终点为行尾（不含换行），坐标取首项 `transform[4]/[5]`，宽高取首项 `width/height`；对 `trim()` 造成的页首偏移做修正。
- [ ] Step 4: 在 `whole-paper-batches.test.ts` 增加失败测试：分批后每个 fragment 的 `blocks` 均落在 `[start,end)` 内且文本与页内偏移一致；超长页被切开时块只属于覆盖它的 fragment。
- [ ] Step 5: 实现 `WholePaperBlock`、`WholePaperPage.blocks?`、`WholePaperFragment.blocks?`，在 `planWholePaperBatches` 中按字符区间裁剪 block 列表；无 blocks 的旧数据保持兼容。
- [ ] Step 6: 扩展 `whole-paper-store.ts` 的 `validState` 允许并校验 fragment 的可选 `blocks`；旧任务无该字段仍可读。
- [ ] Step 7: 运行三个测试文件，再跑 `npm run check`。

### Task 2: AI 协议扩展（锚点、忽略区、图表/答案来源、字段级不确定）

**Files:**
- Modify: `src/shared/ai.ts`
- Modify: `src/main/ai-provider.ts`
- Modify: `src/main/ai-fake.ts`
- Modify: `src/shared/ai-intake.ts`
- Modify: `src/main/ai.ts`（fake 场景集合）
- Test: `tests/unit/shared/ai.test.ts`, `tests/unit/main/ai-provider.test.ts`, `tests/unit/shared/ai-intake.test.ts`, new `tests/unit/main/ai-fake.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface AiSourceAnchor { page: number; start: number; end: number }
  export interface AiFigureRef extends AiSourceAnchor { kind: "题图" | "材料图" | "解析图"; note: string }
  export interface AiFieldNote { field: string; note: string }
  export interface AiIgnoredRange extends AiSourceAnchor { kind: "instructions" | "answer" | "blank" | "other"; note: string }
  ```
- `AiQuestion` 新增 `sourceAnchors?: AiSourceAnchor[]`、`figures?: AiFigureRef[]`、`fieldUncertain?: AiFieldNote[]`；`AiPart` 新增 `answerSource?: string`；`AiMaterialSuggestion` 新增 `sourceAnchors?: AiSourceAnchor[]`；`AiDraft` 新增 `ignored?: AiIgnoredRange[]`。
- `AiIntakeResult` 新增 `evidence: { anchors: AiSourceAnchor[]; materialAnchors: AiSourceAnchor[]; figures: AiFigureRef[]; answerSources: string[] }`。

- [ ] Step 1: `ai.test.ts` 先加失败用例：合法锚点通过；负偏移、`start>=end`、页码越界、未知 kind、未知字段被拒绝；`ignored` 上限；`answerSource` 长度；`fieldUncertain` 字段/说明非空。
- [ ] Step 2: 实现类型、允许键集合和 `isAiDraft` 校验；draft 顶层也加入允许键校验（`questions/notes/ignored`）。
- [ ] Step 3: `ai-provider.test.ts` 先断言系统提示包含 `sourceAnchors`、`ignored`、`answerSource`，以及“字符区间按页内文字码点、无法确定则省略”的要求；实现提示。
- [ ] Step 4: `ai-intake.test.ts` 先加失败用例：锚点与材料锚点进入 `evidence`；图表与字段级不确定进入 `uncertain`（含具体字段名/页码）；`answerSource` 进入 evidence；顶层答案行为保持不变。
- [ ] Step 5: 实现 `aiQuestionToIntake` 的 evidence 与不确定项映射。
- [ ] Step 6: `ai-fake.test.ts` 先断言 `ok` 响应带页内锚点、无未知字段；新增 `"clean"` 场景返回无任何异常的自编黄金题（两题、含答案/分值/锚点、无材料、无 uncertain/tags），并断言其内容稳定。
- [ ] Step 7: 实现 fake 锚点：从请求文本按 `[原卷第 N 页]` 标记切出每页文字，返回 `{page,start:0,end:页文字码点数}`；`clean` 场景复用自编黄金题数据。
- [ ] Step 8: 在 `src/main/ai.ts` 的 fake 场景集合加入 `"clean"`；跑测试与 `npm run check`。

### Task 3: 跨批合并、证据持久化与数据版本 10

**Files:**
- Create: `src/shared/whole-paper-merge.ts`
- Modify: `src/main/database.ts`
- Modify: `src/main/whole-paper-intake.ts`
- Modify: `src/shared/whole-paper-intake.ts`
- Test: new `tests/unit/shared/whole-paper-merge.test.ts`, `tests/unit/main/whole-paper-intake.test.ts`, `tests/unit/main/database.test.ts`, `tests/unit/main/backup.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface WholePaperCandidate { batchIndex: number; questionIndex: number; question: AiQuestion }
  export interface WholePaperGroup { members: WholePaperCandidate[]; question: AiQuestion }
  export function mergeWholePaperQuestions(candidates: WholePaperCandidate[]): WholePaperGroup[]
  ```
- 数据版本 10：`whole_paper_intakes` 新增 `member_keys TEXT NOT NULL DEFAULT '[]'` 与 `evidence TEXT NOT NULL DEFAULT '{}'`。
- `WholePaperIntakeItem` 新增 `memberKeys: string[]`、`evidence: WholePaperEvidence`。

- [ ] Step 1: `whole-paper-merge.test.ts` 先写失败测试：相邻批次同题号合并为一条并保留两批锚点；小问按 label 合并、答案取非空、分值取非空；非相邻批次同题号不合并；不同题号不合并。
- [ ] Step 2: 实现纯合并函数；合并后题干不同则保留较长者并加一条 uncertain；锚点/材料/图/字段不确定去重合并。
- [ ] Step 3: `whole-paper-intake.test.ts` 先加失败测试：合并题只建一条记录，`memberKeys` 保存全部成员，重复 `create` 不新增；`evidence` 持久化；旧记录无证据字段默认空。
- [ ] Step 4: 数据版本 10 迁移与版本断言更新；`approve`/`list` 读取新列；创建时按 group 的 member keys 判重（任一成员已存在则跳过整组）。
- [ ] Step 5: 运行相关测试与 `npm run check`。

### Task 4: 覆盖对账模块与接口

**Files:**
- Create: `src/shared/whole-paper-coverage.ts`
- Modify: `src/shared/whole-paper-intake.ts`（新增 issue code `anchor_missing`）
- Modify: `src/main/whole-paper-intake.ts`（`coverage(taskId)` 与 `anchor_missing`）
- Modify: `src/main/exam-ipc.ts`, `src/preload.ts`, `src/renderer/env.d.ts`, `scripts/verify-packaged-app.mjs`, `scripts/verify-packaged-install.mjs`, `tests/e2e/security.spec.ts`
- Test: new `tests/unit/shared/whole-paper-coverage.test.ts`, `tests/unit/main/whole-paper-intake.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface WholePaperCoverageGap { page: number; start: number; end: number; text: string; kind: "unassigned" | "overlap" }
  export interface WholePaperCoverageDuplicate { originalNumber: string; pages: number[] }
  export interface WholePaperCoverage {
    pages: { page: number; total: number; covered: number }[];
    gaps: WholePaperCoverageGap[];
    duplicates: WholePaperCoverageDuplicate[];
    missingAnchors: { originalNumber: string; page: number }[];
    percent: number;
  }
  export function wholePaperCoverage(input: {
    fragments: WholePaperFragment[];
    ignored: AiIgnoredRange[];
    records: { originalNumber: string; page: number; anchors: AiSourceAnchor[] }[];
  }): WholePaperCoverage
  ```
- IPC `wholePaper:intakeCoverage(examId, taskId): Promise<WholePaperCoverage>`；桥接口 83→84。

- [ ] Step 1: `whole-paper-coverage.test.ts` 先写失败测试：全页锚点 → 100%、无 gap；留白/忽略区不计 gap；未覆盖文字成为 gap 且片段可读；重叠锚点记 overlap；同题号多次出现记 duplicate；无锚点但题号能在文本行定位时不报 missing；无法定位报 missing。
- [ ] Step 2: 实现覆盖模块：从 fragments 重建每页文字与块行；模型锚点优先，否则按行首题号 `^\s*(\d{1,3})\s*[.．、]` 找起点到下一题号；合并问题/忽略区；统计非空白覆盖比例。
- [ ] Step 3: 在 `WholePaperIntake.create` 中，若题目无有效锚点且无法按题号定位，追加 `anchor_missing` 问题；`coverage(taskId)` 汇总任务全部成功批次、忽略区与记录锚点。
- [ ] Step 4: 增加 IPC/preload/env 类型与桥接口计数 84；更新 security E2E 允许列表。
- [ ] Step 5: 运行覆盖率单测、intake 单测、security E2E、packaged-app。

### Task 5: 失败自动重试

**Files:**
- Modify: `src/shared/whole-paper-runner.ts`
- Modify: `src/main/ai.ts`（传入自动重试）
- Test: `tests/unit/shared/whole-paper-runner.test.ts`, `tests/unit/main/whole-paper-store.test.ts`

**Interfaces:**
- `run(initial, signal, retryFailed = false, autoRetry = false)`；`autoRetry` 在同一轮内对所有失败批次再尝试 1 次，仍失败则保留 `failed`，不重复已成功批次。
- 主进程 `runWholePaper` 传 `autoRetry = true`。

- [ ] Step 1: runner 测试先加失败用例：第一轮第 1 批失败、第 2 批成功；自动重试只再次请求第 1 批，成功后两批 succeeded；连续失败则请求两次后仍 failed；取消后不重试。
- [ ] Step 2: 实现重试轮次（最多 1 次），保持固定错误文案与保存语义。
- [ ] Step 3: 更新主进程调用与既有 runner/store 测试，跑 `npm run check`。

### Task 6: 一键自动录题、覆盖面板与黄金样本 E2E

**Files:**
- Modify: `src/renderer/WholePaperPanel.tsx`
- Modify: `src/renderer/editor.css`（仅在需要覆盖面板样式时）
- Modify: `tests/e2e/whole-paper-intake.spec.ts`（新增一键流程用例）
- Modify: `tests/e2e/docx-source.spec.ts`（若按钮文案受影响）
- Create: `tests/fixtures/golden/text-paper.json`
- Test: `tests/e2e/whole-paper-intake.spec.ts`

- [ ] Step 1: E2E 先写失败用例（`PAPERWEAVE_AI_FAKE=clean`）：导入 `two-pages.pdf` → 点击“自动录题并建档” → 确认发送一次 → 等待“自动通过 2 题” → 整卷审核显示 2 题内容已通过 → 覆盖面板显示 100% 且无 gap。断言未填写分类表单。
- [ ] Step 2: 实现按钮与流程：准备任务 → 单次确认（服务/模型/页数/费用）→ 执行（自动重试）→ 用继承分类批量建档 → 读取覆盖报告 → 仅当覆盖 100%、无重复、无缺失锚点且全部批次成功时自动确认自动通过项；否则保留异常并提示。
- [ ] Step 3: 在任务详情增加“原卷覆盖”区域：覆盖率、页数、未归属片段/重叠/重号/缺锚点列表（最多 20 条），提供“重新对账”按钮。
- [ ] Step 4: 黄金样本 `tests/fixtures/golden/text-paper.json` 固化 `clean` 场景的题号、题干摘要、答案、分值、锚点；新增断言保证固定响应与黄金样本一致（自编样本，不代表真实模型识读）。
- [ ] Step 5: 运行单测、全量 E2E、packaged-app（桥接口 84）、packaged-db（数据版本 10）。

### Task 7: 文档、验收与合并

- [ ] 更新 `docs/HANDOFF.md` 与 `docs/整卷自动录题开发方案-V2.md` 的验证计数与 P1 状态。
- [ ] 记录未验收项：真实模型识读、真实 PDF 漏题率、DOCX 自动拆题（P2）、扫描件（P3）、Windows 实测。
- [ ] PR 关联 `Closes #154`，附 `npm run check`/E2E/packaged 证据；合并后关闭 #154，继续 P2（#155）。
