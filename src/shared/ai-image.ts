export interface Point {
  x: number;
  y: number;
}

export interface ImageRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

const minRegion = 0.02;
const round = (value: number) => Math.round(value * 1e6) / 1e6;

/** 将页面上的两个归一化点转成左上角定位的选区；过小选区返回 null。 */
export function normalizeRegion(start: Point, end: Point): ImageRegion | null {
  const x = Math.max(0, Math.min(1, Math.min(start.x, end.x)));
  const y = Math.max(0, Math.min(1, Math.min(start.y, end.y)));
  const right = Math.max(0, Math.min(1, Math.max(start.x, end.x)));
  const bottom = Math.max(0, Math.min(1, Math.max(start.y, end.y)));
  const width = right - x;
  const height = bottom - y;
  if (width < minRegion || height < minRegion) return null;
  return { x: round(x), y: round(y), width: round(width), height: round(height) };
}
