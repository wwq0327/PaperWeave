import { expect, test } from "vitest";
import { normalizeRegion } from "../../../src/shared/ai-image";

test("拖拽方向任意，选区转为左上角定位的归一化矩形", () => {
  expect(normalizeRegion({ x: 0.8, y: 0.6 }, { x: 0.2, y: 0.1 })).toEqual({ x: 0.2, y: 0.1, width: 0.6, height: 0.5 });
  expect(normalizeRegion({ x: 0.2, y: 0.1 }, { x: 0.8, y: 0.6 })).toEqual({ x: 0.2, y: 0.1, width: 0.6, height: 0.5 });
});

test("超出页面的部分被裁剪到页面内", () => {
  expect(normalizeRegion({ x: -0.2, y: -0.1 }, { x: 1.3, y: 1.2 })).toEqual({ x: 0, y: 0, width: 1, height: 1 });
});

test("过小或零面积选区被忽略，避免误触产生无效裁图", () => {
  expect(normalizeRegion({ x: 0.5, y: 0.5 }, { x: 0.51, y: 0.51 })).toBeNull();
  expect(normalizeRegion({ x: 0.3, y: 0.3 }, { x: 0.3, y: 0.3 })).toBeNull();
});
