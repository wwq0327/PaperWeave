export interface WholePaperAnswerEntry {
  key: string;
  originalNumber: string;
  label: string;
  answer: string;
  page: number;
}

export interface WholePaperAnswerTarget {
  key: string;
  originalNumber: string;
  labels: string[];
  /** 与小问一一对应：已有答案的小问不覆盖。 */
  filled: boolean[];
}

export interface WholePaperAnswerFill {
  targetKey: string;
  index: number;
  entryKey: string;
  answer: string;
}

export interface WholePaperAnswerIssue {
  targetKey: string;
  code: "answer_ambiguous" | "answer_unmatched";
  message: string;
}

export interface WholePaperAnswerSummary {
  total: number;
  matched: number;
  ambiguous: number;
  unmatched: number;
}

export interface WholePaperAnswerMatch {
  summary: WholePaperAnswerSummary;
  fills: WholePaperAnswerFill[];
  issues: WholePaperAnswerIssue[];
  matchedKeys: string[];
  ambiguousKeys: string[];
  unmatchedKeys: string[];
}

/** 小问号比较前统一全角括号并去掉空白；其他字符保持原样，避免误配。 */
export function normalizeWholePaperAnswerLabel(label: string): string {
  return label.replace(/（/g, "(").replace(/）/g, ")").replace(/\s+/gu, "").trim();
}

const labelText = (label: string): string => label.trim() ? `「${label.trim()}」` : "（整题）";

/**
 * 同卷答案唯一匹配：题号与小问号都相等，或答案为整题且该题只有一个小问。
 * 一条答案命中多处、同一小问收到多条答案都按歧义处理，任何歧义都不自动填入。
 */
export function matchWholePaperAnswers(entries: WholePaperAnswerEntry[], targets: WholePaperAnswerTarget[]): WholePaperAnswerMatch {
  const normalizedTargets = targets.map((target) => ({
    ...target,
    originalNumber: target.originalNumber.trim(),
    labels: target.labels.map(normalizeWholePaperAnswerLabel),
  }));
  const normalizedEntries = entries.map((entry) => ({
    ...entry,
    originalNumber: entry.originalNumber.trim(),
    label: normalizeWholePaperAnswerLabel(entry.label),
  }));

  interface Pair {
    target: (typeof normalizedTargets)[number];
    index: number;
  }
  const pairsByEntry = new Map<string, Pair[]>();
  for (const entry of normalizedEntries) {
    const pairs: Pair[] = [];
    for (const target of normalizedTargets) {
      if (target.originalNumber !== entry.originalNumber) continue;
      target.labels.forEach((label, index) => {
        if (entry.label === "" || label === entry.label) pairs.push({ target, index });
      });
    }
    pairsByEntry.set(entry.key, pairs);
  }
  const usersOf = new Map<string, WholePaperAnswerEntry[]>();
  for (const entry of normalizedEntries) {
    for (const pair of pairsByEntry.get(entry.key) ?? []) {
      const pairKey = `${pair.target.key}\u0000${pair.index}`;
      const users = usersOf.get(pairKey) ?? [];
      users.push(entry);
      usersOf.set(pairKey, users);
    }
  }

  const summary: WholePaperAnswerSummary = { total: normalizedEntries.length, matched: 0, ambiguous: 0, unmatched: 0 };
  const fills: WholePaperAnswerFill[] = [];
  const issues: WholePaperAnswerIssue[] = [];
  const issueKeys = new Set<string>();
  const matchedKeys: string[] = [];
  const ambiguousKeys: string[] = [];
  const unmatchedKeys: string[] = [];
  const addIssue = (issue: WholePaperAnswerIssue): void => {
    const key = `${issue.targetKey}\u0000${issue.code}\u0000${issue.message}`;
    if (issueKeys.has(key)) return;
    issueKeys.add(key);
    issues.push(issue);
  };

  for (const entry of normalizedEntries) {
    const pairs = pairsByEntry.get(entry.key) ?? [];
    if (pairs.length === 0) {
      summary.unmatched += 1;
      unmatchedKeys.push(entry.key);
      const sameNumber = normalizedTargets.filter((target) => target.originalNumber === entry.originalNumber);
      for (const target of sameNumber) {
        addIssue({
          targetKey: target.key,
          code: "answer_unmatched",
          message: `答案中的第 ${entry.originalNumber} 题${labelText(entry.label)}未匹配到小问，请手工核对。`,
        });
      }
      continue;
    }
    if (pairs.length > 1) {
      summary.ambiguous += 1;
      ambiguousKeys.push(entry.key);
      for (const targetKey of new Set(pairs.map((pair) => pair.target.key))) {
        addIssue({
          targetKey,
          code: "answer_ambiguous",
          message: `答案中的第 ${entry.originalNumber} 题${labelText(entry.label)}匹配到多个小问，未自动填入，请手工核对。`,
        });
      }
      continue;
    }
    const pair = pairs[0];
    const users = usersOf.get(`${pair.target.key}\u0000${pair.index}`) ?? [];
    if (users.length > 1) {
      summary.ambiguous += 1;
      ambiguousKeys.push(entry.key);
      addIssue({
        targetKey: pair.target.key,
        code: "answer_ambiguous",
        message: `第 ${entry.originalNumber} 题${labelText(entry.label)}有多条答案，未自动填入，请手工核对。`,
      });
      continue;
    }
    summary.matched += 1;
    matchedKeys.push(entry.key);
    if (!pair.target.filled[pair.index]) {
      fills.push({ targetKey: pair.target.key, index: pair.index, entryKey: entry.key, answer: entry.answer });
    }
  }
  return { summary, fills, issues, matchedKeys, ambiguousKeys, unmatchedKeys };
}
