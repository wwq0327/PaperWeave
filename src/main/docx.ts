import { inflateRawSync } from "node:zlib";

/**
 * 零依赖 DOCX 文字提取（Issue #148）。
 *
 * 只读取 ZIP 中的 `word/document.xml` 与 `word/_rels/document.xml.rels`，
 * 不引入任何 npm 依赖：ZIP 目录用 `node:zlib` 的 `inflateRawSync` 解压。
 *
 * 输出单元按文档顺序排列：`w:body` 直接子节点中的每个 `w:p`（段落）或
 * `w:tbl`（表格）产生一个单元，unit 从 1 连续递增。表格整体算一个单元，
 * 行内公式与内嵌图片以可读占位符保留，并记录图片清单与待核 warning。
 */

export interface DocxUnit {
  unit: number;
  text: string;
}

export interface DocxExtraction {
  units: DocxUnit[];
  /** units 中是否存在非空文字（只有空段落/空表格时为 false）。 */
  hasText: boolean;
  /** 内嵌图片清单：按文档顺序，name 为 media 文件名，unit 为所在单元编号。 */
  images: { name: string; unit: number }[];
  /** 解析中发现的待核问题（图片关系缺失、嵌套表格被忽略等）。 */
  warnings: string[];
}

const MAX_UNITS = 2000;
const MAX_ENTRY_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_BYTES = 100 * 1024 * 1024;

const ZIP_LOCAL_SIGNATURE = 0x04034b50;
const ZIP_CENTRAL_SIGNATURE = 0x02014b50;
const ZIP_EOCD_SIGNATURE = 0x06054b50;
const ZIP_EOCD_SIZE = 22;
const ZIP_MAX_COMMENT = 0xffff;
const ZIP64_MARKER = 0xffffffff;

/** 加密 OOXML / 旧版 .doc 使用 CFB（OLE2）容器。 */
const CFB_SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

const DOCUMENT_PART = "word/document.xml";
const DOCUMENT_RELS_PART = "word/_rels/document.xml.rels";

const NS = {
  w: "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
  m: "http://schemas.openxmlformats.org/officeDocument/2006/math",
  a: "http://schemas.openxmlformats.org/drawingml/2006/main",
  r: "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
  v: "urn:schemas-microsoft-com:vml",
  rel: "http://schemas.openxmlformats.org/package/2006/relationships",
} as const;

const w = (local: string): string => `{${NS.w}}${local}`;
const m = (local: string): string => `{${NS.m}}${local}`;
const a = (local: string): string => `{${NS.a}}${local}`;
const r = (local: string): string => `{${NS.r}}${local}`;
const v = (local: string): string => `{${NS.v}}${local}`;
const rel = (local: string): string => `{${NS.rel}}${local}`;

const W_DOCUMENT = w("document");
const W_BODY = w("body");
const W_P = w("p");
const W_TBL = w("tbl");
const W_TR = w("tr");
const W_TC = w("tc");
const W_T = w("t");
const W_TAB = w("tab");
const W_BR = w("br");
const W_CR = w("cr");
const W_DRAWING = w("drawing");
const W_PICT = w("pict");
const M_O_MATH = m("oMath");
const M_O_MATH_PARA = m("oMathPara");
const A_BLIP = a("blip");
const R_EMBED = r("embed");
const R_ID = r("id");
const V_IMAGE_DATA = v("imagedata");
const REL_RELATIONSHIP = rel("Relationship");

// ---------------------------------------------------------------------------
// ZIP 读取（EOCD → central directory → local header → 压缩数据）
// ---------------------------------------------------------------------------

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

function unreadable(reason: string): Error {
  return new Error(`无法读取 DOCX 内容（${reason}）`);
}

function readZipDirectory(bytes: Buffer): Map<string, ZipEntry> {
  if (bytes.length < ZIP_EOCD_SIZE) throw new Error("不是有效的 DOCX 文件");
  if (bytes.length >= CFB_SIGNATURE.length && bytes.subarray(0, CFB_SIGNATURE.length).equals(CFB_SIGNATURE)) {
    throw unreadable("文件可能已加密或不是 DOCX");
  }
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new Error("不是有效的 DOCX 文件");

  const eocd = findEndOfCentralDirectory(bytes);
  if (eocd < 0) throw new Error("不是有效的 DOCX 文件");

  const diskNumber = bytes.readUInt16LE(eocd + 4);
  const directoryDisk = bytes.readUInt16LE(eocd + 6);
  const entriesOnDisk = bytes.readUInt16LE(eocd + 8);
  const totalEntries = bytes.readUInt16LE(eocd + 10);
  const directorySize = bytes.readUInt32LE(eocd + 12);
  const directoryOffset = bytes.readUInt32LE(eocd + 16);

  if (diskNumber !== 0 || directoryDisk !== 0 || entriesOnDisk !== totalEntries) {
    throw unreadable("暂不支持分卷压缩");
  }
  if (totalEntries === 0xffff || directorySize === ZIP64_MARKER || directoryOffset === ZIP64_MARKER) {
    throw unreadable("暂不支持 ZIP64");
  }
  if (directoryOffset + directorySize > bytes.length) throw unreadable("压缩包目录损坏");

  const entries = new Map<string, ZipEntry>();
  let offset = directoryOffset;
  let totalUncompressed = 0;

  for (let index = 0; index < totalEntries; index++) {
    if (offset + 46 > bytes.length) throw unreadable("压缩包目录损坏");
    if (bytes.readUInt32LE(offset) !== ZIP_CENTRAL_SIGNATURE) throw unreadable("压缩包目录损坏");

    const flags = bytes.readUInt16LE(offset + 8);
    const method = bytes.readUInt16LE(offset + 10);
    const compressedSize = bytes.readUInt32LE(offset + 20);
    const uncompressedSize = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const localHeaderOffset = bytes.readUInt32LE(offset + 42);

    if (offset + 46 + nameLength > bytes.length) throw unreadable("压缩包目录损坏");
    const name = decodeZipEntryName(bytes.subarray(offset + 46, offset + 46 + nameLength), flags);
    offset += 46 + nameLength + extraLength + commentLength;
    if (offset > bytes.length) throw unreadable("压缩包目录损坏");

    if (name.endsWith("/")) continue; // 目录条目
    validateEntryName(name);
    if ((flags & 0x1) !== 0) throw unreadable("文件可能已加密");
    if (
      compressedSize === ZIP64_MARKER ||
      uncompressedSize === ZIP64_MARKER ||
      localHeaderOffset === ZIP64_MARKER
    ) {
      throw unreadable("暂不支持 ZIP64");
    }
    if (uncompressedSize > MAX_ENTRY_BYTES) {
      throw new Error("DOCX 解压后内容过大，无法读取");
    }
    totalUncompressed += uncompressedSize;
    if (totalUncompressed > MAX_TOTAL_BYTES) {
      throw new Error("DOCX 解压后内容过大，无法读取");
    }
    if (entries.has(name)) throw new Error("不是有效的 DOCX 文件（压缩包条目重复）");

    entries.set(name, { name, method, compressedSize, uncompressedSize, localHeaderOffset });
  }

  return entries;
}

function findEndOfCentralDirectory(bytes: Buffer): number {
  const last = bytes.length - ZIP_EOCD_SIZE;
  const first = Math.max(0, bytes.length - ZIP_EOCD_SIZE - ZIP_MAX_COMMENT);
  for (let offset = last; offset >= first; offset--) {
    if (bytes.readUInt32LE(offset) !== ZIP_EOCD_SIGNATURE) continue;
    const commentLength = bytes.readUInt16LE(offset + 20);
    if (offset + ZIP_EOCD_SIZE + commentLength === bytes.length) return offset;
  }
  return -1;
}

function decodeZipEntryName(raw: Buffer, flags: number): string {
  // 未设置 UTF-8 标志时按单字节读取；我们只关心 ASCII 的 OOXML 部件名。
  return (flags & 0x800) !== 0 ? raw.toString("utf8") : raw.toString("latin1");
}

function validateEntryName(name: string): void {
  if (
    name.length === 0 ||
    name.includes("\0") ||
    name.includes("\\") ||
    name.includes(":") ||
    name.startsWith("/")
  ) {
    throw new Error("不是有效的 DOCX 文件（压缩包条目名不合法）");
  }
  if (name.split("/").some((segment) => segment === "..")) {
    throw new Error("不是有效的 DOCX 文件（压缩包条目名不合法）");
  }
}

function readZipEntry(bytes: Buffer, entry: ZipEntry): Buffer {
  const localHeaderOffset = entry.localHeaderOffset;
  if (localHeaderOffset + 30 > bytes.length || bytes.readUInt32LE(localHeaderOffset) !== ZIP_LOCAL_SIGNATURE) {
    throw unreadable("压缩数据损坏");
  }
  const nameLength = bytes.readUInt16LE(localHeaderOffset + 26);
  const extraLength = bytes.readUInt16LE(localHeaderOffset + 28);
  const dataStart = localHeaderOffset + 30 + nameLength + extraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataStart > bytes.length || dataEnd > bytes.length) throw unreadable("压缩数据损坏");
  const compressed = bytes.subarray(dataStart, dataEnd);

  if (entry.method === 0) {
    if (compressed.length !== entry.uncompressedSize) throw unreadable("压缩数据损坏");
    return compressed;
  }
  if (entry.method !== 8) throw unreadable("不支持的压缩方式");

  let inflated: Buffer;
  try {
    inflated = inflateRawSync(compressed, { maxOutputLength: entry.uncompressedSize + 1 });
  } catch {
    throw unreadable("压缩数据损坏");
  }
  if (inflated.length !== entry.uncompressedSize) throw unreadable("压缩数据损坏");
  return inflated;
}

// ---------------------------------------------------------------------------
// 最小 XML 解析（仅支持 DOCX 实际会出现的子集：元素、文本、属性、CDATA、注释、PI）
// ---------------------------------------------------------------------------

interface XmlElement {
  /** 已解析命名空间的名字，形如 `{namespace}localName`。 */
  name: string;
  attrs: Map<string, string>;
  children: XmlNode[];
}

type XmlNode = XmlElement | string;

function malformedXml(): Error {
  return unreadable("文档格式无法解析");
}

function parseXml(source: string): XmlElement {
  const stack: { node: XmlElement; namespaces: Map<string, string> }[] = [];
  let root: XmlElement | undefined;
  let index = 0;

  const appendNode = (node: XmlNode): void => {
    const current = stack[stack.length - 1];
    if (!current) {
      if (typeof node === "string" && node.trim().length === 0) return;
      throw malformedXml();
    }
    if (typeof node === "string" && node.length === 0) return;
    const last = current.node.children[current.node.children.length - 1];
    if (typeof node === "string" && typeof last === "string") {
      current.node.children[current.node.children.length - 1] = last + node;
    } else {
      current.node.children.push(node);
    }
  };

  while (index < source.length) {
    const open = source.indexOf("<", index);
    if (open === -1) {
      appendNode(decodeXmlText(source.slice(index)));
      break;
    }
    if (open > index) appendNode(decodeXmlText(source.slice(index, open)));

    if (source.startsWith("<!--", open)) {
      const end = source.indexOf("-->", open + 4);
      if (end === -1) throw malformedXml();
      index = end + 3;
      continue;
    }
    if (source.startsWith("<![CDATA[", open)) {
      const end = source.indexOf("]]>", open + 9);
      if (end === -1) throw malformedXml();
      appendNode(source.slice(open + 9, end));
      index = end + 3;
      continue;
    }
    if (source.startsWith("<?", open)) {
      const end = source.indexOf("?>", open + 2);
      if (end === -1) throw malformedXml();
      index = end + 2;
      continue;
    }
    if (source.startsWith("<!", open)) {
      const end = findDeclarationEnd(source, open + 2);
      if (end === -1) throw malformedXml();
      index = end + 1;
      continue;
    }
    if (source[open + 1] === "/") {
      const close = source.indexOf(">", open + 2);
      if (close === -1) throw malformedXml();
      const rawName = source.slice(open + 2, close).trim();
      const top = stack.pop();
      if (!top || top.node.name !== resolveName(rawName, top.namespaces)) throw malformedXml();
      index = close + 1;
      continue;
    }

    const close = findTagEnd(source, open + 1);
    if (close === -1) throw malformedXml();
    let tag = source.slice(open + 1, close);
    const selfClosing = tag.endsWith("/");
    if (selfClosing) tag = tag.slice(0, -1);
    tag = tag.trim();
    if (tag.length === 0) throw malformedXml();

    const nameEnd = tag.search(/\s/);
    const rawName = nameEnd === -1 ? tag : tag.slice(0, nameEnd);
    const rawAttrs = parseAttributes(nameEnd === -1 ? "" : tag.slice(nameEnd));

    const parentNamespaces = stack.length > 0 ? stack[stack.length - 1].namespaces : new Map<string, string>();
    const namespaces = new Map(parentNamespaces);
    for (const [attrName, attrValue] of rawAttrs) {
      if (attrName === "xmlns") namespaces.set("", attrValue);
      else if (attrName.startsWith("xmlns:")) namespaces.set(attrName.slice(6), attrValue);
    }

    const node: XmlElement = { name: resolveName(rawName, namespaces), attrs: new Map(), children: [] };
    for (const [attrName, attrValue] of rawAttrs) {
      if (attrName === "xmlns" || attrName.startsWith("xmlns:")) continue;
      // 限定前缀属性（如 r:embed）带命名空间；无前缀属性不带默认命名空间。
      node.attrs.set(attrName.includes(":") ? resolveName(attrName, namespaces) : attrName, decodeXmlText(attrValue));
    }

    if (stack.length === 0) {
      if (root) throw malformedXml();
      root = node;
    } else {
      stack[stack.length - 1].node.children.push(node);
    }
    if (!selfClosing) stack.push({ node, namespaces });
    index = close + 1;
  }

  if (!root || stack.length > 0) throw malformedXml();
  return root;
}

function findTagEnd(source: string, start: number): number {
  let quote = "";
  for (let i = start; i < source.length; i++) {
    const char = source[i];
    if (quote) {
      if (char === quote) quote = "";
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === ">") {
      return i;
    }
  }
  return -1;
}

/** 跳过 `<!DOCTYPE ...>`（内部子集里的 `>` 不算结束）。 */
function findDeclarationEnd(source: string, start: number): number {
  let bracketDepth = 0;
  for (let i = start; i < source.length; i++) {
    const char = source[i];
    if (char === "[") bracketDepth++;
    else if (char === "]") bracketDepth = Math.max(0, bracketDepth - 1);
    else if (char === ">" && bracketDepth === 0) return i;
  }
  return -1;
}

function parseAttributes(text: string): [string, string][] {
  const attrs: [string, string][] = [];
  const pattern = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    attrs.push([match[1], match[2] ?? match[3] ?? ""]);
  }
  return attrs;
}

function resolveName(qualifiedName: string, namespaces: Map<string, string>): string {
  const colon = qualifiedName.indexOf(":");
  if (colon === -1) {
    const defaultNamespace = namespaces.get("");
    return defaultNamespace ? `{${defaultNamespace}}${qualifiedName}` : qualifiedName;
  }
  const prefix = qualifiedName.slice(0, colon);
  const namespace = namespaces.get(prefix);
  return namespace ? `{${namespace}}${qualifiedName.slice(colon + 1)}` : qualifiedName;
}

function decodeXmlText(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (match, entity: string) => {
    switch (entity) {
      case "amp":
        return "&";
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "quot":
        return '"';
      case "apos":
        return "'";
      default: {
        const codePoint = entity.startsWith("#x") || entity.startsWith("#X")
          ? Number.parseInt(entity.slice(2), 16)
          : Number.parseInt(entity.slice(1), 10);
        if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return match;
        try {
          return String.fromCodePoint(codePoint);
        } catch {
          return match;
        }
      }
    }
  });
}

// ---------------------------------------------------------------------------
// OOXML 语义提取
// ---------------------------------------------------------------------------

interface ExtractState {
  relations: Map<string, string>;
  images: { name: string; unit: number }[];
  warnings: string[];
}

export function extractDocxText(bytes: Buffer): DocxExtraction {
  const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const entries = readZipDirectory(data);

  const documentEntry = entries.get(DOCUMENT_PART);
  if (!documentEntry) throw new Error("无法读取 DOCX 内容（缺少 word/document.xml）");
  const documentRoot = parseXml(readZipEntry(data, documentEntry).toString("utf8"));
  if (documentRoot.name !== W_DOCUMENT) throw new Error("无法读取 DOCX 内容（文档根节点不是 w:document）");

  const body = findChild(documentRoot, W_BODY);
  if (!body) throw new Error("无法读取 DOCX 内容（缺少文档正文）");

  const state: ExtractState = { relations: new Map(), images: [], warnings: [] };
  const relsEntry = entries.get(DOCUMENT_RELS_PART);
  if (relsEntry) {
    try {
      collectRelations(parseXml(readZipEntry(data, relsEntry).toString("utf8")), state.relations);
    } catch {
      state.warnings.push("DOCX 图片关系文件无法解析，图片将以 [图片] 占位");
    }
  }

  const units = extractBodyUnits(body, state);
  return {
    units,
    hasText: units.some((unit) => unit.text.trim().length > 0),
    images: state.images,
    warnings: [...new Set(state.warnings)],
  };
}

function extractBodyUnits(body: XmlElement, state: ExtractState): DocxUnit[] {
  const units: DocxUnit[] = [];
  for (const child of body.children) {
    if (typeof child === "string") continue;
    if (child.name !== W_P && child.name !== W_TBL) continue; // w:sectPr 等忽略
    if (units.length >= MAX_UNITS) throw new Error("DOCX 段落过多，暂只支持 2000 段以内");
    const unit = units.length + 1;
    const text = child.name === W_P ? paragraphText(child, unit, state) : tableText(child, unit, state);
    units.push({ unit, text });
  }
  return units;
}

function paragraphText(paragraph: XmlElement, unit: number, state: ExtractState): string {
  const parts: string[] = [];
  appendInline(paragraph, parts, unit, state);
  return parts.join("");
}

function appendInline(element: XmlElement, parts: string[], unit: number, state: ExtractState): void {
  for (const child of element.children) {
    if (typeof child === "string") continue;
    switch (child.name) {
      case M_O_MATH:
      case M_O_MATH_PARA:
        parts.push("[公式]");
        break;
      case W_T:
        parts.push(textOf(child));
        break;
      case W_TAB:
        parts.push("\t");
        break;
      case W_BR:
      case W_CR:
        parts.push("\n");
        break;
      case W_DRAWING:
      case W_PICT:
        appendImagePlaceholders(child, parts, unit, state);
        break;
      default:
        appendInline(child, parts, unit, state);
    }
  }
}

function textOf(element: XmlElement): string {
  let text = "";
  for (const child of element.children) {
    if (typeof child === "string") text += child;
  }
  return text;
}

function appendImagePlaceholders(
  graphic: XmlElement,
  parts: string[],
  unit: number,
  state: ExtractState,
): void {
  const relationIds: string[] = [];
  for (const blip of descendants(graphic, A_BLIP)) {
    const embed = blip.attrs.get(R_EMBED);
    if (embed) relationIds.push(embed);
  }
  for (const imageData of descendants(graphic, V_IMAGE_DATA)) {
    const id = imageData.attrs.get(R_ID);
    if (id) relationIds.push(id);
  }

  for (const relationId of relationIds) {
    const name = state.relations.get(relationId);
    if (name) {
      parts.push(`[图片：${name}]`);
      state.images.push({ name, unit });
    } else {
      parts.push("[图片]");
      state.warnings.push(`第 ${unit} 段内嵌图片关系 ${relationId} 未找到，已用 [图片] 占位`);
    }
  }
}

function tableText(table: XmlElement, unit: number, state: ExtractState): string {
  const rows: string[] = [];
  for (const row of childrenByName(table, W_TR)) {
    const cells: string[] = [];
    for (const cell of childrenByName(row, W_TC)) {
      if (descendants(cell, W_TBL).length > 0) {
        state.warnings.push(`第 ${unit} 段表格包含嵌套表格，已忽略`);
      }
      const paragraphs: string[] = [];
      for (const cellChild of cell.children) {
        if (typeof cellChild === "string" || cellChild.name !== W_P) continue;
        paragraphs.push(paragraphText(cellChild, unit, state));
      }
      // 空单元格保留为空字符串，用 ` | ` 分隔时占位仍然可见。
      cells.push(paragraphs.join("\n"));
    }
    rows.push(cells.join(" | "));
  }
  return rows.join("\n");
}

function collectRelations(relationships: XmlElement, target: Map<string, string>): void {
  for (const child of relationships.children) {
    if (typeof child === "string" || child.name !== REL_RELATIONSHIP) continue;
    const id = child.attrs.get("Id");
    const targetPath = child.attrs.get("Target");
    const targetMode = child.attrs.get("TargetMode");
    if (!id || !targetPath) continue;
    if (targetMode && targetMode.toLowerCase() === "external") continue;
    const name = mediaFileName(targetPath);
    if (name) target.set(id, name);
  }
}

function mediaFileName(target: string): string | null {
  const normalized = target.replace(/\\/g, "/");
  const base = normalized.slice(normalized.lastIndexOf("/") + 1);
  if (!base || base === "." || base === "..") return null;
  return base;
}

function findChild(element: XmlElement, name: string): XmlElement | undefined {
  for (const child of element.children) {
    if (typeof child !== "string" && child.name === name) return child;
  }
  return undefined;
}

function childrenByName(element: XmlElement, name: string): XmlElement[] {
  return element.children.filter((child): child is XmlElement => typeof child !== "string" && child.name === name);
}

function descendants(element: XmlElement, name: string): XmlElement[] {
  const found: XmlElement[] = [];
  for (const child of element.children) {
    if (typeof child === "string") continue;
    if (child.name === name) found.push(child);
    found.push(...descendants(child, name));
  }
  return found;
}
