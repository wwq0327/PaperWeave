import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { expect, test } from "vitest";
import { extractDocxText } from "../../../src/main/docx";

const fixture = (name: string): Buffer => readFileSync(join(process.cwd(), "tests/fixtures", name));

// ---------------------------------------------------------------------------
// 夹具：tests/fixtures/sample.docx（python-docx 生成，合成内容，不含真实试卷）
//
// 实际单元清单：
//   1 → "1. 计算：3 + 5 = （　）"
//   2 → "2. 已知 f(x) = [公式]，求 f(2) 的值。"
//   3 → "3. 观察下图，回答问题：[图片：image1.png]"
//   4 → ""（空段落，保留编号）
//   5 → "项目 | 数量\n苹果 | 3"（2×2 表格，整体一个单元）
// ---------------------------------------------------------------------------

test("读取真实 DOCX 夹具：单元数、编号连续、段落与表格文字正确", () => {
  const result = extractDocxText(fixture("sample.docx"));

  expect(result.units.map((unit) => unit.unit)).toEqual([1, 2, 3, 4, 5]);
  expect(result.units[0].text).toBe("1. 计算：3 + 5 = （　）");
  expect(result.units[1].text).toBe("2. 已知 f(x) = [公式]，求 f(2) 的值。");
  expect(result.units[2].text).toBe("3. 观察下图，回答问题：[图片：image1.png]");
  expect(result.units[3].text).toBe("");
  expect(result.units[4].text).toBe("项目 | 数量\n苹果 | 3");
  expect(result.hasText).toBe(true);
});

test("真实 DOCX 夹具：表格用一个单元输出，行/单元格分隔符稳定", () => {
  const table = extractDocxText(fixture("sample.docx")).units[4];

  expect(table.text.split("\n")).toHaveLength(2);
  expect(table.text.split("\n")[0].split(" | ")).toEqual(["项目", "数量"]);
  expect(table.text.split("\n")[1].split(" | ")).toEqual(["苹果", "3"]);
});

test("真实 DOCX 夹具：公式与图片以占位符保留，图片清单可映射回单元", () => {
  const result = extractDocxText(fixture("sample.docx"));

  expect(result.units[1].text).toContain("[公式]");
  expect(result.units[2].text).toContain("[图片：image1.png]");
  expect(result.images).toEqual([{ name: "image1.png", unit: 3 }]);
  expect(result.warnings).toEqual([]);
});

test("真实 DOCX 夹具：PNG 媒体带段落内码点区间、MIME 与字节", () => {
  const result = extractDocxText(fixture("sample.docx"));
  expect(result.media).toHaveLength(1);
  const media = result.media[0];
  expect(media).toMatchObject({ name: "image1.png", unit: 3, mime: "image/png" });
  const text = [...result.units[2].text].slice(media.start, media.end).join("");
  expect(text).toBe("[图片：image1.png]");
  expect(media.data?.length).toBeGreaterThan(0);
});

test("不支持的媒体格式保留定位并给出待核原因", () => {
  const rels = relsXml(
    `<Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/pic.emf"/>`,
  );
  const result = extractDocxText(makeDocx(drawing("rId5"), rels, [{ name: "word/media/pic.emf", data: Buffer.from("emf") }]));
  expect(result.media).toEqual([
    expect.objectContaining({ name: "pic.emf", unit: 1, mime: null, problem: "不支持的图片格式（仅支持 PNG/JPEG）" }),
  ]);
  expect(result.media[0].data).toBeUndefined();
});

test("真实 DOCX 夹具：空段落保留为空单元，不打断编号", () => {
  const result = extractDocxText(fixture("sample.docx"));
  const empty = result.units.filter((unit) => unit.text === "");

  expect(empty).toEqual([{ unit: 4, text: "" }]);
});

// ---------------------------------------------------------------------------
// 测试内最小 ZIP 写入器：用于构造损坏、缺部件、zip bomb 等合成样本
// ---------------------------------------------------------------------------

interface ZipInput {
  name: string;
  data: Buffer | string;
  method?: 0 | 8;
  /** 仅在 central directory 中伪造解压后大小，用于 zip bomb 保护测试。 */
  declaredUncompressedSize?: number;
}

function buildZip(files: ZipInput[]): Buffer {
  const parts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data, "utf8");
    const method = file.method ?? 8;
    const compressed = method === 8 ? deflateRawSync(data) : data;
    const nameBytes = Buffer.from(file.name, "utf8");
    const declaredSize = file.declaredUncompressedSize ?? data.length;

    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(declaredSize, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    nameBytes.copy(local, 30);
    parts.push(local, compressed);

    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(declaredSize, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    nameBytes.copy(central, 46);
    centralParts.push(central);

    offset += local.length + compressed.length;
  }

  const directory = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...parts, directory, eocd]);
}

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main";
const M_NS = "http://schemas.openxmlformats.org/officeDocument/2006/math";
const R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";

function documentXml(body: string): string {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:document xmlns:w="${W_NS}" xmlns:a="${A_NS}" xmlns:m="${M_NS}" xmlns:r="${R_NS}">` +
    `<w:body>${body}</w:body></w:document>`
  );
}

function makeDocx(body: string, rels?: string, extra: ZipInput[] = []): Buffer {
  const files: ZipInput[] = [{ name: "word/document.xml", data: documentXml(body) }];
  if (rels !== undefined) files.push({ name: "word/_rels/document.xml.rels", data: rels });
  return buildZip([...files, ...extra]);
}

function relsXml(relationships: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${REL_NS}">${relationships}</Relationships>`;
}

function paragraph(text: string): string {
  return `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;
}

function drawing(rId: string): string {
  return (
    `<w:p><w:r><w:drawing><a:graphic><a:graphicData>` +
    `<a:blip r:embed="${rId}"/>` +
    `</a:graphicData></a:graphic></w:drawing></w:r></w:p>`
  );
}

// ---------------------------------------------------------------------------
// 合成样本：解析行为
// ---------------------------------------------------------------------------

test("支持 method 0（stored）压缩的条目", () => {
  const zip = buildZip([
    { name: "word/document.xml", data: documentXml(paragraph("存储方式")), method: 0 },
  ]);

  expect(extractDocxText(zip).units).toEqual([{ unit: 1, text: "存储方式" }]);
});

test("w:tab / w:br 与 XML 实体、数字实体正确还原", () => {
  const body =
    `<w:p><w:r><w:t>a&amp;b&lt;c&gt;d&quot;e&apos;f&#65;&#x42;</w:t></w:r>` +
    `<w:r><w:tab/><w:br/><w:t>末</w:t></w:r></w:p>`;
  const result = extractDocxText(makeDocx(body));

  expect(result.units[0].text).toBe("a&b<c>d\"e'fAB\t\n末");
});

test("行内公式输出 [公式] 占位且不当作普通文字", () => {
  const body =
    `<w:p><w:r><w:t>前</w:t></w:r>` +
    `<m:oMathPara><m:oMath><m:r><m:t>x^2</m:t></m:r></m:oMath></m:oMathPara>` +
    `<w:r><w:t>后</w:t></w:r></w:p>`;
  const result = extractDocxText(makeDocx(body));

  expect(result.units[0].text).toBe("前[公式]后");
  expect(result.units[0].text).not.toContain("x^2");
});

test("图片关系可解析时记录文件名并以 [图片：文件名] 占位", () => {
  const rels = relsXml(
    `<Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/pic.png"/>`,
  );
  const result = extractDocxText(makeDocx(drawing("rId5"), rels));

  expect(result.units[0].text).toBe("[图片：pic.png]");
  expect(result.images).toEqual([{ name: "pic.png", unit: 1 }]);
  expect(result.warnings).toEqual([]);
  expect(result.hasText).toBe(true);
});

test("图片关系缺失时用 [图片] 占位并给出待核 warning", () => {
  const result = extractDocxText(makeDocx(drawing("rId99")));

  expect(result.units[0].text).toBe("[图片]");
  expect(result.images).toEqual([]);
  expect(result.warnings).toHaveLength(1);
  expect(result.warnings[0]).toContain("rId99");
});

test("表格整体一个单元，空单元格保留占位", () => {
  const body =
    `<w:tbl>` +
    `<w:tr><w:tc><w:p><w:r><w:t>甲</w:t></w:r></w:p></w:tc><w:tc><w:p/></w:tc></w:tr>` +
    `<w:tr><w:tc><w:p/></w:tc><w:tc><w:p><w:r><w:t>丁</w:t></w:r></w:p></w:tc></w:tr>` +
    `</w:tbl>`;
  const result = extractDocxText(makeDocx(body));

  expect(result.units).toHaveLength(1);
  expect(result.units[0].text).toBe("甲 | \n | 丁");
});

test("表格内的图片与公式沿用同一单元编号并进入图片清单", () => {
  const rels = relsXml(
    `<Relationship Id="rId7" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/table.png"/>`,
  );
  const body =
    `<w:tbl><w:tr><w:tc>` +
    `<w:p><w:r><w:t>格</w:t></w:r><w:r><w:drawing><a:graphic><a:graphicData><a:blip r:embed="rId7"/></a:graphicData></a:graphic></w:drawing></w:r></w:p>` +
    `</w:tc></w:tr></w:tbl>`;
  const result = extractDocxText(makeDocx(body, rels));

  expect(result.units[0].text).toBe("格[图片：table.png]");
  expect(result.images).toEqual([{ name: "table.png", unit: 1 }]);
});

test("嵌套表格被忽略并给出 warning，外层表格仍是一个单元", () => {
  const body =
    `<w:tbl><w:tr><w:tc>` +
    `<w:p><w:r><w:t>外</w:t></w:r></w:p>` +
    `<w:tbl><w:tr><w:tc><w:p><w:r><w:t>内</w:t></w:r></w:p></w:tc></w:tr></w:tbl>` +
    `</w:tc></w:tr></w:tbl>`;
  const result = extractDocxText(makeDocx(body));

  expect(result.units).toHaveLength(1);
  expect(result.units[0].text).toBe("外");
  expect(result.warnings.some((warning) => warning.includes("嵌套表格"))).toBe(true);
});

test("段落与表格按文档顺序输出，w:sectPr 被忽略", () => {
  const body =
    paragraph("一") +
    `<w:tbl><w:tr><w:tc><w:p><w:r><w:t>表</w:t></w:r></w:p></w:tc></w:tr></w:tbl>` +
    `<w:sectPr/>` +
    paragraph("二");
  const result = extractDocxText(makeDocx(body));

  expect(result.units).toEqual([
    { unit: 1, text: "一" },
    { unit: 2, text: "表" },
    { unit: 3, text: "二" },
  ]);
});

test("空文档返回空单元且 hasText=false", () => {
  const result = extractDocxText(makeDocx(""));

  expect(result.units).toEqual([]);
  expect(result.hasText).toBe(false);
  expect(result.images).toEqual([]);
  expect(result.warnings).toEqual([]);
});

test("2000 个单元可以解析，超过 2000 个单元抛出可读错误", () => {
  const body2000 = "<w:p/>".repeat(2000);
  const ok = extractDocxText(makeDocx(body2000));
  expect(ok.units).toHaveLength(2000);
  expect(ok.hasText).toBe(false);

  const body2001 = "<w:p/>".repeat(2001);
  expect(() => extractDocxText(makeDocx(body2001))).toThrow("DOCX 段落过多，暂只支持 2000 段以内");
});

// ---------------------------------------------------------------------------
// 合成样本：无效输入与保护
// ---------------------------------------------------------------------------

test("非 ZIP 输入抛出「不是有效的 DOCX 文件」", () => {
  expect(() => extractDocxText(Buffer.from("这不是一个 zip 文件"))).toThrow("不是有效的 DOCX 文件");
});

test("加密 OOXML（CFB 容器）抛出「无法读取 DOCX 内容」", () => {
  const cfb = Buffer.concat([
    Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
    Buffer.alloc(504),
  ]);

  expect(() => extractDocxText(cfb)).toThrow("无法读取 DOCX 内容");
});

test("缺少 word/document.xml 抛出「无法读取 DOCX 内容」", () => {
  const zip = buildZip([{ name: "word/styles.xml", data: "<x/>" }]);
  expect(() => extractDocxText(zip)).toThrow("无法读取 DOCX 内容");
});

test("document.xml 不是合法 XML 时抛出「无法读取 DOCX 内容」", () => {
  const zip = buildZip([{ name: "word/document.xml", data: "<w:document><w:body>" }]);
  expect(() => extractDocxText(zip)).toThrow("无法读取 DOCX 内容");
});

test("zip bomb 保护：单条目声明解压后超过 20 MiB 时抛错且不展开", () => {
  const zip = buildZip([
    {
      name: "word/document.xml",
      data: documentXml(paragraph("炸弹")),
      declaredUncompressedSize: 20 * 1024 * 1024 + 1,
    },
  ]);

  expect(() => extractDocxText(zip)).toThrow("DOCX 解压后内容过大，无法读取");
});

test("压缩包条目名含路径穿越时拒绝解析", () => {
  const zip = buildZip([{ name: "../evil.xml", data: "<x/>" }]);
  expect(() => extractDocxText(zip)).toThrow("不是有效的 DOCX 文件");
});
