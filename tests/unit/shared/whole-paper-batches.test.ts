import { describe, expect, it } from "vitest";
import { planWholePaperBatches } from "../../../src/shared/whole-paper-batches";

describe("整卷文字分批", () => {
  it("按字符上限无损分批并保留页内偏移与批次边界", () => {
    const pages = [{ page: 1, text: "甲😀乙丙" }, { page: 2, text: "丁戊己" }];
    const plan = planWholePaperBatches(pages, 3);
    expect(plan.batches.map((batch) => batch.text)).toEqual(["甲😀乙", "丙丁戊", "己"]);
    expect(plan.batches[1]).toMatchObject({ pages: [1, 2], reviewBoundaryBefore: true, fragments: [{ page: 1, start: 3, end: 4, text: "丙" }, { page: 2, start: 0, end: 2, text: "丁戊" }] });
    expect(plan.batches.map((batch) => batch.text).join("")).toBe(pages.map((page) => page.text).join(""));
  });

  it("报告空白页且不丢失空白文字", () => {
    const plan = planWholePaperBatches([{ page: 1, text: "题" }, { page: 2, text: "  " }, { page: 3, text: "" }], 10);
    expect(plan.emptyPages).toEqual([2, 3]);
    expect(plan.batches[0].text).toBe("题  ");
  });

  it("每批不超过既有 AI 接口的 50 页限制", () => {
    const plan = planWholePaperBatches(Array.from({ length: 51 }, (_, i) => ({ page: i + 1, text: "题" })));
    expect(plan.batches.map((batch) => batch.pages.length)).toEqual([50, 1]);
  });

  it("拒绝乱序、重复页码及无效上限", () => {
    expect(() => planWholePaperBatches([{ page: 2, text: "a" }, { page: 2, text: "b" }])).toThrow();
    expect(() => planWholePaperBatches([], 8001)).toThrow();
  });
});
