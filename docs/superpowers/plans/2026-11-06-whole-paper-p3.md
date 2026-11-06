# 整卷自动录题 P3：扫描／混合 PDF、自动裁图与答案关联 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 扫描或混合 PDF 只设置一次整卷参数并启动一次，自动逐页分流识读、按归一化坐标本机裁图、把同卷答案按题号与小问关联，异常才进入待核队列。

**Architecture:** 渲染进程用 PDF.js 把无文字页渲染成固定比例 JPEG（每页一张）并在准备任务时交给主进程；主进程把页面图写入附件池，按页生成 `scan` 批次，原有文字页仍按字符分批。执行器对扫描批次调用图像模型，模型返回归一化 `scanAreas`；同一题跨页时用现有相邻批次合并逻辑拼接。建档时主进程用 Electron `nativeImage` 按坐标裁图并绑定到题目，坐标不经网络回传。答案／评分 PDF 同样逐页分流为 `answer-text` / `answer-scan` 批次，由独立答案提示词抽取“原题号＋小问号＋答案”，建档时唯一匹配才填入，歧义、缺号与未匹配进入异常和覆盖报告。

**Tech Stack:** Electron 45 `nativeImage`、PDF.js 6、React 19、TypeScript、Vitest、Playwright。

**Spec:** [整卷自动录题开发方案 V2](../../整卷自动录题开发方案-V2.md) P3 节；[Issue #156](https://github.com/wwq0327/PaperWeave/issues/156)。

## Global Constraints

- 真实题库、用户原件、模型密钥不进代码、commit、仓库或日志；自动化测试只用 `tests/fixtures/` 自制样本与固定响应。
- 扫描页图像只按授权范围发送；坐标与整页图不离开本机，裁图结果保存在本机附件池。
- 未识别页、失败批次、答案不唯一、裁图失败必须阻断自动通过并进入异常队列，不静默丢失。
- 学生卷不得泄露答案的既有约束不变；答案关联只写题库内容，不改变学生卷生成规则。
- 旧任务数据缺少 `kind` / `answerFiles` / `scanAreas` 时按文字 PDF 兼容读取，不提升数据库版本。
- 依赖版本保持 M0 固定值；P3 不新增依赖。

## Review Focus

- 完全扫描 PDF：每一页都必须有页面图并形成扫描批次；缺图、页面顺序错乱、空白页不得被当成成功。
- 混合 PDF：文字页与扫描页按原页顺序交错，跨页题在相邻批次合并后 `scanAreas` 覆盖两页，裁图不能只取第一页。
- 坐标边界：`x/y/width/height` 越界、和为 1、极小区域、页面旋转/不同缩放下的像素换算，裁图必须夹紧或标异常，不能生成空图。
- 答案错配：同题号同小问多条答案、一条答案被多题复用、答案文件缺号，必须分别报歧义／复用／未匹配，不能任选一条。
- 未授权发送：未选答案文件时不发送答案页；答案文件只有明确角色 `answer/rubric` 时读取；确认文案必须列出图像与答案批次。

---

### Task 1: AI 协议增加归一化扫描区域与答案草稿

**Files:**
- Modify: `src/shared/ai.ts`
- Test: `tests/unit/shared/ai.test.ts`

**Interfaces:**
- Produces:
  - `AiScanRect { x: number; y: number; width: number; height: number }`（0–1 归一化）
  - `AiScanFigure extends AiScanRect { kind: "题图" | "材料图" | "解析图"; note: string }`
  - `AiScanArea { page: number; rect: AiScanRect; figures?: AiScanFigure[] }`
  - `AiQuestion.scanAreas?: AiScanArea[]`（最多 4 个，跨页每页一个）
  - `AiAnswerEntry { originalNumber: string; label: string; answer: string; page: number }`
  - `AiAnswerDraft { answers: AiAnswerEntry[]; notes: string[] }`
  - `isAiAnswerDraft(value: unknown): value is AiAnswerDraft`
  - `AiInput` 的 images 模式新增可选 `scan?: true`
  - `AiAnswerInput = { mode: "answer-text"; text: string; pages: number[]; sourceName: string; context?: AiContext } | { mode: "answer-images"; images: { dataUrl: string; page: number }[]; sourceName: string; context?: AiContext }`

- [ ] **Step 1: 写失败测试**

在 `tests/unit/shared/ai.test.ts` 增加：
- `isAiDraft` 接受带合法 `scanAreas` 的题目，拒绝 `x+width > 1`、`width <= 0`、未知字段、`figures` 未知 kind。
- `isAiAnswerDraft` 接受 `{answers:[{originalNumber:"19",label:"(1)",answer:"4",page:2}],notes:[]}`；拒绝空 answers、题号为空、label 超长、page 越界、未知字段。
- `normalizeAiInput({mode:"images",images:[...],scan:true})` 返回 `scan: true`；`scan` 非 true 时拒绝。

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/unit/shared/ai.test.ts`
Expected: FAIL——`isAiAnswerDraft` 未导出、`scanAreas` 被判未知字段。

- [ ] **Step 3: 实现协议与校验**

在 `src/shared/ai.ts` 增加类型；`questionKeys` 加 `scanAreas`；实现 `scanRect`、`scanArea`、`scanFig` 校验（拒绝未知字段，检查有限数值、0 <= x/y、width/height > 0、x+width <= 1、y+height <= 1）；`isAiAnswerDraft` 限制 1–500 条、题号 1–20 字、label ≤20 字、answer ≤2000 字、page 1–2000、notes ≤20 条。images 输入校验 `scan === undefined || scan === true`。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/unit/shared/ai.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/shared/ai.ts tests/unit/shared/ai.test.ts
git commit -m "feat: 扫描区域与答案抽取协议 (#156)"
```

---

### Task 2: 分批计划与持久化支持扫描批次、答案批次

**Files:**
- Modify: `src/shared/whole-paper-batches.ts`
- Modify: `src/shared/whole-paper-runner.ts`（仅类型与初始状态）
- Modify: `src/main/whole-paper-store.ts`
- Modify: `src/shared/whole-paper-merge.ts`
- Test: `tests/unit/shared/whole-paper-batches.test.ts`, `tests/unit/main/whole-paper-store.test.ts`, `tests/unit/shared/whole-paper-merge.test.ts`

**Interfaces:**
- Produces:
  - `WholePaperPageImage { page: number; attachmentId: string; width: number; height: number }`
  - `WholePaperAnswerFile { fileId: string; role: "answer" | "rubric"; name: string }`
  - `WholePaperBatch` 新增可选 `kind?: "text" | "scan" | "answer-text" | "answer-scan"`、`image?: WholePaperPageImage`、`answer?: WholePaperAnswerFile`
  - `WholePaperBatchPlan.answerFiles?: WholePaperAnswerFile[]`
  - `planWholePaperBatches(pages, limit, sourceKind, options?: { scanPages?: WholePaperPageImage[] })`
  - `planWholePaperAnswerBatches(pages: WholePaperPage[], scanPages: WholePaperPageImage[], limit: number, answer: WholePaperAnswerFile): WholePaperBatch[]`
- `WholePaperBatchState.answers?: AiAnswerDraft`

- [ ] **Step 1: 写失败测试**

- 混合页 `[{1,text:"A"},{2,text:""},{3,text:"B"}]` + `scanPages:[{page:2,...}]`：生成 3 个批次，顺序为 text(1) / scan(2) / text(3)，扫描批次 `fragments=[]`、`text=""`、`sendable=true`，`emptyPages=[]`。
- 扫描页没有对应空页文字时抛错；扫描页顺序与文字页重复时抛错。
- 答案文本页与答案扫描页生成 `kind:"answer-text"` / `"answer-scan"`，带 `answer` 元数据，`reviewBoundaryBefore` 按追加序号为 true。
- Store 接受扫描批次（succeeded 的扫描批次可带 `result` 或 `answers`），拒绝扫描批次带 fragments、`image` 缺 attachmentId、答案批次缺 `answer`、以及 succeeded 答案批次没有 `answers`。
- Merge 合并跨页 `scanAreas`，按 `page+x+y+width+height` 去重。

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/unit/shared/whole-paper-batches.test.ts tests/unit/main/whole-paper-store.test.ts tests/unit/shared/whole-paper-merge.test.ts`
Expected: FAIL——未知 `kind` / `scanPages` 参数。

- [ ] **Step 3: 实现分批与校验**

实现计划函数：按页序插入扫描批次，扫描页必须是空文字页；追加答案批次时复用文字切分但标 `kind`，扫描答案每页一批。Store 的 `validState` 按 `kind` 分支校验，旧数据 `kind` 缺省按 text。Merge 合并 `scanAreas`。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/unit/shared/whole-paper-batches.test.ts tests/unit/main/whole-paper-store.test.ts tests/unit/shared/whole-paper-merge.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/shared/whole-paper-batches.ts src/shared/whole-paper-runner.ts src/main/whole-paper-store.ts src/shared/whole-paper-merge.ts tests/unit/shared tests/unit/main/whole-paper-store.test.ts
git commit -m "feat: 扫描与答案批次计划 (#156)"
```

---

### Task 3: 执行器按批次类型调度并校验返回

**Files:**
- Modify: `src/shared/whole-paper-runner.ts`
- Test: `tests/unit/shared/whole-paper-runner.test.ts`

**Interfaces:**
- Produces:
  - `WholePaperBatchInput = { mode: "text"; text; pages; sourceKind } | { mode: "scan"; image: { dataUrl: string; page: number }; page: number } | { mode: "answer-text"; text; pages; sourceName } | { mode: "answer-scan"; image; page; sourceName }`
  - `Request = (input: WholePaperBatchInput, signal: AbortSignal) => Promise<unknown>`
- 扫描批次要求 `result.questions` 每条都有至少一个 `scanAreas` 且 `page` 等于本批页；答案批次要求 `isAiAnswerDraft` 且每条 `page` 在本批 `pages` 内。校验失败按失败处理并参与同轮自动重试一次。

- [ ] **Step 1: 写失败测试**

- 扫描批次成功：request 收到 `{mode:"scan", page, image}`，状态 succeeded，`result` 保存。
- 扫描结果缺 `scanAreas`：第一次 request 返回无效、第二次返回有效，`run(..., autoRetry=true)` 后 succeeded。
- 答案批次成功：request 收到 `{mode:"answer-text"}`，`answers` 保存，`result` 为空。
- 扫描结果页码不属于本批 / 答案条目页码越界：批次 failed，错误固定为“批次处理失败，请重试”。

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/unit/shared/whole-paper-runner.test.ts`
Expected: FAIL——runner 只接受 text 输入。

- [ ] **Step 3: 实现调度**

Runner 按 `batch.kind` 构造输入并调用 request；用 `isAiDraft` / `isAiAnswerDraft` 分支校验；失败路径与现有自动重试、取消一致；`running` 状态恢复逻辑不变。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/unit/shared/whole-paper-runner.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/shared/whole-paper-runner.ts tests/unit/shared/whole-paper-runner.test.ts
git commit -m "feat: 整卷执行器调度扫描与答案批次 (#156)"
```

---

### Task 4: 准备任务接入页面图与答案文件

**Files:**
- Modify: `src/main/whole-paper-prepare.ts`
- Modify: `src/main/exam-ipc.ts`
- Modify: `src/preload.ts`
- Modify: `src/renderer/env.d.ts`
- Test: `tests/unit/main/whole-paper-prepare.test.ts`

**Interfaces:**
- `prepareWholePaper(exams, tasks, attachments, examId, sectionId, fileId, pageImages?: unknown)`；`pageImages` 每项 `{ fileId?: string; page: number; dataUrl: string; width: number; height: number }`。`fileId` 缺省或等于原卷 id 表示原卷扫描页；否则必须是该考试的 `answer` / `rubric` PDF。
- 原卷：每个空文字页必须有页面图，否则抛“原卷第 N 页没有可提取文字，且缺少页面图像”。至少一页成功批处理即可，全扫描 PDF 不再拒绝。
- 答案／评分 PDF：有文字页生成 `answer-text` 批次；空文字页必须有页面图并生成 `answer-scan`；两者都没有时 `answerFiles` 记录但零批次，后续按缺答案处理。
- `wholePaper:prepare` 透传第 4 个参数；preload `prepareWholePaper(examId, sectionId, fileId, pageImages?)`。

- [ ] **Step 1: 写失败测试**

- 用合成 `blank.pdf` 页面图 data URL 准备全扫描 PDF：任务含 1 个 `scan` 批次，附件池可按 id 读到页面图。
- 混合 PDF（`text.pdf` 加一张空页图，使用内存构造的 plan 或真实两页 fixture）：文字页与扫描页批次顺序正确。
- 空页缺图：抛错，错误包含页码。
- 考试挂接答案 PDF `text.pdf`：任务追加 `answer-text` 批次，`plan.answerFiles` 记录角色与文件名；未挂接答案文件时不产生答案批次。

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/unit/main/whole-paper-prepare.test.ts`
Expected: FAIL——prepare 签名没有页面图参数，扫描 PDF 被拒绝。

- [ ] **Step 3: 实现准备逻辑**

读取原卷文字并计算空页；校验页面图覆盖全部空页并保存到附件池；构造扫描批次与答案批次；校验图像只属于本考试文件；不修改附件池中已有内容。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/unit/main/whole-paper-prepare.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/main/whole-paper-prepare.ts src/main/exam-ipc.ts src/preload.ts src/renderer/env.d.ts tests/unit/main/whole-paper-prepare.test.ts
git commit -m "feat: 整卷任务准备扫描页与答案文件 (#156)"
```

---

### Task 5: 渲染进程渲染扫描页并更新确认文案

**Files:**
- Create: `src/renderer/scan-pages.ts`
- Modify: `src/renderer/WholePaperPanel.tsx`
- Modify: `src/shared/whole-paper-view.ts`
- Modify: `src/main/exam-ipc.ts`
- Test: `tests/e2e/scan-source.spec.ts`

**Interfaces:**
- `collectScanPageImages(examId: string, paperFileId: string): Promise<{ fileId?: string; page: number; dataUrl: string; width: number; height: number }[]>`
  - 读取考试文件列表；原卷与 `answer` / `rubric` PDF 分别调用 `getExamFileText`；无文字页逐页用 PDF.js 渲染，目标长边 1600–2400 px，JPEG 质量 0.85；原卷图片返回时不带 `fileId`，答案图片带对应 `fileId`。
- `WholePaperTaskView.batches` 增加 `kind: "text" | "scan" | "answer-text" | "answer-scan"`。
- 确认文案按批次类型显示文字页、扫描页、答案页数量，并显示文字模型与图像模型。

- [ ] **Step 1: 写失败 E2E**

`tests/e2e/scan-source.spec.ts`：
1. 导入 `tests/fixtures/blank.pdf` 为原卷，挂接 `tests/fixtures/text.pdf` 为答案。
2. 点“自动录题并建档”，确认框包含“扫描页 1 张”“答案页 1 张”。
3. 固定响应 `clean` 下显示已建档 1 题、自动通过 1 题、覆盖率 100%、答案匹配 1。
4. 整卷详情显示扫描批次，并定位原页。

- [ ] **Step 2: 运行 E2E 确认失败**

Run: `npm run package && npx playwright test tests/e2e/scan-source.spec.ts`
Expected: FAIL——扫描 PDF 准备失败，确认框没有扫描页文案。

- [ ] **Step 3: 实现渲染与文案**

新增 `scan-pages.ts`，在 `prepare()` / `autoPrepare()` 前收集页面图；更新 prepare 调用；`taskView` 输出批次 `kind`；确认框区分文字/扫描/答案批次，并展示 `imageModel`。

- [ ] **Step 4: 运行 E2E 确认通过**

Run: `npm run package && npx playwright test tests/e2e/scan-source.spec.ts`
Expected: PASS（固定响应，不代表真实识读）。

- [ ] **Step 5: 提交**

```bash
git add src/renderer/scan-pages.ts src/renderer/WholePaperPanel.tsx src/shared/whole-paper-view.ts src/main/exam-ipc.ts tests/e2e/scan-source.spec.ts
git commit -m "feat: 扫描页渲染与整卷发送确认 (#156)"
```

---

### Task 6: 主进程扫描识读与答案抽取调用

**Files:**
- Modify: `src/main/ai-provider.ts`
- Modify: `src/main/ai-fake.ts`
- Modify: `src/main/ai.ts`
- Modify: `package.json`（无新依赖，不修改；确认脚本已覆盖）
- Test: `tests/unit/main/ai-provider.test.ts`, `tests/unit/main/ai-fake.test.ts`

**Interfaces:**
- `AiInput` images 模式带 `scan: true` 时，系统提示增加扫描页规则：每条题必须返回 `scanAreas`（本页归一化 `page/rect`，可含 `figures`），不返回文字锚点。
- `requestAiAnswers(config, apiKey, input: AiAnswerInput, signal?, timeoutMs?, tagCandidates?): Promise<AiAnswerDraft>`；答案提示只输出 `answers` 与 `notes`，答案必须附原题号、小问号与原页；无法确认时省略并写 notes。
- `fakeAiDraft("clean", scanInput)`：每张页面图返回 1 题，`scanAreas` 覆盖页面中部 90%×40%，答案留空、分值 3。
- `fakeAiAnswers("clean", input)`：返回 `answers:[{originalNumber:"1",label:"",answer:"4",page:1}]`。
- `ai.ts` 的整卷 request 回调按 `WholePaperBatchInput.mode` 分支：text/scan 用 `requestAiDraft`，answer-* 用 `requestAiAnswers`；fake 同分支。

- [ ] **Step 1: 写失败测试**

- provider：扫描输入的请求体 system 提示包含“scanAreas”与“归一化”，图像块仍按 base64 发送。
- provider：答案输入请求体包含答案提示，解析 `isAiAnswerDraft` 合法 JSON。
- fake：扫描输入返回带 `scanAreas` 的题；答案输入返回 1 条答案。

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/unit/main/ai-provider.test.ts tests/unit/main/ai-fake.test.ts`
Expected: FAIL——无答案提示与 fake 分支。

- [ ] **Step 3: 实现调用层**

新增扫描提示段落与 `requestAiAnswers`；fake 增加两个分支；`ai.ts` 构造扫描 data URL（从附件池读取）并校验；答案批次使用 `sourceName` 提示。确认配置检查在存在图像批次时同时核对 `imageModel`。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/unit/main/ai-provider.test.ts tests/unit/main/ai-fake.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/main/ai-provider.ts src/main/ai-fake.ts src/main/ai.ts tests/unit/main/ai-provider.test.ts tests/unit/main/ai-fake.test.ts
git commit -m "feat: 扫描页识读与答案抽取调用 (#156)"
```

---

### Task 7: 本机裁图、建档绑定与扫描覆盖

**Files:**
- Create: `src/shared/scan-crop.ts`
- Create: `src/main/scan-crop.ts`
- Modify: `src/main/whole-paper-intake.ts`
- Modify: `src/main/exam-ipc.ts`
- Modify: `src/shared/whole-paper-intake.ts`
- Modify: `src/shared/whole-paper-coverage.ts`
- Test: `tests/unit/shared/scan-crop.test.ts`, `tests/unit/main/whole-paper-intake.test.ts`, `tests/unit/shared/whole-paper-coverage.test.ts`

**Interfaces:**
- `scanCropRect(rect: AiScanRect, pageWidth: number, pageHeight: number, minSize = 160): { x: number; y: number; width: number; height: number } | null`
  - 归一化转像素、四周扩边 2%（至少 8px）、最小边长 160px、夹紧页面；结果小于 40px 返回 null。
- `cropScanPage(attachments, pageImage, rect): { attachmentId: string } | { error: string }` 使用 `nativeImage.createFromBuffer(...).crop(...).toJPEG(90)`，保存附件池。
- `WholePaperIntake` 构造参数新增第 6 项 `cropScan?: (pageImage: WholePaperPageImage, rect: AiScanRect) => { attachmentId: string } | { error: string }`。
- 扫描题：按题目 `scanAreas` 逐区域裁图；单小问挂到该小问，多小问挂题干；裁图失败或区域缺失记 `image_review`；`evidence.scanRegions` 保存 `{page, rect}`。
- `WholePaperCoverage` 输入新增 `scanPages: { page: number; covered: boolean }[]`，输出 `scanPages` 与 `scanPercent`；`percent` 只统计文字页，扫描页全未覆盖时 UI 明确阻断。
- 扫描题不要求文字锚点；`missingAnchors` 不计已有有效 `scanRegions` 的题。

- [ ] **Step 1: 写失败测试**

- 裁图数学：正常区域、越界、负值、极小区域、扩边后夹紧；结果像素均为整数且不越界。
- 建档：扫描批次题目带 `scanAreas`，注入假裁图器返回附件 id；单小问题目内容含图片块，evidence 含 region；裁图器返回 error 时质量 `needs_attention`、issue code `image_review`。
- 覆盖：2 个扫描页，1 页有题目 -> `scanPercent=50`，`scanPages` 正确；两页都有 -> 100，且不产生文字 gaps。

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/unit/shared/scan-crop.test.ts tests/unit/main/whole-paper-intake.test.ts tests/unit/shared/whole-paper-coverage.test.ts`
Expected: FAIL——无 scan-crop 模块，intake 忽略 scanAreas。

- [ ] **Step 3: 实现裁图与绑定**

实现纯数学与 Electron 裁图；intake 在 DOCX 媒体绑定之后增加扫描分支；exam-ipc 注入真实裁图器并传入附件池；coverage 增加扫描页统计；自动确认门槛增加 `scanPercent === 100` 与扫描题图片异常。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/unit/shared/scan-crop.test.ts tests/unit/main/whole-paper-intake.test.ts tests/unit/shared/whole-paper-coverage.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/shared/scan-crop.ts src/main/scan-crop.ts src/main/whole-paper-intake.ts src/main/exam-ipc.ts src/shared/whole-paper-intake.ts src/shared/whole-paper-coverage.ts tests/unit
git commit -m "feat: 扫描题本机裁图与覆盖对账 (#156)"
```

---

### Task 8: 答案唯一匹配、歧义与覆盖报告

**Files:**
- Modify: `src/main/whole-paper-intake.ts`
- Modify: `src/shared/whole-paper-intake.ts`
- Modify: `src/shared/whole-paper-coverage.ts`
- Modify: `src/renderer/WholePaperPanel.tsx`
- Test: `tests/unit/main/whole-paper-intake.test.ts`, `tests/unit/shared/whole-paper-coverage.test.ts`, `tests/e2e/scan-source.spec.ts`

**Interfaces:**
- `wholePaperIssueCodes` 新增 `answer_ambiguous`、`answer_unmatched`。
- 答案条目 key：`${batchIndex}:${answerIndex}`，写入 `evidence.answerKeys`。
- 匹配规则：题号 trim 相等；小问 label 规范化（全角括号转半角、去空格）后相等，或答案 label 为空（整题答案）视为匹配单个小问；只在小问答案为空时填入。同一答案条目被多个小问使用 -> 所有使用处记 `answer_ambiguous`，不填。匹配不到任何题目的答案条目 -> 覆盖报告 `answerMatches.unmatched`。
- `WholePaperCoverage` 增加 `answerMatches: { total: number; matched: number; ambiguous: number; unmatched: number }`；无答案文件时均为 0。
- `WholePaperIntakeSummary` 增加 `answerMatched: number`、`answerAmbiguous: number`。
- UI 覆盖区显示“答案匹配 X / Y（歧义 A，未匹配 U）”；自动确认原因包含答案歧义或未匹配。

- [ ] **Step 1: 写失败测试**

- 唯一匹配：题目 1 小问 (1)，答案文件返回 `{originalNumber:"1",label:"(1)",answer:"4"}` -> 小问答案填入，evidence.answerKeys 记录，summary.answerMatched=1。
- 多条同题号同 label -> `answer_ambiguous`、不填、quality needs_attention。
- 同一条答案被两道题匹配（构造重复题号）-> 两题都 `answer_ambiguous`。
- 答案条目题号 99 无对应题 -> coverage.answerMatches.unmatched=1。
- 覆盖报告的 matched/ambiguous/unmatched 与 evidence 一致。

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/unit/main/whole-paper-intake.test.ts tests/unit/shared/whole-paper-coverage.test.ts`
Expected: FAIL——无 answer_ambiguous、answerMatches。

- [ ] **Step 3: 实现匹配**

从成功的答案批次收集条目；建档前统一计算匹配与使用计数；唯一匹配填入空白答案并补 evidence；歧义与未匹配进入 issue/coverage；更新 summary 与 UI。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/unit/main/whole-paper-intake.test.ts tests/unit/shared/whole-paper-coverage.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/main/whole-paper-intake.ts src/shared/whole-paper-intake.ts src/shared/whole-paper-coverage.ts src/renderer/WholePaperPanel.tsx tests/unit tests/e2e/scan-source.spec.ts
git commit -m "feat: 同卷答案唯一匹配与异常报告 (#156)"
```

---

### Task 9: 全量验证、文档与交付

**Files:**
- Modify: `docs/整卷自动录题开发方案-V2.md`
- Modify: `docs/HANDOFF.md`
- Modify: `tests/fixtures/README.md`

- [ ] **Step 1: 跑全量检查**

Run: `npm run check`
Expected: 全部单测通过（新增测试计入总数），无类型错误。

- [ ] **Step 2: 跑全量 E2E 与打包检查**

Run: `npm run test:e2e`、`npm run test:packaged-app`、`npm run test:packaged-db`
Expected: 全部 E2E 通过；桥接口数量与数据版本仍为 10。

- [ ] **Step 3: 更新文档**

在 V2 方案与 HANDOFF 记录 P3 已完成内容、固定响应验证证据、以及“真实扫描样本与真实图像模型未验收”的明确边界；夹具 README 注明 `blank.pdf` 作为无文字扫描页夹具、`text.pdf` 作为答案文件夹具。

- [ ] **Step 4: 提交并推送、创建 PR**

```bash
git add docs tests/fixtures/README.md
git commit -m "docs: 整卷自动录题 P3 交接与验收边界 (#156)"
git push -u origin codex/issue-156-scan
gh pr create --title "feat: 扫描／混合 PDF 自动录题、裁图与答案关联 (#156)" --body-file /tmp/pr156.md
```

PR 关联 `Closes #156`，附验证证据与未验收项；合并后关闭 #156。
