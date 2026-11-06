import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { extractPdfText } from "../../../src/main/pdf-text";

const fixture = (name: string) => new Uint8Array(readFileSync(join(process.cwd(), "tests/fixtures", name)));

test("提取数字 PDF 的逐页文字", async () => {
  const result = await extractPdfText(fixture("text.pdf"));
  expect(result.hasText).toBe(true);
  expect(result.pages).toHaveLength(1);
  expect(result.pages[0].page).toBe(1);
  expect(result.pages[0].text).toContain("Question 1: What is 2 + 2?");
  expect(result.pages[0].text).toContain("Answer: 4");
});

test("多页 PDF 保持页码顺序", async () => {
  const result = await extractPdfText(fixture("two-pages.pdf"));
  expect(result.pages.map((page) => page.page)).toEqual([1, 2]);
  expect(result.pages[0].text).toBe("Page one text.");
  expect(result.pages[1].text).toBe("Page two text.");
});

test("扫描件没有可提取文字时明确返回 hasText=false", async () => {
  const result = await extractPdfText(fixture("blank.pdf"));
  expect(result.hasText).toBe(false);
  expect(result.pages[0].text).toBe("");
});

test("损坏的 PDF 给出可理解错误", async () => {
  await expect(extractPdfText(new TextEncoder().encode("not a pdf"))).rejects.toThrow("无法读取 PDF");
});

test("文本块保留阅读顺序、页内码点偏移与坐标", async () => {
  const result = await extractPdfText(fixture("text.pdf"));
  const page = result.pages[0];
  expect(page.blocks.length).toBeGreaterThan(0);
  const chars = [...page.text];
  for (const block of page.blocks) {
    expect(Number.isInteger(block.start)).toBe(true);
    expect(Number.isInteger(block.end)).toBe(true);
    expect(block.start).toBeGreaterThanOrEqual(0);
    expect(block.end).toBeGreaterThan(block.start);
    expect(chars.slice(block.start, block.end).join("")).toBe(block.text);
    expect(Number.isFinite(block.x)).toBe(true);
    expect(Number.isFinite(block.y)).toBe(true);
    expect(Number.isFinite(block.width)).toBe(true);
    expect(Number.isFinite(block.height)).toBe(true);
  }
  expect(page.blocks.map((block) => block.start)).toEqual([...page.blocks.map((block) => block.start)].sort((a, b) => a - b));
});
