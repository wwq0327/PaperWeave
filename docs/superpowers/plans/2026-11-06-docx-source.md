# DOCX 原卷导入与整卷任务准备 实施计划

> 对应 Issue #148（#130 子任务第 1 步）。先用 DOCX 打通「导入 → 本机提取 → 整卷任务准备 → 文字视图查看」；不接模型调用、不建题、不做 Word 版式分页。

**Goal:** 考试原卷支持 `.docx`；本机提取段落顺序、表格文字、内嵌图片与公式占位，按「文档段落序号」作为来源定位准备整卷任务，并在录题工作台以文字视图查看/定位。已有 PDF 流程零回归。

**Architecture:**
- 新增 `src/main/docx.ts`：零依赖 ZIP（`node:zlib` inflateRaw）+ `word/document.xml`/`word/_rels/document.xml.rels` 解析，输出 `{ units: { unit, text }[], hasText, images: { name, unit }[], warnings }`；表格按行合并为一个单元，图片/公式以占位符保留并标待核。
- `ExamStore` 支持 `.docx` 源文件：按 SHA-256 去重、按扩展名保存为 `originals/<sha>.docx`；读取时校验哈希。`ExamStore.readFile` 返回原始文件记录，调用方按 `originalName` 判断 PDF/DOCX。
- 来源定位：`AiSourceKind = "pdf" | "docx"`（`src/shared/ai.ts`）；`planWholePaperBatches(pages, limit, sourceKind)` 与请求标记 `[原卷第 N 页]` / `[原卷第 N 段]` 区分；任务视图 `sourceKind` 驱动界面文案。旧任务无 `sourceKind` 视为 `pdf`。
- `prepareWholePaper`：按文件类型分派 `extractPdfText` / `extractDocxText`，DOCX 单元映射为 `{ page: unit, text }` 后沿用现有分批/执行/结果/建档链路。

**Tech Stack:** 既有 Electron 主进程 TS、node:zlib、Vitest、Playwright（`PAPERWEAVE_AI_FAKE`）；不新增 npm 依赖。

## 任务

1. **DOCX 解析模块**（新文件 `src/main/docx.ts` + `tests/unit/main/docx.test.ts` + 夹具 `tests/fixtures/sample.docx`）：段落/表格/图片占位/公式占位、顺序、损坏与非 ZIP、空文档、超限保护。夹具用 python-docx 生成并提交二进制。
2. **文件类型支持**（`src/main/exams.ts`、`tests/unit/main/exams.test.ts`）：`importPaper`/`attachFile` 接受 PDF 或 DOCX；扩展名校验 + ZIP 头 + `word/document.xml` 存在性；存取路径带扩展名；PDF 行为不变；旧记录兼容。
3. **来源类型贯通**（`src/shared/ai.ts`、`whole-paper-batches.ts`、`whole-paper-runner.ts`、`whole-paper-view.ts`、`src/main/whole-paper-store.ts`、`whole-paper-prepare.ts`、`ai.ts`、`ai-provider.ts`、`exam-ipc.ts`）：`sourceKind` 进入计划、请求、模型提示、任务视图；`prepareWholePaper` 分派；`exam:fileText` 对 DOCX 返回单元文字；导入对话框接受 DOCX。
4. **界面**（`src/renderer/DocxSourcePanel.tsx` 新、`IntakeWorkbench.tsx`、`WholePaperPanel.tsx`、`ExamLibrary.tsx`）：DOCX 左栏文字视图（第 N 段，点击/定位高亮）；整卷任务/结果/审核文案按来源显示页/段；导入文案含 DOCX。PDF 布局零回归。
5. **测试与收尾**：整卷相关 E2E（导入 DOCX → 准备 → 失败重试/固定响应执行 → 查看结果 → #146 建档审核），全量 `npm run check` / `npm run test:e2e` / `npm run test:packaged-app` / `test:packaged-db`；更新 HANDOFF 与 Issue。

## 约束

- 不新增依赖；不改数据版本（任务计划 JSON 兼容旧数据，新增可选 `sourceKind`）。
- DOCX 不做 Word 分页/版式；图片只做占位与清单，不落附件（后续 #150 处理）。
- 待核项必须可见；不把占位或不确定的识读当成已确认内容。
- Windows/真实模型/真实样卷验收不在本 Issue 范围。

## Self-Review

- 覆盖 Issue #148 第 1–5 条；PDF 回归由全量 E2E 与既有单测兜底；DOCX 分页差异在界面文案与服务端提示中明确为「段落」，避免把段落当页码。
