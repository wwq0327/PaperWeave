# 整卷自动录题 P2 实施计划（DOCX 自动录题与内嵌图）

> **For agentic workers:** 按任务顺序执行，先写失败测试再实现。上级方案：`docs/整卷自动录题开发方案-V2.md`；Issue：#155。

**Goal:** 一份 DOCX 只确认一次，自动按段落拆题、提取内嵌 PNG/JPEG 并绑定到题目，公式与不支持的图进入待核异常。

**Architecture:** DOCX 提取器在段落文字占位符旁给出媒体在段落内的码点区间；准备任务时把 PNG/JPEG 写入附件池，把媒体定位写进任务计划；批量建档按题目来源锚点包含的占位符绑定图片，并对公式/缺失图/不支持格式追加异常。复用 P0/P1 的锚点、覆盖、质量闸门与一键入口。

**Tech Stack:** Electron 主进程 + TypeScript + SQLite（数据版本 10 不变）+ React + Playwright。

**Spec:** `docs/整卷自动录题开发方案-V2.md`、GitHub Issue #155。

## Global Constraints

- 真实题库、用户原件、AI 密钥不进代码、commit、仓库、日志；测试只用自编样本与固定响应。
- 不覆盖已审核版本；待核与异常项在教师确认前不进入正式题库。
- 主进程是安全边界；渲染层禁用只是提示。
- 每个任务先写会失败的测试并实际运行看到失败，再写实现；最后跑 `npm run check`、全量 E2E、`npm run test:packaged-app`、`npm run test:packaged-db`。
- shell 环境有 `ELECTRON_RUN_AS_NODE=1`，Playwright 与打包核验需 `env -u ELECTRON_RUN_AS_NODE`。

---

### Task 1: 旧版 .doc 明确提示

**Files:** Modify `src/main/exams.ts`; Test `tests/unit/main/exams.test.ts`
- [ ] 先加失败测试：导入 `.doc` 报“旧版 .doc 不支持，请另存为 .docx”。
- [ ] 在 `readSourceFile` 区分 `.doc` 与其它不支持扩展名。
- [ ] 跑测试与 `npm run check`。

### Task 2: DOCX 媒体定位与内容

**Files:** Modify `src/main/docx.ts`; Test `tests/unit/main/docx.test.ts`
- [ ] 先加失败测试：`sample.docx` 的 `media` 含 `image1.png`，`unit=3`，`start/end` 对应 `[图片：image1.png]` 在段落文字中的码点区间，`mime="image/png"` 且字节非空；构造 EMF 关系时 `mime=null` 且有 `problem`。
- [ ] 保留 `images` 旧字段；新增 `media: { name; unit; start; end; mime: "image/png"|"image/jpeg"|null; data?: Buffer; problem?: string }[]`，从 ZIP `word/media/<name>` 读取并校验签名。
- [ ] 跑测试与 `npm run check`。

### Task 3: 准备任务写入附件池与媒体计划

**Files:** Modify `src/shared/whole-paper-batches.ts`, `src/main/whole-paper-store.ts`, `src/main/whole-paper-prepare.ts`, `src/main/exam-ipc.ts`; Test `tests/unit/main/whole-paper-prepare.test.ts`, `tests/unit/main/whole-paper-store.test.ts`
- [ ] 先加失败测试：DOCX 任务计划含 `docxImages`，`image1.png` 有 64 位附件 id、unit/start/end；EMF 无附件 id 且有 note；附件池可读回同字节。
- [ ] 定义 `WholePaperDocxImage`，`WholePaperBatchPlan.docxImages?`；store 校验可选字段。
- [ ] `prepareWholePaper` 增加 `Attachments` 参数，保存受支持图片；不支持或超限写 note。
- [ ] IPC 传入已有 `AttachmentStore`；跑测试与 `npm run check`。

### Task 4: 建档绑定内嵌图与公式异常

**Files:** Modify `src/shared/whole-paper-intake.ts`, `src/main/whole-paper-intake.ts`; Test `tests/unit/main/whole-paper-intake.test.ts`
- [ ] 先加失败测试：DOCX 计划中题锚点覆盖图片占位符时，建出的内容小问含该附件图片；锚点覆盖 `[公式]` 时记 `formula_review`；无附件 id 的图记 `image_review` 并阻止自动通过。
- [ ] 新增 issue code `formula_review`/`image_review`；按有效锚点（含题号回退）绑定图片，单小问挂小问、多小问挂题干；公式/缺图/不支持图追加异常。
- [ ] 跑测试与 `npm run check`。

### Task 5: DOCX 一键闭环 E2E 与文档

**Files:** Modify `src/main/ai-fake.ts`, `tests/unit/main/ai-fake.test.ts`, `tests/e2e/docx-source.spec.ts`, `docs/HANDOFF.md`, `docs/整卷自动录题开发方案-V2.md`
- [ ] 先改固定 `clean` 场景：按输入页/段各返回一题，保持 PDF 黄金样本断言不变；DOCX 样本返回第 1/2/3/5 段题。
- [ ] E2E：`sample.docx` + `clean` → 自动录题并建档 → 4 题、自动通过 3 题、第 2 段公式待核、第 3 段图片进入预览、覆盖 100%。
- [ ] 更新文档验证计数与 P2 状态；跑全量 E2E、packaged-app、packaged-db。

### Task 6: PR 与合并

- [ ] PR 关联 `Closes #155`，附验证证据；合并后关闭 #155，进入 P3（#156）。
