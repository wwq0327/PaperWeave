import { isBlockList, type Block } from "./document";

/** 内容审核状态：草稿、待核、已审核。 */
export type ReviewStatus = "draft" | "pending" | "approved";
/** 答案与评分资料状态：待补、待核、已审核，与内容审核分开记录。 */
export type AnswerStatus = "missing" | "pending" | "approved";

export interface SourcePosition {
  section: string;
  pdfPage: number;
  originalNumber: string;
}

export type SlotKind = "text" | "choice" | "blank";

export interface AnswerSlot {
  id: string;
  label: string;
  kind: SlotKind;
  required: boolean;
  interchangeableWith: string[];
}

export interface AnswerKey {
  slotId: string | null;
  blocks: Block[];
  variants: string[];
}

export interface ScoringPoint {
  id: string;
  description: string;
  score: number;
  slotIds: string[];
}

export interface SubQuestion {
  id: string;
  originalLabel: string;
  prompt: Block[];
  explanation: Block[];
  options: { label: string; content: Block[] }[];
  slots: AnswerSlot[];
  answers: AnswerKey[];
  scoring: ScoringPoint[];
  dependsOn: string[];
}

export type SelectionRule = { mode: "all" } | { mode: "choose"; required: number; candidates: string[] };

export interface QuestionContent {
  stem: Block[];
  subQuestions: SubQuestion[];
  materials: { materialId: string; versionId: string }[];
  selection: SelectionRule;
  source: SourcePosition;
}

const object = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const keys = (x: Record<string, unknown>, allowed: string[]) => Object.keys(x).every((key) => allowed.includes(key));
const id = (x: unknown): x is string => typeof x === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(x);
const text = (x: unknown, max: number): x is string => typeof x === "string" && x.length <= max;
const stringList = (x: unknown, maxItems: number, max: number): x is string[] => Array.isArray(x) && x.length <= maxItems && x.every((item) => text(item, max));
const unique = (values: string[]) => new Set(values).size === values.length;

function sourceProblem(value: unknown): string | null {
  if (!object(value) || !keys(value, ["section", "pdfPage", "originalNumber"])) return "来源位置格式无效";
  if (!text(value.section, 200) || !value.section.trim()) return "来源位置缺少科目分部";
  if (!text(value.originalNumber, 50) || !value.originalNumber.trim()) return "来源位置缺少原题号";
  if (typeof value.pdfPage !== "number" || !Number.isInteger(value.pdfPage) || value.pdfPage < 1 || value.pdfPage > 2000) return "来源页码无效";
  return null;
}

function subQuestionProblem(value: unknown, earlier: Set<string>): string | null {
  if (!object(value) || !keys(value, ["id", "originalLabel", "prompt", "explanation", "options", "slots", "answers", "scoring", "dependsOn"])) return "小问结构无效";
  if (!id(value.id) || earlier.has(value.id)) return "小问标识无效或重复";
  if (!text(value.originalLabel, 50)) return "小问号格式无效";
  if (!isBlockList(value.prompt)) return "小问题干格式无效";
  if (!isBlockList(value.explanation)) return "小问解析格式无效";
  if (!Array.isArray(value.options) || value.options.length > 26) return "选项格式无效";
  const optionLabels = new Set<string>();
  for (const option of value.options) {
    if (!object(option) || !keys(option, ["label", "content"]) || !text(option.label, 50) || !option.label.trim() || optionLabels.has(option.label) || !isBlockList(option.content)) return "选项格式无效";
    optionLabels.add(option.label);
  }
  if (!Array.isArray(value.slots) || value.slots.length > 100) return "作答位置格式无效";
  const slots = new Map<string, AnswerSlot>();
  for (const slot of value.slots) {
    if (!object(slot) || !keys(slot, ["id", "label", "kind", "required", "interchangeableWith"])) return "作答位置格式无效";
    if (!id(slot.id) || slots.has(slot.id)) return "作答位置标识无效或重复";
    if (!text(slot.label, 200) || !slot.label.trim()) return "作答位置缺少标签";
    if (slot.kind !== "text" && slot.kind !== "choice" && slot.kind !== "blank") return "作答位置类型无效";
    if (typeof slot.required !== "boolean") return "作答位置必填标记无效";
    if (!stringList(slot.interchangeableWith, 100, 64)) return "作答位置互换关系无效";
    slots.set(slot.id, slot as unknown as AnswerSlot);
  }
  for (const slot of slots.values()) {
    if (!unique(slot.interchangeableWith) || slot.interchangeableWith.includes(slot.id)) return "作答位置互换关系无效";
    for (const otherId of slot.interchangeableWith) {
      const other = slots.get(otherId);
      if (!other) return "作答位置互换关系引用了不存在的空";
      if (!other.interchangeableWith.includes(slot.id)) return "作答位置互换关系必须互为引用";
    }
  }
  if (!Array.isArray(value.answers) || value.answers.length > 100) return "参考答案格式无效";
  for (const answer of value.answers) {
    if (!object(answer) || !keys(answer, ["slotId", "blocks", "variants"])) return "参考答案格式无效";
    if (answer.slotId !== null && (!id(answer.slotId) || !slots.has(answer.slotId))) return "答案引用了不存在的作答位置";
    if (!isBlockList(answer.blocks) || !stringList(answer.variants, 20, 2000)) return "参考答案格式无效";
  }
  if (!Array.isArray(value.scoring) || value.scoring.length > 100) return "评分点格式无效";
  const scoringIds = new Set<string>();
  for (const point of value.scoring) {
    if (!object(point) || !keys(point, ["id", "description", "score", "slotIds"])) return "评分点格式无效";
    if (!id(point.id) || scoringIds.has(point.id)) return "评分点标识无效或重复";
    if (!text(point.description, 2000) || !point.description.trim()) return "评分点缺少说明";
    if (typeof point.score !== "number" || !Number.isFinite(point.score) || point.score < 0 || point.score > 1000) return "评分分值无效";
    if (!stringList(point.slotIds, 100, 64) || !unique(point.slotIds)) return "评分点作答位置无效";
    if (point.slotIds.some((slotId) => !slots.has(slotId))) return "评分点引用了不存在的作答位置";
    scoringIds.add(point.id);
  }
  if (!stringList(value.dependsOn, 100, 64) || !unique(value.dependsOn)) return "依赖格式无效";
  for (const dependency of value.dependsOn) {
    if (dependency === value.id || !earlier.has(dependency)) return "依赖了不存在或未在前的小问";
  }
  return null;
}

/** 返回第一个结构问题；依赖只能指向同组更早的小问，因此顺序校验天然排除成环。 */
export function questionContentProblem(value: unknown): string | null {
  if (!object(value) || !keys(value, ["stem", "subQuestions", "materials", "selection", "source"])) return "题目结构无效";
  if (!isBlockList(value.stem)) return "题组题干格式无效";
  if (!Array.isArray(value.subQuestions) || value.subQuestions.length < 1 || value.subQuestions.length > 99) return "小问数量无效";
  const earlier = new Set<string>();
  for (const sub of value.subQuestions) {
    const problem = subQuestionProblem(sub, earlier);
    if (problem) return problem;
    earlier.add((sub as SubQuestion).id);
  }
  if (!Array.isArray(value.materials) || value.materials.length > 50) return "材料引用格式无效";
  const materialIds = new Set<string>();
  for (const ref of value.materials) {
    if (!object(ref) || !keys(ref, ["materialId", "versionId"]) || !id(ref.materialId) || !id(ref.versionId)) return "材料引用格式无效";
    if (materialIds.has(ref.materialId)) return "同一材料只能引用一个版本";
    materialIds.add(ref.materialId);
  }
  if (!object(value.selection)) return "组选答规则无效";
  if (value.selection.mode === "all") {
    if (!keys(value.selection, ["mode"])) return "组选答规则无效";
  } else if (value.selection.mode === "choose") {
    if (!keys(value.selection, ["mode", "required", "candidates"])) return "组选答规则无效";
    if (typeof value.selection.required !== "number" || !Number.isInteger(value.selection.required) || value.selection.required < 1) return "组选答数量无效";
    if (!stringList(value.selection.candidates, 99, 64) || !unique(value.selection.candidates)) return "组选答候选项无效";
    if (value.selection.required > value.selection.candidates.length) return "组选答数量超过候选项";
    if (value.selection.candidates.some((candidate) => !earlier.has(candidate))) return "组选答候选引用了不存在的小问";
  } else return "组选答规则无效";
  return sourceProblem(value.source);
}

export function isQuestionContent(value: unknown): value is QuestionContent {
  return questionContentProblem(value) === null;
}

/** 空白段落、空白公式和全空表格不算已填写，图片视为有内容。 */
export function hasContent(blocks: Block[]): boolean {
  return blocks.some((block) => {
    if (block.type === "paragraph") return block.runs.some((run) => run.type === "text" ? run.text.trim() !== "" : run.latex.trim() !== "");
    if (block.type === "formula") return block.latex.trim() !== "";
    if (block.type === "image") return true;
    if (block.type === "table") return block.rows.some((row) => row.some((cell) => cell.trim() !== ""));
    return false;
  });
}

export interface ReadinessInput {
  content: QuestionContent;
  contentStatus: ReviewStatus;
  answerStatus: AnswerStatus;
  confirmAnswerGap: boolean;
  materialStatuses: Record<string, ReviewStatus | undefined>;
}

export interface Readiness {
  ready: boolean;
  blockers: string[];
  notices: string[];
  requiresAnswerConfirmation: boolean;
}

/** 出卷门槛：内容与材料必须已审核；答案或评分待补时需教师明确确认，教师版留下提示。 */
export function questionReadiness(input: ReadinessInput): Readiness {
  const blockers: string[] = [];
  const notices: string[] = [];
  if (input.contentStatus !== "approved") blockers.push("题目内容尚未审核");
  for (const sub of input.content.subQuestions) {
    if (!hasContent(sub.prompt)) blockers.push(`小问「${sub.originalLabel || sub.id}」缺少题干`);
  }
  for (const ref of input.content.materials) {
    const status = input.materialStatuses[ref.versionId];
    if (status === undefined) blockers.push(`材料「${ref.materialId}」缺失`);
    else if (status !== "approved") blockers.push(`材料「${ref.materialId}」尚未审核`);
  }
  const requiresAnswerConfirmation = input.answerStatus !== "approved";
  if (requiresAnswerConfirmation) {
    if (input.confirmAnswerGap) notices.push("答案或评分尚未齐全，教师版将标注待补");
    else blockers.push("答案或评分尚未齐全，需教师确认后出卷");
  }
  return { ready: blockers.length === 0, blockers, notices, requiresAnswerConfirmation };
}

export interface ScoreSummary {
  total: number;
  conflict: string | null;
}

const roundScore = (value: number) => Math.round(value * 100) / 100;
const subQuestionScore = (sub: SubQuestion) => roundScore(sub.scoring.reduce((sum, point) => sum + point.score, 0));

/** 同分候选按“候选分值 × 必选数”计分；候选分值不同或数量不足时显式报冲突，不擅自相加。 */
export function selectionScore(content: QuestionContent): ScoreSummary {
  if (content.selection.mode === "all") {
    return { total: roundScore(content.subQuestions.reduce((sum, sub) => sum + subQuestionScore(sub), 0)), conflict: null };
  }
  if (content.selection.candidates.length === 0) return { total: 0, conflict: "组选答缺少候选项" };
  if (content.selection.required > content.selection.candidates.length) return { total: 0, conflict: "组选答数量超过候选项" };
  const candidates = content.selection.candidates.map((candidate) => content.subQuestions.find((sub) => sub.id === candidate));
  if (candidates.some((candidate) => candidate === undefined)) return { total: 0, conflict: "组选答候选项不存在" };
  const scores = candidates.map((candidate) => subQuestionScore(candidate as SubQuestion));
  if (new Set(scores).size > 1) return { total: 0, conflict: "候选分值不同，需调整卷内分值或改用可表达的题组" };
  return { total: roundScore(scores[0] * content.selection.required), conflict: null };
}
