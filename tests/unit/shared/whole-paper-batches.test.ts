import { describe, expect, it } from "vitest";
import { planWholePaperBatches, wholePaperRequestText } from "../../../src/shared/whole-paper-batches";

describe("整卷文字分批", () => {
  it("按含页码的字符上限无损分批，保留页内偏移与边界", () => {
    const pages = [{ page: 1, text: "甲😀乙丙丁戊己庚辛壬" }, { page: 2, text: "癸子" }];
    const plan = planWholePaperBatches(pages, 20);
    expect(plan.batches.map((batch) => batch.text)).toEqual(["甲😀乙丙丁戊己庚辛", "壬", "癸子"]);
    expect(plan.batches[1]).toMatchObject({ reviewBoundaryBefore: true, fragments: [{ page: 1, start: 9, end: 10, text: "壬" }] });
    expect(plan.batches.map((batch) => batch.text).join("")).toBe(pages.map((page) => page.text).join(""));
    expect(plan.batches.every((batch) => [...wholePaperRequestText(batch)].length <= 20)).toBe(true);
  });

  it("发送文字区分不同原页，报告空白页且保留空白", () => {
    const plan = planWholePaperBatches([{ page: 1, text: "题" }, { page: 2, text: "  " }, { page: 3, text: "" }], 100);
    expect(plan.emptyPages).toEqual([2, 3]);
    expect(plan.batches[0].text).toBe("题  ");
    expect(wholePaperRequestText(plan.batches[0])).toBe("\n[原卷第 1 页]\n题\n[原卷第 2 页]\n  ");
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
