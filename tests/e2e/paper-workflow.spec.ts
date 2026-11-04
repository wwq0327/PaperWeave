import { test, expect, _electron as electron } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database } from "../../src/main/database";
import { extractPdfText } from "../../src/main/pdf-text";
import { QuestionBank } from "../../src/main/question-bank";
import type { QuestionBlock, QuestionContent, QuestionInline } from "../../src/shared/question";
import { paragraph, readingGroup, referenceGroup } from "../unit/fixtures/questions";

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
  const approve = (content: QuestionContent) => {
    remapContent(bank, content, imageId);
    const version = bank.createQuestion(content);
    bank.setClassification(version.questionId, {
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
    await expect(dialog).toContainText("ref-1");
    await expect(dialog).toContainText("ref-2");
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

    // 生成双卷。
    await page.getByRole("button", { name: "生成学生卷与教师答案卷" }).click();
    await expect(page.getByText(/学生卷与教师答案卷已保存并打开/)).toBeVisible({ timeout: 30000 });
    const directories = readdirSync(outDir);
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

    const beforeAdjusted = readdirSync(outDir);
    await page.getByRole("button", { name: "生成学生卷与教师答案卷" }).click();
    await expect.poll(() => readdirSync(outDir).length, { timeout: 30000 }).toBe(beforeAdjusted.length + 1);
    const adjustedDir = readdirSync(outDir).find((name) => !beforeAdjusted.includes(name)) as string;
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
