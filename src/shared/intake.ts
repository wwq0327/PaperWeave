import type { TextStyle } from "./document";
import {
  classificationProblem,
  hasContent,
  type AnswerKey,
  type AnswerSlot,
  type AnswerStatus,
  type Classification,
  type QuestionBlock,
  type QuestionContent,
  type QuestionInline,
  type ReferenceKind,
  type ReviewStatus,
  type SelectionRule,
  type SlotKind,
  type SourcePosition,
} from "./question";

/** 录题表单的内容块；文字块内可用 $…$ 写行内公式，单独一行 $$…$$ 为独立公式。 */
export type IntakeBlock =
  | { kind: "text"; text: string; style?: TextStyle; continuesPrevious?: boolean }
  | { kind: "formula"; latex: string }
  | { kind: "image"; id: string; alt: string; figureId?: string }
  | { kind: "table"; rows: string[][] }
  | { kind: "reference"; refKind: ReferenceKind; targetId: string; fallback: string };

const textStyles = new Set<TextStyle>(["普通", "粗体", "斜体", "下划线", "上标", "下标"]);

function readTextStyle(value: unknown, label: string, problems: string[]): TextStyle {
  if (value === undefined) return "普通";
  if (typeof value === "string" && textStyles.has(value as TextStyle)) return value as TextStyle;
  problems.push(`${label}的文字样式无效`);
  return "普通";
}

/** 同一题内的小问号查重：忽略全半角括号、空白与大小写，空号不参与。 */
export function duplicateSubLabels(labels: string[]): string[] {
  const first = new Map<string, string>();
  const reported = new Set<string>();
  const duplicates: string[] = [];
  for (const raw of labels) {
    const label = raw.trim();
    const key = label.replace(/[（）()]/g, "").replace(/\s+/g, "").toLowerCase();
    if (!key) continue;
    const existing = first.get(key);
    if (existing === undefined) { first.set(key, label); continue; }
    if (!reported.has(key)) { duplicates.push(existing); reported.add(key); }
  }
  return duplicates;
}

const referenceKinds = new Set<ReferenceKind>(["subQuestion", "material", "figure"]);
/** 表单中的引用目标，供录题界面选择；label 为插入时写入的回退文字。 */
export interface IntakeReferenceOption {
  kind: ReferenceKind;
  targetId: string;
  label: string;
}

/** 作答位置；互换关系必须与同小问的其他空位互相引用。 */
export interface IntakeSlot {
  id: string;
  label: string;
  kind: SlotKind;
  required: boolean;
  interchangeableWith: string[];
}

export interface IntakeSlotAnswer {
  slotId: string;
  blocks: IntakeBlock[];
}

export interface IntakeScoringPoint {
  description: string;
  score: string;
  slotIds: string[];
}

export interface IntakeSubQuestion {
  key: string;
  id: string;
  originalLabel: string;
  prompt: IntakeBlock[];
  /** 未关联具体作答位置的答案。 */
  answer: IntakeBlock[];
  slotAnswers: IntakeSlotAnswer[];
  explanation: IntakeBlock[];
  options: string;
  /** 选项行对应的整行文字样式，与选项行按位置对应；缺省为普通。 */
  optionStyles?: TextStyle[];
  scoring: IntakeScoringPoint[];
  slots: IntakeSlot[];
  originalScore: string;
  materialIds: string[];
  dependsOn: string[];
}

export interface IntakeMaterial {
  materialId: string;
  versionId: string;
  title: string;
  status?: ReviewStatus;
}

export interface IntakeForm {
  stem: IntakeBlock[];
  subQuestions: IntakeSubQuestion[];
  materials: IntakeMaterial[];
  selection: SelectionRule;
  source: { section: string; pdfPage: string; originalNumber: string };
  classification: Classification;
}

export interface IntakeBuildResult {
  content: QuestionContent | null;
  problems: string[];
}

export interface IntakeDuplicateSummary {
  questionId: string;
  versionId: string;
  version: number;
  contentStatus: ReviewStatus;
  answerStatus: AnswerStatus;
  preview: string;
  source: SourcePosition;
}

export type SaveIntakeResult =
  | {
      saved: true;
      questionId: string;
      versionId: string;
      version: number;
      contentStatus: ReviewStatus;
      answerStatus: AnswerStatus;
    }
  | { saved: false; duplicate: IntakeDuplicateSummary };

export interface IntakeQuestion {
  questionId: string;
  versionId: string;
  version: number;
  contentStatus: ReviewStatus;
  answerStatus: AnswerStatus;
  content: QuestionContent;
  classification: Classification | undefined;
  materials: { materialId: string; versionId: string; title: string; status: ReviewStatus }[];
}

const subIdPattern = /^[A-Za-z0-9_-]{1,64}$/;
const imageIdPattern = /^[a-f0-9]{64}$/;
const newId = (): string => globalThis.crypto.randomUUID();

export function blankBlock(): IntakeBlock {
  return { kind: "text", text: "" };
}

export function blankSubQuestion(): IntakeSubQuestion {
  return {
    key: newId(),
    id: newId(),
    originalLabel: "(1)",
    prompt: [blankBlock()],
    answer: [],
    slotAnswers: [],
    explanation: [],
    options: "",
    optionStyles: [],
    scoring: [],
    slots: [],
    originalScore: "",
    materialIds: [],
    dependsOn: [],
  };
}

export function newIntakeForm(classification: Classification, section: string): IntakeForm {
  return {
    stem: [blankBlock()],
    subQuestions: [blankSubQuestion()],
    materials: [],
    selection: { mode: "all" },
    source: { section, pdfPage: "1", originalNumber: "" },
    classification: { ...classification, knowledgePoints: [...classification.knowledgePoints] },
  };
}

function parseTextBlocks(text: string, label: string, problems: string[], style: TextStyle = "普通", keepLeadingSpace = false): QuestionBlock[] {
  const blocks: QuestionBlock[] = [];
  for (const raw of text.split("\n")) {
    const line = keepLeadingSpace ? raw.trimEnd() : raw.trim();
    if (!line.trim()) continue;
    const display = /^\$\$(.+)\$\$$/.exec(line);
    if (display) {
      if (!display[1].trim()) problems.push(`${label}的公式不能为空`);
      else blocks.push({ type: "formula", latex: display[1] });
      continue;
    }
    const marks = line.match(/\$/g)?.length ?? 0;
    if (marks % 2 !== 0) {
      problems.push(`${label}的公式标记不成对`);
      continue;
    }
    const runs: QuestionInline[] = [];
    let last = 0;
    const pattern = /\$([^$]+)\$/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(line)) !== null) {
      if (match.index > last) runs.push({ type: "text", text: line.slice(last, match.index), style });
      if (!match[1].trim()) problems.push(`${label}的公式不能为空`);
      else runs.push({ type: "formula", latex: match[1] });
      last = match.index + match[0].length;
    }
    if (last < line.length) runs.push({ type: "text", text: line.slice(last), style });
    if (runs.length > 0) blocks.push({ type: "paragraph", runs });
  }
  return blocks;
}

function intakeBlocks(blocks: IntakeBlock[], label: string, problems: string[]): QuestionBlock[] {
  const result: QuestionBlock[] = [];
  for (const block of blocks) {
    if (block.kind === "text") {
      const previous = result[result.length - 1];
      const merges = block.continuesPrevious === true && previous?.type === "paragraph";
      const parsed = parseTextBlocks(block.text, label, problems, readTextStyle(block.style, label, problems), merges);
      if (merges && parsed[0]?.type === "paragraph") {
        previous.runs.push(...parsed[0].runs);
        result.push(...parsed.slice(1));
      } else {
        result.push(...parsed);
      }
      continue;
    }
    if (block.kind === "formula") {
      if (!block.latex.trim()) problems.push(`${label}的公式不能为空`);
      else result.push({ type: "formula", latex: block.latex });
      continue;
    }
    if (block.kind === "reference") {
      const fallback = block.fallback.trim();
      if (!referenceKinds.has(block.refKind)) problems.push(`${label}的引用类型无效`);
      else if (!subIdPattern.test(block.targetId)) problems.push(`${label}的引用目标无效`);
      else if (!fallback) problems.push(`${label}的引用缺少回退文字`);
      else if (fallback.length > 2000) problems.push(`${label}的引用回退文字过长`);
      else result.push({ type: "paragraph", runs: [{ type: "reference", kind: block.refKind, targetId: block.targetId, fallback }] });
      continue;
    }
    if (block.kind === "image") {
      const figureId = block.figureId?.trim();
      if (!imageIdPattern.test(block.id)) problems.push(`${label}含无效图片`);
      else if (figureId !== undefined && figureId !== "" && !subIdPattern.test(figureId)) problems.push(`${label}的图标识无效`);
      else result.push({ type: "image", id: block.id, alt: block.alt.trim() || "题图", ...(figureId ? { figureId } : {}) });
      continue;
    }
    const rows = block.rows.map((row) => row.map((cell) => cell.trim()));
    if (rows.length === 0 || rows.length > 30 || rows.some((row) => row.length === 0 || row.length > 10 || row.length !== rows[0].length)) {
      problems.push(`${label}的表格格式无效`);
      continue;
    }
    result.push({ type: "table", rows });
  }
  return result;
}

function paragraphToIntake(block: Extract<QuestionBlock, { type: "paragraph" }>): IntakeBlock[] {
  const result: IntakeBlock[] = [];
  let text = "";
  let style: TextStyle = "普通";
  const flush = () => {
    if (text.trim()) {
      const previous = result[result.length - 1];
      result.push({
        kind: "text",
        text,
        ...(style === "普通" ? {} : { style }),
        ...(previous?.kind === "text" ? { continuesPrevious: true } : {}),
      });
    }
    text = "";
  };
  for (const run of block.runs) {
    if (run.type === "reference") {
      flush();
      result.push({ kind: "reference", refKind: run.kind, targetId: run.targetId, fallback: run.fallback });
      continue;
    }
    if (run.type === "text") {
      if (text.trim() && run.style !== style) flush();
      style = run.style;
      text += run.text;
    } else {
      text += `$${run.latex}$`;
    }
  }
  flush();
  return result;
}

function blocksToIntake(blocks: QuestionBlock[]): IntakeBlock[] {
  const result: IntakeBlock[] = [];
  for (const block of blocks) {
    if (block.type === "paragraph") result.push(...paragraphToIntake(block));
    else if (block.type === "formula") result.push({ kind: "formula", latex: block.latex });
    else if (block.type === "image") result.push({ kind: "image", id: block.id, alt: block.alt, ...(block.figureId === undefined ? {} : { figureId: block.figureId }) });
    else result.push({ kind: "table", rows: block.rows.map((row) => [...row]) });
  }
  return result;
}

function blocksToText(blocks: QuestionBlock[]): string {
  return blocks.map((block) => {
    if (block.type === "paragraph") return block.runs.map((run) => run.type === "text" ? run.text : run.type === "formula" ? `$${run.latex}$` : run.fallback).join("");
    if (block.type === "formula") return `$$${block.latex}$$`;
    if (block.type === "image") return "[图]";
    return block.rows.map((row) => row.join(" | ")).join("\n");
  }).join("\n");
}

const parseList = (value: string): string[] => [...new Set(value.split(/[,，、]/).map((item) => item.trim()).filter(Boolean))];

const blockHasReference = (block: QuestionBlock): boolean =>
  block.type === "paragraph" && block.runs.some((run) => run.type === "reference");
const blocksHaveReference = (blocks: QuestionBlock[]): boolean => blocks.some(blockHasReference);

/** 选项整行只能有一种文字样式；混合样式无法在单行选项表单中无损表达。 */
function uniformOptionStyle(content: QuestionBlock[]): TextStyle | null {
  let found: TextStyle | null = null;
  for (const block of content) {
    if (block.type !== "paragraph") continue;
    for (const run of block.runs) {
      if (run.type !== "text" || !run.text.trim()) continue;
      if (found === null) found = run.style;
      else if (found !== run.style) return null;
    }
  }
  return found ?? "普通";
}

/** 录题工作台只编辑自己可完整表达的内容；选项引用、混合样式或答案变体先拒绝，避免保存时静默丢失。 */
function editabilityProblem(content: QuestionContent): string | null {
  for (const sub of content.subQuestions) {
    for (const option of sub.options) {
      if (blocksHaveReference(option.content)) return "选项含引用，暂不能在录题工作台编辑";
      if (option.content.some((block) => block.type === "image" || block.type === "table")) return "选项含图片或表格，暂不能在录题工作台编辑";
      if (uniformOptionStyle(option.content) === null) return "选项含混合文字样式，录题工作台不能完整表达；请改用原卷裁图替代";
    }
    for (const answer of sub.answers) {
      if (answer.variants.length > 0) return "该题含答案变体，暂不能在录题工作台编辑";
    }
  }
  return null;
}

/** 将题库内容回填为表单；引用与作答位置完整回填为可编辑块。 */
export function contentToForm(
  content: QuestionContent,
  classification: Classification | undefined,
  materials: { materialId: string; versionId: string; title: string; status: ReviewStatus }[] = [],
): { form?: IntakeForm; problem?: string } {
  const problem = editabilityProblem(content);
  if (problem) return { problem };
  const refs = new Map(materials.map((material) => [material.versionId, material]));
  return {
    form: {
      stem: blocksToIntake(content.stem),
      subQuestions: content.subQuestions.map((sub) => ({
        key: sub.id,
        id: sub.id,
        originalLabel: sub.originalLabel,
        prompt: blocksToIntake(sub.prompt),
        answer: sub.answers.filter((answer) => answer.slotId === null).flatMap((answer) => blocksToIntake(answer.blocks)),
        slotAnswers: sub.answers.flatMap((answer) => answer.slotId === null ? [] : [{ slotId: answer.slotId, blocks: blocksToIntake(answer.blocks) }]),
        explanation: blocksToIntake(sub.explanation),
        options: sub.options.map((option) => blocksToText(option.content)).join("\n"),
        optionStyles: sub.options.map((option) => uniformOptionStyle(option.content) ?? "普通"),
        scoring: sub.scoring.map((point) => ({ description: point.description, score: String(point.score), slotIds: [...point.slotIds] })),
        slots: sub.slots.map((slot) => ({ ...slot, interchangeableWith: [...slot.interchangeableWith] })),
        originalScore: sub.originalScore === null ? "" : String(sub.originalScore),
        materialIds: [...sub.materialIds],
        dependsOn: [...sub.dependsOn],
      })),
      materials: content.materials.map((ref) => {
        const known = refs.get(ref.versionId);
        return { materialId: ref.materialId, versionId: ref.versionId, title: known?.title ?? ref.materialId, status: known?.status };
      }),
      selection: content.selection.mode === "all" ? { mode: "all" } : { mode: "choose", required: content.selection.required, candidates: [...content.selection.candidates] },
      source: { section: content.source.section, pdfPage: String(content.source.pdfPage), originalNumber: content.source.originalNumber },
      classification: classification === undefined ? { stage: "初中", subject: "", grade: "", examType: "", year: "", sourceName: "", questionType: "", knowledgePoints: [] } : { ...classification, knowledgePoints: [...classification.knowledgePoints] },
    },
  };
}

/** 将表单校验并转成题目内容；有问题时返回 null 与全部可读原因。 */
export function buildContent(form: IntakeForm): IntakeBuildResult {
  const problems: string[] = [];
  const stem = intakeBlocks(form.stem, "题干", problems);
  const materialIds = new Set<string>();
  for (const material of form.materials) {
    if (materialIds.has(material.materialId)) problems.push("材料引用重复");
    materialIds.add(material.materialId);
  }
  const seenSubIds = new Set<string>();
  const subQuestions = form.subQuestions.map((sub, index) => {
    const label = sub.originalLabel.trim() ? `第 ${sub.originalLabel.trim()} 小问` : `第 ${index + 1} 小问`;
    if (!subIdPattern.test(sub.id)) problems.push(`${label}的标识无效`);
    if (seenSubIds.has(sub.id)) problems.push(`${label}的标识重复`);
    seenSubIds.add(sub.id);
    const prompt = intakeBlocks(sub.prompt, `${label}题干`, problems);
    const explanation = intakeBlocks(sub.explanation, `${label}解析`, problems);
    const answer = intakeBlocks(sub.answer, `${label}答案`, problems);
    const slots: AnswerSlot[] = [];
    const slotIds = new Set<string>();
    for (const slot of sub.slots) {
      const slotLabel = `${label}的作答位置`;
      if (!subIdPattern.test(slot.id)) problems.push(`${slotLabel}标识无效`);
      else if (slotIds.has(slot.id)) problems.push(`${slotLabel}标识重复`);
      const slotText = slot.label.trim();
      if (!slotText) problems.push(`${slotLabel}缺少标签`);
      else if (slotText.length > 200) problems.push(`${slotLabel}标签过长`);
      if (slot.kind !== "text" && slot.kind !== "choice" && slot.kind !== "blank") problems.push(`${slotLabel}类型无效`);
      if (typeof slot.required !== "boolean") problems.push(`${slotLabel}必答标记无效`);
      if (slotIds.has(slot.id)) continue;
      slotIds.add(slot.id);
      slots.push({ id: slot.id, label: slotText, kind: slot.kind, required: slot.required, interchangeableWith: [] });
    }
    sub.slots.forEach((slot) => {
      const targets: string[] = [];
      for (const targetId of new Set(slot.interchangeableWith)) {
        if (!slotIds.has(targetId)) { problems.push(`${label}的作答位置互换关系引用了不存在的空`); continue; }
        if (targetId === slot.id) { problems.push(`${label}的作答位置不能与自身互换`); continue; }
        const other = sub.slots.find((entry) => entry.id === targetId);
        if (other === undefined || !other.interchangeableWith.includes(slot.id)) { problems.push(`${label}的作答位置互换关系必须互为引用`); continue; }
        targets.push(targetId);
      }
      const built = slots.find((entry) => entry.id === slot.id);
      if (built !== undefined) built.interchangeableWith = targets;
    });
    const answers: AnswerKey[] = [];
    if (answer.length > 0) answers.push({ slotId: null, blocks: answer, variants: [] });
    const answeredSlots = new Set<string>();
    for (const entry of sub.slotAnswers) {
      if (!slotIds.has(entry.slotId)) { problems.push(`${label}的答案引用了不存在的作答位置`); continue; }
      if (answeredSlots.has(entry.slotId)) { problems.push(`${label}的同一作答位置只能有一份答案`); continue; }
      answeredSlots.add(entry.slotId);
      const blocks = intakeBlocks(entry.blocks, `${label}空位答案`, problems);
      if (blocks.length > 0) answers.push({ slotId: entry.slotId, blocks, variants: [] });
    }
    const lines = sub.options.split("\n").map((line) => line.trim()).filter(Boolean);
    if (lines.length > 26) problems.push(`${label}的选项超过 26 个`);
    const optionStyles = sub.optionStyles ?? [];
    const options = lines.map((line, optionIndex) => ({
      label: String.fromCharCode(65 + optionIndex),
      content: parseTextBlocks(line, `${label}选项`, problems, readTextStyle(optionStyles[optionIndex], `${label}选项`, problems)),
    }));
    const scoring = [];
    for (const point of sub.scoring) {
      const description = point.description.trim();
      const scoreText = point.score.trim();
      if (!description && !scoreText) continue;
      if (!description) { problems.push(`${label}的评分点缺少说明`); continue; }
      const score = Number(scoreText);
      if (scoreText === "" || !Number.isFinite(score) || score < 0 || score > 1000) { problems.push(`${label}的评分分值无效`); continue; }
      const pointSlotIds = [...new Set(point.slotIds)];
      if (pointSlotIds.some((slotId) => !slotIds.has(slotId))) { problems.push(`${label}的评分点引用了不存在的作答位置`); continue; }
      scoring.push({ id: newId(), description, score, slotIds: pointSlotIds });
    }
    let originalScore: number | null = null;
    if (sub.originalScore.trim() !== "") {
      const score = Number(sub.originalScore);
      if (!Number.isFinite(score) || score < 0 || score > 1000) problems.push(`${label}的原分值无效`);
      else originalScore = score;
    }
    for (const materialId of sub.materialIds) {
      if (!materialIds.has(materialId)) problems.push(`${label}引用了不在本题材料列表中的材料`);
    }
    return {
      id: sub.id,
      originalLabel: sub.originalLabel,
      prompt,
      explanation,
      options,
      slots,
      answers,
      scoring,
      originalScore,
      materialIds: [...new Set(sub.materialIds)],
      dependsOn: [] as string[],
    };
  });
  const earlier = new Set<string>();
  form.subQuestions.forEach((sub, index) => {
    for (const dependency of sub.dependsOn) {
      if (!earlier.has(dependency)) problems.push(`第 ${sub.originalLabel.trim() || index + 1} 小问依赖的小问不存在或不在前面`);
      else subQuestions[index].dependsOn.push(dependency);
    }
    earlier.add(sub.id);
  });
  const figureIds = new Set<string>();
  const references: { kind: ReferenceKind; targetId: string; label: string }[] = [];
  const scanBlocks = (blocks: QuestionBlock[], blockLabel: string) => {
    for (const block of blocks) {
      if (block.type === "image" && block.figureId !== undefined) {
        if (figureIds.has(block.figureId)) problems.push(`${blockLabel}的图标识重复`);
        else figureIds.add(block.figureId);
      }
      if (block.type !== "paragraph") continue;
      for (const run of block.runs) {
        if (run.type === "reference") references.push({ kind: run.kind, targetId: run.targetId, label: blockLabel });
      }
    }
  };
  scanBlocks(stem, "题干");
  subQuestions.forEach((sub, index) => {
    const subLabel = sub.originalLabel.trim() ? `第 ${sub.originalLabel.trim()} 小问` : `第 ${index + 1} 小问`;
    scanBlocks(sub.prompt, `${subLabel}题干`);
    scanBlocks(sub.explanation, `${subLabel}解析`);
    for (const answer of sub.answers) scanBlocks(answer.blocks, `${subLabel}答案`);
  });
  for (const reference of references) {
    if (reference.kind === "subQuestion" && !seenSubIds.has(reference.targetId)) problems.push(`${reference.label}引用了不存在的小问`);
    else if (reference.kind === "material" && !materialIds.has(reference.targetId)) problems.push(`${reference.label}引用了不在本题材料列表中的材料`);
    else if (reference.kind === "figure" && !figureIds.has(reference.targetId)) problems.push(`${reference.label}引用了不存在的图`);
  }
  if (!hasContent(stem) && !subQuestions.some((sub) => hasContent(sub.prompt))) problems.push("题干或小问题干至少填写一项");
  for (const key of ["section", "originalNumber"] as const) {
    if (!form.source[key].trim()) problems.push(key === "section" ? "请填写卷内分部" : "请填写原题号");
  }
  if (form.source.section.length > 200) problems.push("卷内分部名称过长");
  if (form.source.originalNumber.length > 50) problems.push("原题号过长");
  const page = Number(form.source.pdfPage);
  if (!/^\d+$/.test(form.source.pdfPage.trim()) || !Number.isInteger(page) || page < 1 || page > 2000) problems.push("原卷页码必须是 1–2000 的整数");
  const classProblem = classificationProblem(form.classification);
  if (classProblem) problems.push(`分类无效：${classProblem}`);
  let selection: SelectionRule;
  if (form.selection.mode === "all") selection = { mode: "all" };
  else {
    const candidates = [...new Set(form.selection.candidates)];
    if (candidates.length === 0 || candidates.some((candidate) => !seenSubIds.has(candidate))) problems.push("组选答候选项无效");
    const required = Number(form.selection.required);
    if (!Number.isInteger(required) || required < 1 || required > candidates.length) problems.push("组选答数量无效");
    selection = { mode: "choose", required: Number.isInteger(required) ? required : 1, candidates };
  }
  const unique = [...new Set(problems)];
  if (unique.length > 0) return { content: null, problems: unique };
  return {
    content: {
      stem,
      subQuestions,
      materials: form.materials.map((material) => ({ materialId: material.materialId, versionId: material.versionId })),
      selection,
      source: { section: form.source.section.trim(), pdfPage: page, originalNumber: form.source.originalNumber.trim() },
    },
    problems: [],
  };
}

/** 是否已填任何参考答案；用于提交待核时决定答案状态。 */
export function answerPresent(content: QuestionContent): boolean {
  return content.subQuestions.some((sub) => sub.answers.some((answer) => hasContent(answer.blocks) || answer.variants.length > 0));
}
