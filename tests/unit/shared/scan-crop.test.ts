import { expect, test } from "vitest";
import { scanCropRect } from "../../../src/shared/scan-crop";

test("归一化区域扩边后换算为整数像素框", () => {
  expect(scanCropRect({ x: 0.1, y: 0.2, width: 0.5, height: 0.3 }, 1000, 2000)).toEqual({ x: 80, y: 380, width: 540, height: 640 });
});

test("越界与负坐标夹紧到页面内，极窄区域扩到最小边长", () => {
  const clamped = scanCropRect({ x: -0.2, y: 0.9, width: 1.5, height: 0.5 }, 1000, 800);
  expect(clamped).not.toBeNull();
  expect(clamped!.x).toBe(0);
  expect(clamped!.y).toBeGreaterThanOrEqual(0);
  expect(clamped!.x + clamped!.width).toBeLessThanOrEqual(1000);
  expect(clamped!.y + clamped!.height).toBeLessThanOrEqual(800);

  const tiny = scanCropRect({ x: 0.5, y: 0.5, width: 0.001, height: 0.001 }, 1200, 1600);
  expect(tiny).not.toBeNull();
  expect(tiny!.width).toBeGreaterThanOrEqual(160);
  expect(tiny!.height).toBeGreaterThanOrEqual(160);
});

test("极小页面或无效数值返回 null", () => {
  expect(scanCropRect({ x: 0.5, y: 0.5, width: 0.001, height: 0.001 }, 20, 20)).toBeNull();
  expect(scanCropRect({ x: Number.NaN, y: 0, width: 0.5, height: 0.5 }, 1000, 1000)).toBeNull();
  expect(scanCropRect({ x: 0, y: 0, width: 0, height: 0.5 }, 1000, 1000)).toBeNull();
});
