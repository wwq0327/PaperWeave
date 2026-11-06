import { expect, test } from "vitest";
import type { WholePaperFragment } from "../../../src/shared/whole-paper-batches";
import { wholePaperCoverage } from "../../../src/shared/whole-paper-coverage";

const fragment = (page: number, text: string): WholePaperFragment => ({ page, start: 0, end: [...text].length, text });
const full = (page: number, length: number) => ({ anchor: { page, start: 0, end: length } });

test("整页锚点覆盖 100%，没有缺口", () => {
  const coverage = wholePaperCoverage({
    fragments: [fragment(1, "甲乙丙丁")],
    ignored: [],
    records: [{ originalNumber: "1", page: 1, anchors: [full(1, 4).anchor] }],
  });
  expect(coverage.percent).toBe(100);
  expect(coverage.gaps).toEqual([]);
  expect(coverage.pages).toEqual([{ page: 1, total: 4, covered: 4 }]);
  expect(coverage.duplicates).toEqual([]);
  expect(coverage.missingAnchors).toEqual([]);
});

test("留白与忽略区不计缺口", () => {
  const coverage = wholePaperCoverage({
    fragments: [fragment(1, "题干  答案")],
    ignored: [{ page: 1, start: 4, end: 6, kind: "answer", note: "答案区" }],
    records: [{ originalNumber: "1", page: 1, anchors: [{ page: 1, start: 0, end: 2 }] }],
  });
  expect(coverage.percent).toBe(100);
  expect(coverage.gaps).toEqual([]);
  expect(coverage.pages).toEqual([{ page: 1, total: 4, covered: 4 }]);
});

test("未覆盖文字成为可读缺口", () => {
  const coverage = wholePaperCoverage({
    fragments: [fragment(1, "第一题内容第二题内容")],
    ignored: [],
    records: [{ originalNumber: "1", page: 1, anchors: [{ page: 1, start: 0, end: 5 }] }],
  });
  expect(coverage.percent).toBe(50);
  expect(coverage.gaps).toEqual([{ page: 1, start: 5, end: 10, text: "第二题内容", kind: "unassigned" }]);
});

test("锚点重叠记录为 overlap", () => {
  const coverage = wholePaperCoverage({
    fragments: [fragment(1, "甲乙丙丁戊己")],
    ignored: [],
    records: [
      { originalNumber: "1", page: 1, anchors: [{ page: 1, start: 0, end: 4 }] },
      { originalNumber: "2", page: 1, anchors: [{ page: 1, start: 2, end: 6 }] },
    ],
  });
  expect(coverage.percent).toBe(100);
  expect(coverage.gaps).toEqual([{ page: 1, start: 2, end: 4, text: "丙丁", kind: "overlap" }]);
});

test("同一题号出现在多页记为重复", () => {
  const coverage = wholePaperCoverage({
    fragments: [fragment(1, "甲乙丙丁"), fragment(2, "戊己庚辛")],
    ignored: [],
    records: [
      { originalNumber: "3", page: 1, anchors: [full(1, 4).anchor] },
      { originalNumber: "3", page: 2, anchors: [full(2, 4).anchor] },
    ],
  });
  expect(coverage.percent).toBe(100);
  expect(coverage.duplicates).toEqual([{ originalNumber: "3", pages: [1, 2] }]);
});

test("无锚点但题号可在行首定位时按定位区间覆盖，不报缺失", () => {
  const coverage = wholePaperCoverage({
    fragments: [fragment(1, "1. 第一题内容\n2. 第二题内容")],
    ignored: [],
    records: [
      { originalNumber: "1", page: 1, anchors: [] },
      { originalNumber: "2", page: 1, anchors: [] },
    ],
  });
  expect(coverage.percent).toBe(100);
  expect(coverage.gaps).toEqual([]);
  expect(coverage.missingAnchors).toEqual([]);
});

test("无锚点且题号无法定位时报缺失", () => {
  const coverage = wholePaperCoverage({
    fragments: [fragment(1, "1. 第一题内容")],
    ignored: [],
    records: [{ originalNumber: "9", page: 2, anchors: [] }],
  });
  expect(coverage.missingAnchors).toEqual([{ originalNumber: "9", page: 2 }]);
});
