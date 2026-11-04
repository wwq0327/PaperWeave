import { test, expect, _electron as electron } from "@playwright/test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database } from "../../src/main/database";
import { extractPdfText } from "../../src/main/pdf-text";
import { QuestionBank } from "../../src/main/question-bank";
import type { Classification, QuestionBlock, QuestionContent, QuestionInline } from "../../src/shared/question";
import { paragraph, readingGroup, referenceGroup } from "../unit/fixtures/questions";
import { makePng } from "../performance/fixture";

// 一张 A4 大小的透明 PNG，作为自制题图的附件，不包含任何真实题目内容。
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

const reference = (kind: "subQuestion" | "material" | "figure", targetId: string, fallback: string): QuestionInline =>
  ({ type: "reference", kind, targetId, fallback });

/** 引用目标只在未选小问中出现的题，用于验证定稿阻断定位。 */
function danglingReference(imageId: string): QuestionContent {
  return {
    stem: [],
    subQuestions: [
      {
        id: "gap-1",
        originalLabel: "(1)",
        prompt: [{ type: "paragraph", runs: [{ type: "text", text: "观察", style: "普通" }, reference("figure", "figure-x", "图 X"), { type: "text", text: "，缺少目标的引用。", style: "普通" }] }],
        explanation: [],
        options: [],
        slots: [],
        answers: [],
        scoring: [{ id: "gap-score-1", description: "引用正确", score: 4, slotIds: [] }],
        originalScore: 4,
        materialIds: [],
        dependsOn: [],
      },
      {
        id: "gap-2",
        originalLabel: "(2)",
        prompt: [{ type: "image", id: imageId, alt: "图 X", figureId: "figure-x" } as QuestionBlock],
        explanation: [],
        options: [],
        slots: [],
        answers: [],
        scoring: [{ id: "gap-score-2", description: "作图正确", score: 6, slotIds: [] }],
        originalScore: 6,
        materialIds: [],
        dependsOn: [],
      },
    ],
    materials: [],
    selection: { mode: "all" },
    source: { section: "数学·综合题", pdfPage: 10, originalNumber: "25" },
  };
}

/** 无题干、只有共享材料依赖的阅读题，用于检索筛选与材料依赖提示。 */
function materialOnly(): QuestionContent {
  return {
    stem: [],
    subQuestions: [{
      id: "material-only-1",
      originalLabel: "(1)",
      prompt: [paragraph("阅读下面的材料，概括作者的观点。")],
      explanation: [],
      options: [],
      slots: [],
      answers: [],
      scoring: [{ id: "material-only-score", description: "概括准确", score: 5, slotIds: [] }],
      originalScore: 5,
      materialIds: ["material-c"],
      dependsOn: [],
    }],
    materials: [{ materialId: "material-c", versionId: "material-c-v1" }],
    selection: { mode: "all" },
    source: { section: "语文·阅读", pdfPage: 2, originalNumber: "5" },
  };
}

function remapContent(bank: QuestionBank, content: QuestionContent, imageId: string) {
  const materialVersions = new Map<string, string>();
  const materialIds = new Map<string, string>();
  for (const ref of content.materials) {
    if (materialVersions.has(ref.materialId)) continue;
    const material = bank.createMaterial({ title: `材料 ${ref.materialId}`, content: [paragraph("材料正文")], source: "自制样题" });
    bank.setMaterialStatus(material.id, "pending");
    bank.setMaterialStatus(material.id, "approved");
    materialVersions.set(ref.materialId, material.id);
    materialIds.set(ref.materialId, material.materialId);
  }
  content.materials = content.materials.map((ref) => ({
    materialId: materialIds.get(ref.materialId) as string,
    versionId: materialVersions.get(ref.materialId) as string,
  }));
  const walk = (blocks: QuestionContent["stem"]) => {
    for (const block of blocks) {
      if (block.type === "image") block.id = imageId;
      if (block.type !== "paragraph") continue;
      for (const run of block.runs) {
        if (run.type === "reference" && run.kind === "material") run.targetId = materialIds.get(run.targetId) ?? run.targetId;
      }
    }
  };
  walk(content.stem);
  for (const sub of content.subQuestions) {
    sub.materialIds = sub.materialIds.map((id) => materialIds.get(id) ?? id);
    walk(sub.prompt);
    walk(sub.explanation);
    for (const option of sub.options) walk(option.content);
    for (const answer of sub.answers) walk(answer.blocks);
  }
}

function seed(dir: string): void {
  mkdirSync(path.join(dir, "attachments"), { recursive: true });
  const imageId = createHash("sha256").update(png).digest("hex");
  writeFileSync(path.join(dir, "attachments", imageId), png);

  const db = new Database(path.join(dir, "paperweave.sqlite"));
  const bank = new QuestionBank(db);
  const approve = (content: QuestionContent, classification?: Classification) => {
    remapContent(bank, content, imageId);
    const version = bank.createQuestion(content);
    bank.setClassification(version.questionId, classification ?? {
      stage: "初中",
      subject: "数学",
      grade: "九年级",
      examType: "单元测",
      year: "2024",
      sourceName: "自制样题",
      questionType: "解答题",
      knowledgePoints: ["综合"],
    });
    bank.setContentStatus(version.id, "pending");
    bank.setContentStatus(version.id, "approved");
    bank.setAnswerStatus(version.id, "pending");
    bank.setAnswerStatus(version.id, "approved");
    return version;
  };

  // 先建阅读题组，后建图文题，使检索结果中图文题在前。
  approve(readingGroup());
  const math = referenceGroup();
  // 内嵌分值用于验证组卷时的分值冲突提示；解析中的分值验证扫描覆盖解析。
  math.subQuestions[0].prompt.push(paragraph("（4 分）"));
  math.subQuestions[1].explanation.push(paragraph("评分说明：第二问 6 分。"));
  approve(math);
  approve(danglingReference(imageId));
  // 独立分类的共享材料题，只由组合筛选命中。
  approve(materialOnly(), {
    stage: "初中",
    subject: "语文",
    grade: "九年级",
    examType: "期末",
    year: "2026",
    sourceName: "区统测",
    questionType: "阅读题",
    knowledgePoints: ["概括"],
  });
  db.close();
}

async function closeApp(app: Awaited<ReturnType<typeof electron.launch>>) {
  await app.evaluate(({ app: electronApp }) => { electronApp.exit(0); }).catch(() => undefined);
  await app.close().catch(() => undefined);
}

test("切换组卷再返回时未保存的草稿仍在", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "paperweave-switch-"));
  const app = await electron.launch({ args: [path.resolve(".vite/build/main.cjs"), `--user-data-dir=${dir}`] });
  try {
    const page = await app.firstWindow();
    await page.getByLabel("文本 1").first().fill("未保存的草稿内容");
    await page.getByRole("button", { name: "题库与组卷" }).click();
    await expect(page.getByRole("heading", { name: "题库与组卷" })).toBeVisible();
    await page.getByRole("button", { name: "返回录题草稿" }).click();
    await expect(page.getByLabel("文本 1").first()).toHaveValue("未保存的草稿内容");
  } finally {
    await closeApp(app);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("题库检索到双卷定稿：依赖确认、改分、阻断、学生卷无答案、重印", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "paperweave-workflow-"));
  const outDir = mkdtempSync(path.join(tmpdir(), "paperweave-workflow-out-"));
  seed(dir);
  const app = await electron.launch({ args: [path.resolve(".vite/build/main.cjs"), `--user-data-dir=${dir}`] });
  try {
    await app.evaluate(({ dialog, shell }, target) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] });
      shell.openPath = async (file) => {
        const globals = globalThis as typeof globalThis & { openedPaperPdfs?: string[] };
        globals.openedPaperPdfs = [...(globals.openedPaperPdfs ?? []), file];
        return "";
      };
    }, outDir);
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "题库与组卷" }).click();
    await expect(page.getByRole("heading", { name: "题库与组卷" })).toBeVisible();
    await expect(page.locator(".paper-card", { hasText: "阅读下面的材料，完成各题。" })).toBeVisible();
    await expect(page.locator(".paper-card", { hasText: "阅读材料，" })).toBeVisible();

    // 整题加入阅读题组。
    await page.locator(".paper-card", { hasText: "阅读下面的材料，完成各题。" }).getByRole("button", { name: "整题入篮" }).click();
    await expect(page.getByText("已加入题篮。")).toBeVisible();

    // 只选图文题第 (2) 问，触发共用题干/前问依赖确认。
    await page.locator(".paper-card", { hasText: "阅读材料，" }).getByRole("button", { name: "查看小问/答案" }).click();
    const detail = page.getByRole("region", { name: "题目详情" });
    await expect(detail).toBeVisible();
    const part2 = detail.locator("li", { hasText: "的结论是否成立。" });
    await part2.getByRole("button", { name: "加入此小问" }).click();
    const dialog = page.getByRole("dialog", { name: "依赖确认" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("本项：(2) 说明(1)的结论是否成立。");
    await expect(dialog).toContainText("追加小问：(1)");
    await expect(dialog).toContainText("题组共用题干");
    await dialog.getByRole("button", { name: "确认加入" }).click();
    await expect(page.getByText("已加入题篮。")).toBeVisible();
    await expect(page.getByRole("region", { name: "题篮" }).locator(".paper-card")).toHaveCount(2);

    // 建卷与加小节。
    await page.getByLabel("标题", { exact: true }).fill("九年级数学单元卷");
    await page.getByRole("button", { name: "创建试卷" }).click();
    await expect(page.getByRole("heading", { name: "九年级数学单元卷　总分 0 分" })).toBeVisible();
    await page.getByRole("button", { name: "添加小节" }).click();
    await expect(page.getByRole("region", { name: "解答题" })).toBeVisible();

    // 两个题篮项加入同一小节。
    for (const card of await page.getByRole("region", { name: "题篮" }).locator(".paper-card").all()) {
      await card.getByRole("button", { name: "加入试卷" }).click();
      await expect(page.getByText("已加入试卷。")).toBeVisible();
    }
    await expect(page.getByText("总分 22 分")).toBeVisible();
    const mathItem = page.locator("article.paper-item-edit", { hasText: "的结论是否成立。" });

    // 排序：上移后图文题成为第 1 题，再下移还原。
    await mathItem.getByRole("button", { name: "上移" }).click();
    await expect(page.locator("article.paper-item-edit").first()).toContainText("的结论是否成立。");
    await mathItem.getByRole("button", { name: "下移" }).click();
    await expect(page.locator("article.paper-item-edit").first()).toContainText("阅读下面的材料");

    // 题干「4 分」与解析「6 分」都命中旧分值，未确认时阻断定稿。
    await expect(mathItem.locator(".paper-conflict", { hasText: "「4 分」" })).toContainText("「4 分」");
    await expect(mathItem.locator(".paper-conflict", { hasText: "「6 分」" })).toContainText("（原分值 6 分）");
    await mathItem.locator(".paper-conflict", { hasText: "「4 分」" }).getByRole("button", { name: "确认保留" }).click();
    await expect(mathItem.locator(".paper-conflict", { hasText: "「4 分」" })).toContainText("已确认。");

    // 改分触发待调整，定稿被阻断并指出题号。
    await mathItem.getByLabel("卷内分值").fill("4");
    await mathItem.getByRole("button", { name: "改分" }).click();
    await expect(page.getByText("卷内分值已更新。")).toBeVisible();
    await expect(mathItem.locator(".paper-state")).toHaveText("待调整");
    await page.getByRole("button", { name: "生成学生卷与教师答案卷" }).click();
    await expect(page.getByText("定稿被阻断，请先处理下列问题。")).toBeVisible();
    const blockers = page.locator(".paper-blockers");
    await expect(blockers).toContainText("第 2 题：原评分不适用于当前分值，待调整");
    await expect(blockers).toContainText("内嵌分值「6 分」尚未确认");
    await expect(page.getByText("总分 16 分")).toBeVisible();

    await mathItem.locator(".paper-conflict", { hasText: "「6 分」" }).getByRole("button", { name: "确认保留" }).click();
    await mathItem.getByRole("button", { name: "仅输出参考答案" }).click();
    await expect(page.getByText("评分状态已更新。")).toBeVisible();
    await page.getByRole("button", { name: "检查定稿" }).click();
    await expect(page.getByText("定稿检查通过。")).toBeVisible();

    // 生成双卷：先打开两份预览；取消不产生定稿记录与正式目录。
    await page.getByRole("button", { name: "生成学生卷与教师答案卷" }).click();
    const confirmDialog = page.getByRole("dialog", { name: "确认定稿" });
    await expect(confirmDialog).toBeVisible({ timeout: 30000 });
    const previewDirs = readdirSync(outDir).filter((name) => name.startsWith(".paperweave-"));
    expect(previewDirs).toHaveLength(1);
    const openedPreview = await app.evaluate(() => (globalThis as typeof globalThis & { openedPaperPdfs?: string[] }).openedPaperPdfs ?? []);
    expect(openedPreview.slice(-2)).toEqual([
      path.join(outDir, previewDirs[0], "学生卷.pdf"),
      path.join(outDir, previewDirs[0], "教师答案卷.pdf"),
    ]);
    for (const file of openedPreview.slice(-2)) expect(existsSync(file)).toBe(true);
    await confirmDialog.getByRole("button", { name: "取消并丢弃" }).click();
    await expect(page.getByText("已取消定稿。")).toBeVisible();
    expect(readdirSync(outDir).filter((name) => name.startsWith(".paperweave-"))).toHaveLength(0);
    expect(readdirSync(outDir).filter((name) => name.startsWith("拾题成卷-样张-"))).toHaveLength(0);
    await expect(page.getByText("暂无定稿记录。")).toBeVisible();

    // 重新生成并确认后才落盘定稿。
    await page.getByRole("button", { name: "生成学生卷与教师答案卷" }).click();
    const confirmAgain = page.getByRole("dialog", { name: "确认定稿" });
    await expect(confirmAgain).toBeVisible({ timeout: 30000 });
    await confirmAgain.getByRole("button", { name: "确认保存为定稿" }).click();
    await expect(page.getByText(/双卷已保存为定稿/)).toBeVisible({ timeout: 30000 });
    const directories = readdirSync(outDir).filter((name) => name.startsWith("拾题成卷-样张-"));
    expect(directories).toHaveLength(1);
    const student = readFileSync(path.join(outDir, directories[0], "学生卷.pdf"));
    const teacher = readFileSync(path.join(outDir, directories[0], "教师答案卷.pdf"));
    expect(student.subarray(0, 5).toString()).toBe("%PDF-");
    expect(teacher.subarray(0, 5).toString()).toBe("%PDF-");
    const studentText = (await extractPdfText(new Uint8Array(student))).pages.map((page) => page.text).join("\n").normalize("NFKC");
    const teacherText = (await extractPdfText(new Uint8Array(teacher))).pages.map((page) => page.text).join("\n").normalize("NFKC");
    // 学生卷：题号、材料与图引用已解析，且结构上没有答案与评分。
    expect(studentText).toContain("九年级数学单元卷");
    expect(studentText).toContain("一、解答题");
    expect(studentText).toContain("第 1 题(12 分)");
    expect(studentText).toContain("第 2 题(4 分)");
    expect(studentText).toContain("材料一");
    expect(studentText).toContain("材料二");
    expect(studentText).toContain("图 1");
    expect(studentText).not.toContain("参考答案");
    expect(studentText).not.toContain("在 x=1 处取得最小值");
    expect(studentText).not.toContain("结论正确");
    expect(studentText).not.toContain("评分点");
    expect(studentText).not.toContain("本卷评分待补");
    // 教师卷：含答案与仅答案说明；选择仅答案后不打印原评分点。
    expect(teacherText).toContain("在 x=1 处取得最小值");
    expect(teacherText).toContain("参考答案");
    expect(teacherText).not.toContain("结论正确");
    expect(teacherText).toContain("本卷评分待补,仅提供参考答案。");

    // 重印只打开已冻结 PDF，不重新生成目录。
    const before = readdirSync(outDir);
    const openedBefore = await app.evaluate(() => (globalThis as typeof globalThis & { openedPaperPdfs?: string[] }).openedPaperPdfs?.length ?? 0);
    await page.getByRole("button", { name: "重印" }).click();
    await expect(page.getByText("已打开原定稿 PDF。")).toBeVisible();
    expect(readdirSync(outDir)).toEqual(before);
    const opened = await app.evaluate(() => (globalThis as typeof globalThis & { openedPaperPdfs?: string[] }).openedPaperPdfs ?? []);
    expect(opened.length).toBe(openedBefore + 2);
    expect(opened.slice(-2)).toEqual([
      path.join(outDir, directories[0], "学生卷.pdf"),
      path.join(outDir, directories[0], "教师答案卷.pdf"),
    ]);

    // 只加入引用目标不在卷内的小问，检查定稿阻断定位到题号与原卷页。
    const gapCard = page.locator(".paper-card", { hasText: "缺少目标的引用。" });
    await gapCard.getByRole("button", { name: "查看小问/答案" }).click();
    const gapDetail = page.getByRole("region", { name: "题目详情" });
    await gapDetail.locator("li", { hasText: "缺少目标的引用。" }).getByRole("button", { name: "加入此小问" }).click();
    await expect(page.getByText("已加入题篮。")).toBeVisible();
    const gapBasket = page.getByRole("region", { name: "题篮" }).locator(".paper-card", { hasText: "缺少目标的引用。" });
    await gapBasket.getByRole("button", { name: "加入试卷" }).click();
    await expect(page.getByText("已加入试卷。")).toBeVisible();
    await page.getByRole("button", { name: "检查定稿" }).click();
    const blocked = page.locator(".paper-blockers");
    await expect(blocked).toContainText("第 3 题");
    await expect(blocked).toContainText("图引用无法解析");
    await expect(blocked).toContainText("原卷第 10 页 题 25");

    // 已有一份试卷时仍可新建第二份。
    await page.getByRole("button", { name: "新建试卷" }).click();
    await page.getByLabel("标题", { exact: true }).fill("第二份数学卷");
    await page.getByRole("button", { name: "创建试卷" }).click();
    await expect(page.getByRole("heading", { name: "第二份数学卷　总分 0 分" })).toBeVisible();

    // 第二份卷：改分后编辑评分点，教师卷打印「本卷评分」。
    await page.getByRole("button", { name: "添加小节" }).click();
    await expect(page.getByRole("region", { name: "解答题" })).toBeVisible();
    await page.getByRole("region", { name: "题篮" }).locator(".paper-card", { hasText: "的结论是否成立。" }).getByRole("button", { name: "加入试卷" }).click();
    await expect(page.getByText("已加入试卷。")).toBeVisible();
    const adjustedItem = page.locator("article.paper-item-edit", { hasText: "的结论是否成立。" });
    await expect(page.getByText("总分 10 分")).toBeVisible();
    await adjustedItem.locator(".paper-conflict", { hasText: "「4 分」" }).getByRole("button", { name: "确认保留" }).click();
    await adjustedItem.locator(".paper-conflict", { hasText: "「6 分」" }).getByRole("button", { name: "确认保留" }).click();
    await adjustedItem.getByLabel("卷内分值").fill("8");
    await adjustedItem.getByRole("button", { name: "改分" }).click();
    await expect(page.getByText("卷内分值已更新。")).toBeVisible();
    await expect(adjustedItem.locator(".paper-state")).toHaveText("待调整");

    await adjustedItem.getByRole("button", { name: "编辑评分点" }).click();
    await adjustedItem.getByLabel("评分点 1 分值").fill("3");
    await adjustedItem.getByLabel("评分点 2 分值").fill("5");
    await expect(adjustedItem.locator(".paper-scoring-edit")).toContainText("评分点合计 8 分，卷内分值 8 分");
    await adjustedItem.getByRole("button", { name: "保存评分点" }).click();
    await expect(page.getByText("评分状态已更新。")).toBeVisible();
    await expect(adjustedItem.locator(".paper-state")).toHaveText("已调整");
    await page.getByRole("button", { name: "检查定稿" }).click();
    await expect(page.getByText("定稿检查通过。")).toBeVisible();

    const resultsBefore = readdirSync(outDir).filter((name) => name.startsWith("拾题成卷-样张-"));
    await page.getByRole("button", { name: "生成学生卷与教师答案卷" }).click();
    const adjustedConfirm = page.getByRole("dialog", { name: "确认定稿" });
    await expect(adjustedConfirm).toBeVisible({ timeout: 30000 });
    await adjustedConfirm.getByRole("button", { name: "确认保存为定稿" }).click();
    await expect.poll(() => readdirSync(outDir).filter((name) => name.startsWith("拾题成卷-样张-")).length, { timeout: 30000 }).toBe(resultsBefore.length + 1);
    const adjustedDir = readdirSync(outDir).filter((name) => name.startsWith("拾题成卷-样张-") && !resultsBefore.includes(name))[0];
    const adjustedTeacher = readFileSync(path.join(outDir, adjustedDir, "教师答案卷.pdf"));
    const adjustedTeacherText = (await extractPdfText(new Uint8Array(adjustedTeacher))).pages.map((entry) => entry.text).join("\n").normalize("NFKC");
    expect(adjustedTeacherText).toContain("本卷评分");
    expect(adjustedTeacherText).toContain("结论正确(3 分)");
    expect(adjustedTeacherText).toContain("判断正确(5 分)");
  } finally {
    await closeApp(app);
    rmSync(dir, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("组合筛选命中目标题，详情与入篮确认展示共享材料依赖", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "paperweave-search-"));
  seed(dir);
  const app = await electron.launch({ args: [path.resolve(".vite/build/main.cjs"), `--user-data-dir=${dir}`] });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "题库与组卷" }).click();
    await expect(page.getByRole("heading", { name: "题库与组卷" })).toBeVisible();
    const search = page.getByRole("region", { name: "题库检索" });
    await search.getByLabel("学科").fill("语文");
    await search.getByLabel("考试类型").fill("期末");
    await search.getByLabel("学年").fill("2026");
    await search.getByLabel("来源").fill("区统测");
    await search.getByLabel("题型").fill("阅读题");
    await search.getByLabel("知识点").fill("概括");
    await search.getByLabel("内容状态").selectOption("approved");
    await search.getByLabel("答案状态").selectOption("approved");
    await search.getByRole("button", { name: "检索" }).click();

    // 组合字段只命中目标题，不混入数学样题。
    await expect(search.locator(".paper-card")).toHaveCount(1);
    const card = search.locator(".paper-card");
    await expect(card).toContainText("概括作者的观点");
    await card.getByRole("button", { name: "查看小问/答案" }).click();

    // 详情用材料标题显示共享材料依赖，并预告入篮范围。
    const detail = page.getByRole("region", { name: "题目详情" });
    await expect(detail).toContainText("共享材料：材料 material-c");
    await expect(detail).toContainText("入篮将带入：(1)；材料：材料 material-c");

    // 入篮确认展示本项、追加项与材料，且只有本项，不扩大小问范围。
    await detail.getByRole("button", { name: "加入此小问" }).click();
    const dialog = page.getByRole("dialog", { name: "依赖确认" });
    await expect(dialog).toContainText("本项：(1) 阅读下面的材料，概括作者的观点。");
    await expect(dialog).toContainText("追加小问：无（仅本项）");
    await expect(dialog).toContainText("依赖材料：材料 material-c");
    await expect(dialog).toContainText("共享材料");
    await expect(dialog).not.toContainText("独立小问");
    await dialog.getByRole("button", { name: "确认加入" }).click();
    await expect(page.getByText("已加入题篮。")).toBeVisible();

    // 题篮只含本项，依赖原因保留共享材料提示。
    const basketCard = page.getByRole("region", { name: "题篮" }).locator(".paper-card");
    await expect(basketCard).toHaveCount(1);
    await expect(basketCard).toContainText("概括作者的观点");
    await expect(basketCard).toContainText("共享材料");
  } finally {
    await closeApp(app);
    rmSync(dir, { recursive: true, force: true });
  }
});

/** 答案待补的单选题，用于验证教师确认出卷与教师卷逐题标注。 */
function answerGapContent(): QuestionContent {
  return {
    stem: [],
    subQuestions: [{
      id: "gap-answer-1",
      originalLabel: "(1)",
      prompt: [paragraph("写出解答过程。")],
      explanation: [],
      options: [],
      slots: [],
      answers: [],
      scoring: [{ id: "gap-answer-score", description: "过程完整", score: 6, slotIds: [] }],
      originalScore: 6,
      materialIds: [],
      dependsOn: [],
    }],
    materials: [],
    selection: { mode: "all" },
    source: { section: "数学·解答题", pdfPage: 3, originalNumber: "18" },
  };
}

function seedAnswerGap(dir: string): void {
  const db = new Database(path.join(dir, "paperweave.sqlite"));
  const bank = new QuestionBank(db);
  const version = bank.createQuestion(answerGapContent());
  bank.setClassification(version.questionId, {
    stage: "初中",
    subject: "数学",
    grade: "九年级",
    examType: "单元测",
    year: "2026",
    sourceName: "自制样题",
    questionType: "解答题",
    knowledgePoints: ["综合"],
  });
  bank.setContentStatus(version.id, "pending");
  bank.setContentStatus(version.id, "approved");
  db.close();
}

test("答案待补：未确认时阻断定稿，确认后教师卷逐题标注且学生卷不标注", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "paperweave-answer-gap-"));
  const outDir = mkdtempSync(path.join(tmpdir(), "paperweave-answer-gap-out-"));
  seedAnswerGap(dir);
  const app = await electron.launch({ args: [path.resolve(".vite/build/main.cjs"), `--user-data-dir=${dir}`] });
  try {
    await app.evaluate(({ dialog, shell }, target) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] });
      shell.openPath = async () => "";
    }, outDir);
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "题库与组卷" }).click();
    await expect(page.getByRole("heading", { name: "题库与组卷" })).toBeVisible();
    await page.locator(".paper-card", { hasText: "写出解答过程。" }).getByRole("button", { name: "整题入篮" }).click();
    await expect(page.getByText("已加入题篮。")).toBeVisible();
    await page.getByLabel("标题", { exact: true }).fill("答案待补数学卷");
    await page.getByRole("button", { name: "创建试卷" }).click();
    await page.getByRole("button", { name: "添加小节" }).click();
    await page.getByRole("region", { name: "题篮" }).getByRole("button", { name: "加入试卷" }).click();
    await expect(page.getByText("总分 6 分")).toBeVisible();

    // 未确认时阻断，并指出原因。
    await page.getByRole("button", { name: "生成学生卷与教师答案卷" }).click();
    await expect(page.getByText("定稿被阻断，请先处理下列问题。")).toBeVisible();
    await expect(page.locator(".paper-blockers")).toContainText("答案或评分尚未齐全，需教师确认后出卷");

    // 教师确认后可通过，并提示教师卷会标注。
    await page.getByLabel("确认答案或评分待补出卷").check();
    await page.getByRole("button", { name: "检查定稿" }).click();
    await expect(page.getByText("定稿检查通过。")).toBeVisible();
    await expect(page.locator(".paper-ok")).toContainText("答案或评分尚未齐全，教师版将标注待补");

    await page.getByRole("button", { name: "生成学生卷与教师答案卷" }).click();
    const confirmDialog = page.getByRole("dialog", { name: "确认定稿" });
    await expect(confirmDialog).toBeVisible({ timeout: 30000 });
    await confirmDialog.getByRole("button", { name: "确认保存为定稿" }).click();
    await expect(page.getByText(/双卷已保存为定稿/)).toBeVisible({ timeout: 30000 });

    const directories = readdirSync(outDir).filter((name) => name.startsWith("拾题成卷-样张-"));
    expect(directories).toHaveLength(1);
    const student = readFileSync(path.join(outDir, directories[0], "学生卷.pdf"));
    const teacher = readFileSync(path.join(outDir, directories[0], "教师答案卷.pdf"));
    const studentText = (await extractPdfText(new Uint8Array(student))).pages.map((entry) => entry.text).join("\n").normalize("NFKC");
    const teacherText = (await extractPdfText(new Uint8Array(teacher))).pages.map((entry) => entry.text).join("\n").normalize("NFKC");
    expect(teacherText).toContain("答案或评分待补");
    expect(studentText).not.toContain("答案或评分待补");
  } finally {
    await closeApp(app);
    rmSync(dir, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});


/** 只选缺原分值的小问，用于验证教师补填卷内分值后入卷。 */
function missingScoreContent(): QuestionContent {
  return {
    stem: [],
    subQuestions: [
      {
        id: "fill-1",
        originalLabel: "(1)",
        prompt: [paragraph("求 f(1) 的值。")],
        explanation: [],
        options: [],
        slots: [],
        answers: [],
        scoring: [{ id: "fill-score-1", description: "结果正确", score: 5, slotIds: [] }],
        originalScore: null,
        materialIds: [],
        dependsOn: [],
      },
      {
        id: "fill-2",
        originalLabel: "(2)",
        prompt: [paragraph("说明函数的单调性。")],
        explanation: [],
        options: [],
        slots: [],
        answers: [],
        scoring: [{ id: "fill-score-2", description: "结论正确", score: 5, slotIds: [] }],
        originalScore: 5,
        materialIds: [],
        dependsOn: [],
      },
    ],
    materials: [],
    selection: { mode: "all" },
    source: { section: "数学·解答题", pdfPage: 5, originalNumber: "19" },
  };
}

function seedMissingScore(dir: string): void {
  const db = new Database(path.join(dir, "paperweave.sqlite"));
  const bank = new QuestionBank(db);
  const version = bank.createQuestion(missingScoreContent());
  bank.setClassification(version.questionId, {
    stage: "初中",
    subject: "数学",
    grade: "九年级",
    examType: "单元测",
    year: "2026",
    sourceName: "自制样题",
    questionType: "解答题",
    knowledgePoints: ["函数"],
  });
  db.close();
}

test("缺少原分值时提示补填，填写后按教师分值入卷并标记待调整", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "paperweave-missing-score-"));
  seedMissingScore(dir);
  const app = await electron.launch({ args: [path.resolve(".vite/build/main.cjs"), `--user-data-dir=${dir}`] });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "题库与组卷" }).click();
    await expect(page.getByRole("heading", { name: "题库与组卷" })).toBeVisible();
    const card = page.locator(".paper-card", { hasText: "求 f(1) 的值。" });
    await card.getByRole("button", { name: "查看小问/答案" }).click();
    const detail = page.getByRole("region", { name: "题目详情" });
    await detail.locator("li", { hasText: "求 f(1) 的值。" }).getByRole("button", { name: "加入此小问" }).click();
    await expect(page.getByText("已加入题篮。")).toBeVisible();

    await page.getByLabel("标题", { exact: true }).fill("补分数学卷");
    await page.getByRole("button", { name: "创建试卷" }).click();
    await page.getByRole("button", { name: "添加小节" }).click();
    await page.getByRole("region", { name: "题篮" }).getByRole("button", { name: "加入试卷" }).click();
    await expect(page.getByLabel("补填卷内分值")).toBeVisible();

    await page.getByLabel("补填卷内分值").fill("7");
    await page.getByRole("region", { name: "题篮" }).getByRole("button", { name: "加入试卷" }).click();
    await expect(page.getByText("已加入试卷。")).toBeVisible();
    await expect(page.getByText("总分 7 分")).toBeVisible();
    await expect(page.locator("article.paper-item-edit").locator(".paper-state")).toHaveText("待调整");
  } finally {
    await closeApp(app);
    rmSync(dir, { recursive: true, force: true });
  }
});

/** 一道已审核、可正常定稿的题，用于验证预览打开失败的定稿门槛。 */
function seedReadyQuestion(dir: string): void {
  const db = new Database(path.join(dir, "paperweave.sqlite"));
  const bank = new QuestionBank(db);
  const content: QuestionContent = {
    stem: [],
    subQuestions: [{
      id: "ready-1",
      originalLabel: "(1)",
      prompt: [paragraph("预览打开失败校验题。")],
      explanation: [],
      options: [],
      slots: [],
      answers: [{ slotId: null, blocks: [paragraph("参考答案")], variants: [] }],
      scoring: [{ id: "ready-score", description: "答案正确", score: 5, slotIds: [] }],
      originalScore: 5,
      materialIds: [],
      dependsOn: [],
    }],
    materials: [],
    selection: { mode: "all" },
    source: { section: "数学·解答题", pdfPage: 4, originalNumber: "16" },
  };
  const version = bank.createQuestion(content);
  bank.setClassification(version.questionId, {
    stage: "初中",
    subject: "数学",
    grade: "九年级",
    examType: "单元测",
    year: "2026",
    sourceName: "自制样题",
    questionType: "解答题",
    knowledgePoints: ["综合"],
  });
  bank.setContentStatus(version.id, "pending");
  bank.setContentStatus(version.id, "approved");
  bank.setAnswerStatus(version.id, "pending");
  bank.setAnswerStatus(version.id, "approved");
  db.close();
}

test("双卷预览打不开时禁止确认定稿，重新打开成功后才可保存", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "paperweave-preview-fail-"));
  const outDir = mkdtempSync(path.join(tmpdir(), "paperweave-preview-fail-out-"));
  seedReadyQuestion(dir);
  const app = await electron.launch({ args: [path.resolve(".vite/build/main.cjs"), `--user-data-dir=${dir}`] });
  try {
    await app.evaluate(({ dialog, shell }, target) => {
      const state = globalThis as typeof globalThis & { previewOpenCalls?: number };
      state.previewOpenCalls = 0;
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] });
      shell.openPath = async () => {
        state.previewOpenCalls = (state.previewOpenCalls ?? 0) + 1;
        return state.previewOpenCalls <= 2 ? "模拟打开失败" : "";
      };
    }, outDir);
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "题库与组卷" }).click();
    await page.locator(".paper-card", { hasText: "预览打开失败校验题。" }).getByRole("button", { name: "整题入篮" }).click();
    await expect(page.getByText("已加入题篮。")).toBeVisible();
    await page.getByLabel("标题", { exact: true }).fill("预览失败数学卷");
    await page.getByRole("button", { name: "创建试卷" }).click();
    await page.getByRole("button", { name: "添加小节" }).click();
    await page.getByRole("region", { name: "题篮" }).getByRole("button", { name: "加入试卷" }).click();
    await expect(page.getByText("总分 5 分")).toBeVisible();

    await page.getByRole("button", { name: "生成学生卷与教师答案卷" }).click();
    const dialog = page.getByRole("dialog", { name: "确认定稿" });
    await expect(dialog).toBeVisible({ timeout: 30000 });
    await expect(dialog).toContainText("预览未能自动打开");
    await expect(dialog.getByRole("button", { name: "确认保存为定稿" })).toBeDisabled();

    await dialog.getByRole("button", { name: "重新打开预览" }).click();
    await expect(page.getByText("双卷预览已重新打开，确认无误后可保存为定稿。")).toBeVisible();
    await expect(dialog.getByRole("button", { name: "确认保存为定稿" })).toBeEnabled();
    await dialog.getByRole("button", { name: "确认保存为定稿" }).click();
    await expect(page.getByText(/双卷已保存为定稿/)).toBeVisible({ timeout: 30000 });
  } finally {
    await closeApp(app);
    rmSync(dir, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

/** 一道含超大自拟题图的题，用于验证组卷定稿拒绝静默缩小。 */
function seedOversizeFigure(dir: string): void {
  mkdirSync(path.join(dir, "attachments"), { recursive: true });
  const png = makePng(300, 3000, 4_500_000);
  const imageId = createHash("sha256").update(png).digest("hex");
  writeFileSync(path.join(dir, "attachments", imageId), png);
  const db = new Database(path.join(dir, "paperweave.sqlite"));
  const bank = new QuestionBank(db);
  const content: QuestionContent = {
    stem: [],
    subQuestions: [{
      id: "oversize-1",
      originalLabel: "(1)",
      prompt: [paragraph("观察下面的图。"), { type: "image", id: imageId, alt: "超大图" }],
      explanation: [],
      options: [],
      slots: [],
      answers: [{ slotId: null, blocks: [paragraph("参考答案")], variants: [] }],
      scoring: [{ id: "oversize-score", description: "作答正确", score: 5, slotIds: [] }],
      originalScore: 5,
      materialIds: [],
      dependsOn: [],
    }],
    materials: [],
    selection: { mode: "all" },
    source: { section: "数学·解答题", pdfPage: 6, originalNumber: "17" },
  };
  const version = bank.createQuestion(content);
  bank.setClassification(version.questionId, {
    stage: "初中",
    subject: "数学",
    grade: "九年级",
    examType: "单元测",
    year: "2026",
    sourceName: "自制样题",
    questionType: "解答题",
    knowledgePoints: ["综合"],
  });
  bank.setContentStatus(version.id, "pending");
  bank.setContentStatus(version.id, "approved");
  bank.setAnswerStatus(version.id, "pending");
  bank.setAnswerStatus(version.id, "approved");
  db.close();
}

test("组卷定稿遇到超出 A4 可打印区域的题图时提示调整，不生成 PDF", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "paperweave-oversize-"));
  const outDir = mkdtempSync(path.join(tmpdir(), "paperweave-oversize-out-"));
  seedOversizeFigure(dir);
  const app = await electron.launch({ args: [path.resolve(".vite/build/main.cjs"), `--user-data-dir=${dir}`] });
  try {
    await app.evaluate(({ dialog, shell }, target) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] });
      shell.openPath = async () => "";
    }, outDir);
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "题库与组卷" }).click();
    await page.locator(".paper-card", { hasText: "观察下面的图。" }).getByRole("button", { name: "整题入篮" }).click();
    await expect(page.getByText("已加入题篮。")).toBeVisible();
    await page.getByLabel("标题", { exact: true }).fill("超图数学卷");
    await page.getByRole("button", { name: "创建试卷" }).click();
    await page.getByRole("button", { name: "添加小节" }).click();
    await page.getByRole("region", { name: "题篮" }).getByRole("button", { name: "加入试卷" }).click();
    await expect(page.getByText("总分 5 分")).toBeVisible();

    await page.getByRole("button", { name: "生成学生卷与教师答案卷" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "超出 A4 可打印区域" })).toBeVisible({ timeout: 30000 });
    await expect(page.getByRole("alert").filter({ hasText: "第 1 题" })).toBeVisible();
    await expect(page.getByRole("dialog", { name: "确认定稿" })).not.toBeVisible();
    await page.getByRole("button", { name: "取消定稿" }).click();
    await expect(page.getByText("已取消定稿。")).toBeVisible();
  } finally {
    await closeApp(app);
    rmSync(dir, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});
