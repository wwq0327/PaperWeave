import type { AiIgnoredRange, AiSourceAnchor } from "./ai";
import type { WholePaperFragment } from "./whole-paper-batches";

export interface WholePaperCoverageGap {
  page: number;
  start: number;
  end: number;
  text: string;
  kind: "unassigned" | "overlap";
}

export interface WholePaperCoverageDuplicate {
  originalNumber: string;
  pages: number[];
}

export interface WholePaperCoverage {
  pages: { page: number; total: number; covered: number }[];
  gaps: WholePaperCoverageGap[];
  duplicates: WholePaperCoverageDuplicate[];
  missingAnchors: { originalNumber: string; page: number }[];
  /** 扫描页只按“是否有题目归属”对账，不伪造文字覆盖率。 */
  scanPages: { page: number; covered: boolean }[];
  scanPercent: number;
  answerMatches: { total: number; matched: number; ambiguous: number; unmatched: number };
  percent: number;
}

interface PageText {
  page: number;
  chars: string[];
}

const numberLine = /^\s*(\d{1,3})\s*[.．、]/;
const isContent = (char: string): boolean => !/\s/u.test(char);

/** 从分批片段还原每页文字；片段按页内码点偏移定位，重叠时后写覆盖。 */
function pageTexts(fragments: WholePaperFragment[]): PageText[] {
  const pages = new Map<number, WholePaperFragment[]>();
  for (const fragment of fragments) {
    const list = pages.get(fragment.page) ?? [];
    list.push(fragment);
    pages.set(fragment.page, list);
  }
  return [...pages.entries()]
    .sort(([first], [second]) => first - second)
    .map(([page, list]) => {
      const chars: string[] = [];
      for (const fragment of [...list].sort((first, second) => first.start - second.start)) {
        while (chars.length < fragment.start) chars.push(" ");
        [...fragment.text].forEach((char, index) => { chars[fragment.start + index] = char; });
      }
      return { page, chars };
    });
}

function linesOf(chars: string[]): { start: number; text: string }[] {
  const lines: { start: number; text: string }[] = [];
  let start = 0;
  for (let index = 0; index <= chars.length; index++) {
    if (index === chars.length || chars[index] === "\n") {
      lines.push({ start, text: chars.slice(start, index).join("") });
      start = index + 1;
    }
  }
  return lines;
}

/** 题号行回退定位：从该题号行首到同页下一题号行首（或页末）。 */
export function locateWholePaperAnchor(fragments: WholePaperFragment[], originalNumber: string, page?: number): AiSourceAnchor | undefined {
  const number = originalNumber.trim();
  if (!number) return undefined;
  const pages = pageTexts(fragments);
  const ordered = page === undefined ? pages : [...pages.filter((item) => item.page === page), ...pages.filter((item) => item.page !== page)];
  for (const current of ordered) {
    const lines = linesOf(current.chars);
    for (let index = 0; index < lines.length; index++) {
      const match = numberLine.exec(lines[index].text);
      if (match?.[1] !== number) continue;
      const next = lines.slice(index + 1).find((line) => numberLine.test(line.text));
      return { page: current.page, start: lines[index].start, end: next?.start ?? current.chars.length };
    }
  }
  return undefined;
}

export function wholePaperCoverage(input: {
  fragments: WholePaperFragment[];
  ignored: AiIgnoredRange[];
  records: { originalNumber: string; page: number; anchors: AiSourceAnchor[]; scanPages?: number[] }[];
  scanPages?: number[];
  answerMatches?: { total: number; matched: number; ambiguous: number; unmatched: number };
}): WholePaperCoverage {
  const pages = pageTexts(input.fragments);
  const content = new Map<number, boolean[]>();
  const covered = new Map<number, boolean[]>();
  const anchorCount = new Map<number, number[]>();
  for (const page of pages) {
    content.set(page.page, page.chars.map(isContent));
    covered.set(page.page, new Array(page.chars.length).fill(false));
    anchorCount.set(page.page, new Array(page.chars.length).fill(0));
  }
  const validAnchor = (anchor: AiSourceAnchor): boolean => {
    const chars = pages.find((page) => page.page === anchor.page)?.chars;
    return chars !== undefined && Number.isInteger(anchor.start) && Number.isInteger(anchor.end) && anchor.start >= 0 && anchor.start < anchor.end && anchor.end <= chars.length;
  };
  const apply = (page: number, start: number, end: number, incrementAnchor: boolean): void => {
    const marks = covered.get(page);
    const counts = anchorCount.get(page);
    if (marks === undefined || counts === undefined) return;
    for (let index = Math.max(0, start); index < Math.min(end, marks.length); index++) {
      marks[index] = true;
      if (incrementAnchor) counts[index] += 1;
    }
  };

  const missingAnchors: { originalNumber: string; page: number }[] = [];
  for (const record of input.records) {
    const scanPages = record.scanPages ?? [];
    const anchors = record.anchors.filter(validAnchor);
    const fallback = anchors.length === 0 && scanPages.length === 0 ? locateWholePaperAnchor(input.fragments, record.originalNumber, record.page) : undefined;
    if (anchors.length === 0 && scanPages.length === 0 && fallback === undefined) missingAnchors.push({ originalNumber: record.originalNumber, page: record.page });
    const effective = anchors.length > 0 ? anchors : fallback === undefined ? [] : [fallback];
    for (const anchor of effective) apply(anchor.page, anchor.start, anchor.end, true);
  }
  for (const range of input.ignored) {
    if (validAnchor(range)) apply(range.page, range.start, range.end, false);
  }

  const gaps: WholePaperCoverageGap[] = [];
  const pageReports = pages.map((page) => {
    const chars = page.chars;
    const marks = covered.get(page.page) as boolean[];
    const counts = anchorCount.get(page.page) as number[];
    const contentFlags = content.get(page.page) as boolean[];
    let total = 0;
    let coveredCount = 0;
    for (let index = 0; index < chars.length; index++) {
      if (!contentFlags[index]) continue;
      total += 1;
      if (marks[index]) coveredCount += 1;
    }
    let index = 0;
    while (index < chars.length) {
      if (!contentFlags[index] || counts[index] < 2) { index += 1; continue; }
      const start = index;
      while (index < chars.length && contentFlags[index] && counts[index] >= 2) index += 1;
      gaps.push({ page: page.page, start, end: index, text: chars.slice(start, index).join(""), kind: "overlap" });
    }
    index = 0;
    while (index < chars.length) {
      if (!contentFlags[index] || marks[index]) { index += 1; continue; }
      const start = index;
      while (index < chars.length && contentFlags[index] && !marks[index]) index += 1;
      gaps.push({ page: page.page, start, end: index, text: chars.slice(start, index).join(""), kind: "unassigned" });
    }
    return { page: page.page, total, covered: coveredCount };
  });
  gaps.sort((first, second) => first.page - second.page || first.start - second.start);

  const duplicates: WholePaperCoverageDuplicate[] = [];
  const byNumber = new Map<string, number[]>();
  for (const record of input.records) {
    const number = record.originalNumber.trim();
    if (!number) continue;
    const pagesSeen = byNumber.get(number) ?? [];
    pagesSeen.push(record.page);
    byNumber.set(number, pagesSeen);
  }
  for (const [originalNumber, pagesSeen] of byNumber) {
    if (pagesSeen.length > 1) duplicates.push({ originalNumber, pages: [...new Set(pagesSeen)].sort((first, second) => first - second) });
  }

  const total = pageReports.reduce((sum, page) => sum + page.total, 0);
  const coveredTotal = pageReports.reduce((sum, page) => sum + page.covered, 0);
  const assignedScanPages = new Set(input.records.flatMap((record) => record.scanPages ?? []));
  const scanReports = (input.scanPages ?? []).map((page) => ({ page, covered: assignedScanPages.has(page) }));
  const scanCovered = scanReports.filter((page) => page.covered).length;
  return {
    pages: pageReports,
    gaps,
    duplicates,
    missingAnchors,
    scanPages: scanReports,
    scanPercent: scanReports.length === 0 ? 100 : Math.round((scanCovered / scanReports.length) * 100),
    answerMatches: input.answerMatches ?? { total: 0, matched: 0, ambiguous: 0, unmatched: 0 },
    percent: total === 0 ? 100 : Math.round((coveredTotal / total) * 100),
  };
}
