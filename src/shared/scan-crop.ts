import type { AiScanRect } from "./ai";

export interface ScanCropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 归一化扫描区域转像素裁图框：四周扩边 2%（至少 8px），保证最小边长，
 * 再夹紧到页面内；过小或无效区域返回 null，由调用方标异常。
 */
export function scanCropRect(rect: AiScanRect, pageWidth: number, pageHeight: number, minSize = 160): ScanCropRect | null {
  if (![rect.x, rect.y, rect.width, rect.height, pageWidth, pageHeight].every((value) => Number.isFinite(value))) return null;
  if (pageWidth < 1 || pageHeight < 1 || rect.width <= 0 || rect.height <= 0) return null;
  const left = Math.max(0, Math.min(1, rect.x));
  const top = Math.max(0, Math.min(1, rect.y));
  const right = Math.max(left, Math.min(1, rect.x + rect.width));
  const bottom = Math.max(top, Math.min(1, rect.y + rect.height));
  let x = Math.floor(left * pageWidth);
  let y = Math.floor(top * pageHeight);
  let x2 = Math.ceil(right * pageWidth);
  let y2 = Math.ceil(bottom * pageHeight);
  const margin = Math.max(8, Math.round(Math.min(pageWidth, pageHeight) * 0.02));
  x = Math.max(0, x - margin);
  y = Math.max(0, y - margin);
  x2 = Math.min(pageWidth, x2 + margin);
  y2 = Math.min(pageHeight, y2 + margin);
  const target = Math.max(40, Math.min(minSize, pageWidth, pageHeight));
  if (x2 - x < target) {
    const center = (x + x2) / 2;
    x = Math.max(0, Math.floor(center - target / 2));
    x2 = Math.min(pageWidth, x + target);
    x = Math.max(0, x2 - target);
  }
  if (y2 - y < target) {
    const center = (y + y2) / 2;
    y = Math.max(0, Math.floor(center - target / 2));
    y2 = Math.min(pageHeight, y + target);
    y = Math.max(0, y2 - target);
  }
  const width = x2 - x;
  const height = y2 - y;
  if (width < 40 || height < 40) return null;
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
}
