import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { Database } from "../../src/main/database";
import { Basket } from "../../src/main/basket";
import { Paper } from "../../src/main/paper";
import { QuestionBank } from "../../src/main/question-bank";
import type { Draft } from "../../src/shared/document";
import type { Classification, QuestionBlock, QuestionContent } from "../../src/shared/question";

/** 规模目标来自 docs/基线记录.md；全部内容为自制合成文字，不含真实题目。 */
export const SCALE = {
  questions: 5000,
  materials: 1000,
  originals: 200,
  originalPages: 20,
  originalBytes: 10 * 1024 * 1024,
  largeOriginalPages: 100,
  largeOriginalBytes: 100 * 1024 * 1024,
  paperItems: 50,
} as const;

export const FIXTURE_VERSION = 1;
export const FIXTURE_FILE = "fixture.json";

export const HIT_KEYWORDS = ["合成命中甲", "合成命中乙", "合成命中丙", "合成命中丁", "合成命中戊"];
export const MISS_KEYWORDS = ["合成无果甲", "合成无果乙", "合成无果丙", "合成无果丁", "合成无果戊"];

export interface FixtureInfo {
  fixtureVersion: number;
  createdAt: string;
  dataDir: string;
  questions: number;
  materials: number;
  originals: number;
  originalsBytes: number;
  paperId: string;
  paperItems: number;
  draftImageId: string;
  draftImageBytes: number;
  databaseBytes: number;
  generatedMs: number;
}

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** 生成指定字节数的 PNG：RGBA 随机像素加尾部填充块，确保渲染有效且大小精确。 */
export function makePng(width: number, height: number, targetBytes: number, seed = 1): Buffer {
  let state = seed >>> 0;
  const random = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) & 0xff;
  };
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 4 + 1);
    raw[row] = 0;
    for (let x = 0; x < width * 4; x++) raw[row + 1 + x] = random();
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const base = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
  if (base.length > targetBytes) throw new Error(`PNG 基础内容已超过目标大小：${base.length} > ${targetBytes}`);
  // 替换 IEND：最终大小 = base - 12 + 12 + 8 + padding。
  const padding = targetBytes - base.length - 8;
  if (padding < 0 || padding > 0xffffff) throw new Error("PNG 填充长度无效");
  const withoutEnd = base.subarray(0, base.length - 12);
  const result = Buffer.concat([withoutEnd, pngChunk("tEXt", Buffer.concat([Buffer.from("Comment\0", "binary"), Buffer.alloc(padding, 0x20)]))]);
  if (result.length !== targetBytes) throw new Error(`PNG 大小无法精确控制：${result.length} != ${targetBytes}`);
  return result;
}

/** 生成页数和总字节数都精确可控的合成 PDF，用未引用的大流填充体积。 */
export function makePdf(pageCount: number, targetBytes: number): { data: Buffer; padOffset: number } {
  const header = Buffer.from("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n", "binary");
  const contentId = 3 + pageCount;
  const padId = 4 + pageCount;
  const objectCount = 4 + pageCount;
  const pattern = Buffer.alloc(65536);
  for (let i = 0; i < pattern.length; i++) pattern[i] = (i * 131 + 17) & 0xff;

  const build = (padLength: number) => {
    const chunks: Buffer[] = [];
    const offsets = new Array<number>(objectCount + 1).fill(0);
    let length = 0;
    const add = (chunk: Buffer) => { chunks.push(chunk); length += chunk.length; };
    const obj = (id: number, body: Buffer | string) => {
      offsets[id] = length;
      add(Buffer.from(`${id} 0 obj\n`, "ascii"));
      add(typeof body === "string" ? Buffer.from(body, "ascii") : body);
      add(Buffer.from("\nendobj\n", "ascii"));
    };
    add(header);
    obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
    const kids = Array.from({ length: pageCount }, (_, index) => `${3 + index} 0 R`).join(" ");
    obj(2, `<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>`);
    for (let index = 0; index < pageCount; index++) {
      obj(3 + index, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << >> /Contents ${contentId} 0 R >>`);
    }
    obj(contentId, "<< /Length 0 >>\nstream\n\nendstream");
    const pad = Buffer.alloc(padLength);
    for (let offset = 0; offset < padLength; offset += pattern.length) pattern.copy(pad, offset, 0, Math.min(pattern.length, padLength - offset));
    offsets[padId] = length;
    add(Buffer.from(`${padId} 0 obj\n<< /Length ${padLength} >>\nstream\n`, "ascii"));
    const padOffset = length;
    add(pad);
    add(Buffer.from("\nendstream\nendobj\n", "ascii"));
    const xrefOffset = length;
    add(Buffer.from(`xref\n0 ${objectCount + 1}\n0000000000 65535 f \n`, "ascii"));
    for (let id = 1; id <= objectCount; id++) add(Buffer.from(`${String(offsets[id]).padStart(10, "0")} 00000 n \n`, "ascii"));
    add(Buffer.from(`trailer\n<< /Size ${objectCount + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`, "ascii"));
    return { data: Buffer.concat(chunks), padOffset };
  };

  const empty = build(0);
  let padLength = targetBytes - empty.data.length;
  let result = build(padLength);
  if (result.data.length !== targetBytes) {
    padLength += targetBytes - result.data.length;
    result = build(padLength);
  }
  if (result.data.length !== targetBytes) throw new Error(`PDF 大小无法精确控制：${result.data.length} != ${targetBytes}`);
  if (result.data.subarray(0, 5).toString() !== "%PDF-") throw new Error("PDF 头无效");
  return result;
}

function writeAttachment(dataDir: string, data: Buffer): string {
  const id = sha256(data);
  const directory = join(dataDir, "attachments");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, id), data);
  return id;
}

function smallPng(): Buffer {
  return Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
}

function classification(index: number): Classification {
  return {
    stage: "初中",
    subject: "数学",
    grade: "九年级",
    examType: "单元测",
    year: "2026",
    sourceName: "合成题库",
    questionType: ["选择题", "填空题", "解答题"][index % 3],
    knowledgePoints: [`合成知识点${index % 20}`, `合成知识点${(index + 7) % 20}`],
  };
}

function paragraph(text: string, formula?: string): QuestionBlock {
  return {
    type: "paragraph",
    runs: formula
      ? [{ type: "text", text, style: "普通" }, { type: "formula", latex: formula }]
      : [{ type: "text", text, style: "普通" }],
  };
}

function questionContent(index: number, material: { materialId: string; versionId: string } | undefined, imageId: string): QuestionContent {
  const hit = index % 5 === 0 ? HIT_KEYWORDS[Math.floor(index / 5) % HIT_KEYWORDS.length] : "";
  const prompt: QuestionBlock[] = [paragraph(`合成初中数学第 ${index + 1} 题${hit ? ` ${hit}` : ""}：已知条件，求解结果。`, "x^{2}+1")];
  if (index % 10 === 0) prompt.push({ type: "table", rows: [["项目", "数值"], ["合成", String(index % 7)]] });
  if (index % 25 === 0) prompt.push({ type: "image", id: imageId, alt: "合成示意图" });
  const options = index % 3 === 0
    ? ["甲", "乙", "丙", "丁"].map((label) => ({ label, content: [paragraph(`合成选项${label}`)] }))
    : [];
  return {
    stem: index % 100 === 0 ? [paragraph("阅读合成题组指令，完成下列小问。")] : [],
    subQuestions: [{
      id: `sub-${index + 1}`,
      originalLabel: "(1)",
      prompt,
      explanation: [paragraph("合成解析：按题意计算。")],
      options,
      slots: [],
      answers: [{ slotId: null, blocks: [paragraph(`合成答案 ${index + 1}`)], variants: [] }],
      scoring: [{ id: `score-${index + 1}`, description: "答案正确", score: 5, slotIds: [] }],
      originalScore: 5,
      materialIds: material ? [material.materialId] : [],
      dependsOn: [],
    }],
    materials: material ? [{ materialId: material.materialId, versionId: material.versionId }] : [],
    selection: { mode: "all" },
    source: { section: "合成题", pdfPage: (index % 20) + 1, originalNumber: String(index + 1) },
  };
}

interface OriginalFile {
  id: string;
  sha256: string;
  relativePath: string;
  name: string;
  size: number;
}

/** 生成 200 份 20 页/10 MiB 与 1 份 100 页/100 MiB 原卷；内容重复但字节唯一。 */
function writeOriginals(dataDir: string): { files: OriginalFile[]; bytes: number } {
  const directory = join(dataDir, "originals");
  mkdirSync(directory, { recursive: true });
  const files: OriginalFile[] = [];
  let bytes = 0;
  const writeOne = (name: string, pages: number, size: number, index: number) => {
    const template = makePdf(pages, size);
    const data = Buffer.from(template.data);
    const marker = Buffer.from(`PW-ORIGINAL-${String(index).padStart(5, "0")}`, "ascii");
    marker.copy(data, template.padOffset);
    const sha = sha256(data);
    const relativePath = `originals/${sha}.pdf`;
    writeFileSync(join(dataDir, relativePath), data);
    files.push({ id: sha, sha256: sha, relativePath, name, size: data.length });
    bytes += data.length;
    return data;
  };
  for (let index = 0; index < SCALE.originals; index++) {
    writeOne(`合成原卷-${String(index + 1).padStart(3, "0")}.pdf`, SCALE.originalPages, SCALE.originalBytes, index);
  }
  writeOne("合成大原卷.pdf", SCALE.largeOriginalPages, SCALE.largeOriginalBytes, SCALE.originals);
  return { files, bytes };
}

function insertExams(db: Database, files: OriginalFile[]): void {
  const at = new Date().toISOString();
  db.transaction((sqlite) => {
    const exam = sqlite.prepare("INSERT INTO exams (id, title, stage, subject, grade, region, exam_type, year, source_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    const section = sqlite.prepare("INSERT INTO exam_sections (id, exam_id, title, subject, position) VALUES (?, ?, ?, ?, ?)");
    const original = sqlite.prepare("INSERT INTO original_files (id, sha256, relative_path, original_name, size, created_at) VALUES (?, ?, ?, ?, ?, ?)");
    const link = sqlite.prepare("INSERT INTO exam_originals (exam_id, file_id, role, created_at) VALUES (?, ?, 'paper', ?)");
    let counter = 0;
    for (const file of files) {
      const examId = randomUUID();
      const sectionId = randomUUID();
      exam.run(examId, `合成考试-${String(++counter).padStart(3, "0")}`, "初中", "数学", "九年级", "本地", "单元测", "2026", "合成题库", at, at);
      section.run(sectionId, examId, "全卷", "数学", 1);
      original.run(file.id, file.sha256, file.relativePath, file.name, file.size, at);
      link.run(examId, file.id, at);
    }
  });
}

function buildDraft(imageId: string): Draft {
  return {
    version: 3,
    blocks: [
      { type: "paragraph", runs: [{ type: "text", text: "合成规模测试草稿：中文、公式、表格与 2 MiB 图片。", style: "普通" }, { type: "formula", latex: "a^{2}+b^{2}" }] },
      { type: "formula", latex: "\\frac{a}{b}" },
      { type: "table", rows: [["项目", "数值"], ["合成", "42"]] },
      { type: "image", id: imageId, alt: "合成 2 MiB 测试图" },
    ],
    teacherAnswer: "合成参考答案",
    sources: [{ pages: [1], uncertain: [] }],
  };
}

function writeMarker(dataDir: string, info: FixtureInfo): void {
  writeFileSync(join(dataDir, FIXTURE_FILE), JSON.stringify(info, null, 2));
}

export function readFixture(dataDir: string): FixtureInfo | undefined {
  const file = join(dataDir, FIXTURE_FILE);
  if (!existsSync(file) || !existsSync(join(dataDir, "paperweave.sqlite"))) return undefined;
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as FixtureInfo;
    return value.fixtureVersion === FIXTURE_VERSION ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 从空目录重建完整规模库。题目、材料与组卷走主进程同一套写入接口，
 * 200 份原卷直接落盘并登记，避免为生成样本再复制 2 GiB。
 */
export async function buildScaleFixture(dataDir: string): Promise<FixtureInfo> {
  const started = Date.now();
  mkdirSync(dataDir, { recursive: true });
  const db = new Database(join(dataDir, "paperweave.sqlite"));
  try {
    const bank = new QuestionBank(db);
    const basket = new Basket(db);
    const papers = new Paper(db);
    const imageId = writeAttachment(dataDir, smallPng());
    const draftImage = makePng(1024, 500, 2 * 1024 * 1024, 20261105);
    const draftImageId = writeAttachment(dataDir, draftImage);

    const created = db.transaction((sqlite) => {
      const materialRefs: { materialId: string; versionId: string }[] = [];
      for (let index = 0; index < SCALE.materials; index++) {
        const material = bank.createMaterialWithin(sqlite, {
          title: `合成材料 ${index + 1}`,
          content: [paragraph(`合成材料正文 ${index + 1}，用于规模测试。`, "y=mx+b")],
          source: "合成题库",
        }, "approved");
        materialRefs.push({ materialId: material.materialId, versionId: material.id });
      }
      const questions: { questionId: string; versionId: string }[] = [];
      for (let index = 0; index < SCALE.questions; index++) {
        const content = questionContent(index, materialRefs[index % materialRefs.length], imageId);
        const version = bank.createQuestionWithin(sqlite, content, classification(index), "approved", "approved");
        questions.push({ questionId: version.questionId, versionId: version.id });
      }
      return { materialCount: materialRefs.length, questions };
    });

    db.saveDraft(JSON.stringify(buildDraft(draftImageId)));

    const paper = papers.createPaper({ title: "九年级数学规模测试卷", stage: "初中", subject: "数学", grade: "九年级" });
    const section = papers.addSection(paper.id, "解答题");
    for (const question of created.questions.slice(0, SCALE.paperItems)) {
      const added = basket.addToBasket(question.questionId, question.versionId, null, true);
      if (added.status !== "added") throw new Error("题篮加入失败");
      papers.addBasketItem(paper.id, section.id, added.item.id);
    }

    const originals = writeOriginals(dataDir);
    insertExams(db, originals.files);

    const info: FixtureInfo = {
      fixtureVersion: FIXTURE_VERSION,
      createdAt: new Date().toISOString(),
      dataDir,
      questions: created.questions.length,
      materials: created.materialCount,
      originals: originals.files.length,
      originalsBytes: originals.bytes,
      paperId: paper.id,
      paperItems: SCALE.paperItems,
      draftImageId,
      draftImageBytes: draftImage.length,
      databaseBytes: 0,
      generatedMs: 0,
    };
    return info;
  } finally {
    db.close();
  }
}

/** 生成后写标记；databaseBytes 需在关库后统计。 */
export async function createFixture(dataDir: string): Promise<FixtureInfo> {
  const started = Date.now();
  const info = await buildScaleFixture(dataDir);
  const { statSync } = await import("node:fs");
  const completed = {
    ...info,
    databaseBytes: statSync(join(dataDir, "paperweave.sqlite")).size,
    generatedMs: Date.now() - started,
  };
  writeMarker(dataDir, completed);
  return completed;
}

export function fixtureSummary(info: FixtureInfo): string {
  return [
    `题目 ${info.questions} 道 / 材料 ${info.materials} 条`,
    `原卷 ${info.originals} 份 / ${(info.originalsBytes / 1024 / 1024).toFixed(0)} MiB`,
    `试卷 ${info.paperItems} 题`,
    `数据库 ${(info.databaseBytes / 1024 / 1024).toFixed(1)} MiB`,
  ].join("；");
}
