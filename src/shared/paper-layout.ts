import type { Block } from "./document";
import type { BlankSpace, PaperScoring, PaperScoringState } from "./paper";
import type {
  AnswerKey,
  AnswerSlot,
  QuestionBlock,
  QuestionContent,
  ReferenceInline,
  ReferenceKind,
  ScoringPoint,
  SourcePosition,
  Stage,
} from "./question";
import type { Volume } from "./volume";

export interface SnapshotItemInput {
  id: string;
  questionId: string;
  questionVersionId: string;
  subQuestionIds: string[];
  score: number;
  blankSpace: BlankSpace;
  scoring: PaperScoring;
  scoringState: PaperScoringState;
  /** 答案或评分待补且教师已确认出卷；仅教师卷输出提示。 */
  answerGap?: boolean;
  content: QuestionContent;
}

export interface SnapshotSectionInput {
  title: string;
  items: SnapshotItemInput[];
}

export interface SnapshotInput {
  paper: { id: string; title: string; stage: Stage; subject: string; grade: string };
  sections: SnapshotSectionInput[];
  materialVersion: (versionId: string) => { title: string; content: Block[]; source: string } | undefined;
}

export interface SnapshotSubQuestion {
  id: string;
  label: string;
  originalLabel: string;
  prompt: QuestionBlock[];
  options: { label: string; content: QuestionBlock[] }[];
  slots?: AnswerSlot[];
  answers: AnswerKey[];
  explanation: QuestionBlock[];
  scoring: ScoringPoint[];
  originalScore: number | null;
}

export interface SnapshotItem {
  id: string;
  number: string;
  questionId: string;
  questionVersionId: string;
  source: SourcePosition;
  score: number;
  blankSpace: BlankSpace;
  scoring: PaperScoring;
  scoringState: PaperScoringState;
  answerGap: boolean;
  stem: QuestionBlock[];
  subQuestions: SnapshotSubQuestion[];
  /** 题目完整材料池，用于把 materialId 解析到版本。 */
  materials: { materialId: string; versionId: string }[];
}

export interface SnapshotMaterial {
  materialId: string;
  versionId: string;
  label: string;
  title: string | null;
  content: Block[] | null;
  source: string | null;
  itemIds: string[];
  missing: boolean;
}

export interface SnapshotFigure {
  itemId: string;
  figureId: string;
  label: string;
  alt: string;
}

export interface SnapshotSection {
  title: string;
  number: string;
  items: SnapshotItem[];
}

export interface PaperSnapshot {
  paper: { id: string; title: string; stage: Stage; subject: string; grade: string };
  totalScore: number;
  sections: SnapshotSection[];
  materials: SnapshotMaterial[];
  figures: SnapshotFigure[];
}

export interface ResolvedReference {
  itemId: string;
  itemNumber: string;
  blockPath: string;
  kind: ReferenceKind;
  targetId: string;
  label: string | null;
  reason?: string;
}

export interface VolumeSubQuestion {
  id: string;
  label: string;
  prompt: QuestionBlock[];
  options: { label: string; content: QuestionBlock[] }[];
  slots: AnswerSlot[];
  originalLabel?: string;
  answers?: AnswerKey[];
  explanation?: QuestionBlock[];
  scoring?: ScoringPoint[];
  originalScore?: number | null;
}

export interface VolumeItem {
  id: string;
  number: string;
  score: number;
  blankSpace: BlankSpace;
  source: SourcePosition;
  stem: QuestionBlock[];
  subQuestions: VolumeSubQuestion[];
  materialLabels: string[];
  scoring?: PaperScoring;
  scoringState?: PaperScoringState;
  answerGap?: boolean;
}

export interface VolumePaper {
  paper: PaperSnapshot["paper"];
  totalScore: number;
  sections: { title: string; number: string; items: VolumeItem[] }[];
  materials: { label: string; title: string | null; content: Block[] | null }[];
  figures: SnapshotFigure[];
}

const roundScore = (value: number) => Math.round(value * 100) / 100;
const materialKey = (materialId: string, versionId: string) => `${materialId}\u0000${versionId}`;

function chineseNumber(value: number): string {
  const digits = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"];
  if (!Number.isInteger(value) || value < 1 || value > 99) return String(value);
  if (value < 10) return digits[value];
  const tens = Math.floor(value / 10);
  const ones = value % 10;
  return `${tens === 1 ? "" : digits[tens]}十${ones === 0 ? "" : digits[ones]}`;
}

/** 冻结组卷：卷内编号、材料/图去重、所选小问重排；不改写题目内容。 */
export function buildPaperSnapshot(input: SnapshotInput): PaperSnapshot {
  const materials: SnapshotMaterial[] = [];
  const materialIndex = new Map<string, SnapshotMaterial>();
  const figures: SnapshotFigure[] = [];
  let itemCounter = 0;
  let totalScore = 0;

  const sections = input.sections.map((section, sectionIndex) => ({
    title: section.title,
    number: chineseNumber(sectionIndex + 1),
    items: section.items.map((inputItem) => {
      itemCounter += 1;
      totalScore = roundScore(totalScore + inputItem.score);
      const byId = new Map(inputItem.content.subQuestions.map((sub) => [sub.id, sub]));
      const selected = inputItem.subQuestionIds.map((id) => {
        const sub = byId.get(id);
        if (sub === undefined) throw new Error(`组卷数据损坏：小问不存在（${id}）`);
        return sub;
      });

      for (const sub of selected) {
        for (const materialId of sub.materialIds) {
          const ref = inputItem.content.materials.find((material) => material.materialId === materialId);
          if (ref === undefined) throw new Error(`组卷数据损坏：材料引用不存在（${materialId}）`);
          const key = materialKey(materialId, ref.versionId);
          let material = materialIndex.get(key);
          if (material === undefined) {
            const version = input.materialVersion(ref.versionId);
            material = {
              materialId,
              versionId: ref.versionId,
              label: `材料${chineseNumber(materials.length + 1)}`,
              title: version?.title ?? null,
              content: version?.content ?? null,
              source: version?.source ?? null,
              itemIds: [],
              missing: version === undefined,
            };
            materials.push(material);
            materialIndex.set(key, material);
          }
          if (!material.itemIds.includes(inputItem.id)) material.itemIds.push(inputItem.id);
        }
      }

      const itemFigures = new Map<string, SnapshotFigure>();
      const scan = (blocks: QuestionBlock[]) => {
        for (const block of blocks) {
          if (block.type !== "image" || block.figureId === undefined || itemFigures.has(block.figureId)) continue;
          const figure = { itemId: inputItem.id, figureId: block.figureId, label: `图 ${figures.length + 1}`, alt: block.alt };
          figures.push(figure);
          itemFigures.set(block.figureId, figure);
        }
      };
      scan(inputItem.content.stem);
      for (const sub of selected) {
        scan(sub.prompt);
        for (const option of sub.options) scan(option.content);
        for (const answer of sub.answers) scan(answer.blocks);
        scan(sub.explanation);
      }

      return {
        id: inputItem.id,
        number: String(itemCounter),
        questionId: inputItem.questionId,
        questionVersionId: inputItem.questionVersionId,
        source: inputItem.content.source,
        score: inputItem.score,
        blankSpace: inputItem.blankSpace,
        scoring: inputItem.scoring,
        scoringState: inputItem.scoringState,
        answerGap: inputItem.answerGap === true,
        stem: inputItem.content.stem,
        subQuestions: selected.map((sub, index) => ({
          id: sub.id,
          label: `(${index + 1})`,
          originalLabel: sub.originalLabel,
          prompt: sub.prompt,
          options: sub.options,
          slots: sub.slots,
          answers: sub.answers,
          explanation: sub.explanation,
          scoring: sub.scoring,
          originalScore: sub.originalScore,
        })),
        materials: inputItem.content.materials.map((material) => ({ ...material })),
      };
    }),
  }));

  return { paper: input.paper, totalScore, sections, materials, figures };
}

interface ItemContext {
  item: SnapshotItem;
  subLabels: Map<string, string>;
  materialLabels: Map<string, string>;
  figureLabels: Map<string, string>;
}

function itemContexts(snapshot: PaperSnapshot): ItemContext[] {
  return snapshot.sections.flatMap((section) => section.items.map((item) => {
    const materials = new Map<string, string>();
    for (const ref of item.materials) {
      const material = snapshot.materials.find((entry) => entry.materialId === ref.materialId && entry.versionId === ref.versionId);
      if (material !== undefined && material.itemIds.includes(item.id)) materials.set(ref.materialId, material.label);
    }
    return {
      item,
      subLabels: new Map(item.subQuestions.map((sub) => [sub.id, sub.label])),
      materialLabels: materials,
      figureLabels: new Map(snapshot.figures.filter((figure) => figure.itemId === item.id).map((figure) => [figure.figureId, figure.label])),
    };
  }));
}

interface LocatedReference {
  blockPath: string;
  run: ReferenceInline;
}

function locatedReferences(item: SnapshotItem): LocatedReference[] {
  const found: LocatedReference[] = [];
  const walk = (blocks: QuestionBlock[], path: string) => {
    blocks.forEach((block, blockIndex) => {
      if (block.type !== "paragraph") return;
      block.runs.forEach((run, runIndex) => {
        if (run.type === "reference") found.push({ blockPath: `${path}[${blockIndex}].runs[${runIndex}]`, run });
      });
    });
  };
  walk(item.stem, "stem");
  for (const sub of item.subQuestions) {
    walk(sub.prompt, `subQuestions[${sub.id}].prompt`);
    for (const option of sub.options) walk(option.content, `subQuestions[${sub.id}].options[${option.label}].content`);
    sub.answers.forEach((answer, index) => walk(answer.blocks, `subQuestions[${sub.id}].answers[${index}].blocks`));
    walk(sub.explanation, `subQuestions[${sub.id}].explanation`);
  }
  return found;
}

function resolveLabel(context: ItemContext, kind: ReferenceKind, targetId: string): string | null {
  if (kind === "subQuestion") return context.subLabels.get(targetId) ?? null;
  if (kind === "material") return context.materialLabels.get(targetId) ?? null;
  return context.figureLabels.get(targetId) ?? null;
}

function unresolvedReason(kind: ReferenceKind): string {
  if (kind === "subQuestion") return "目标小问未加入本卷";
  if (kind === "material") return "目标材料未在本卷使用";
  return "目标图未在本卷出现";
}

/** 把题库中的引用节点解析为卷内编号；目标不在本卷时 label 为 null。 */
export function resolvePaperReferences(snapshot: PaperSnapshot): ResolvedReference[] {
  return itemContexts(snapshot).flatMap((context) => locatedReferences(context.item).map(({ blockPath, run }) => {
    const label = resolveLabel(context, run.kind, run.targetId);
    return {
      itemId: context.item.id,
      itemNumber: context.item.number,
      blockPath,
      kind: run.kind,
      targetId: run.targetId,
      label,
      ...(label === null ? { reason: unresolvedReason(run.kind) } : {}),
    };
  }));
}

function resolveBlocks(blocks: QuestionBlock[], context: ItemContext): QuestionBlock[] {
  return blocks.map((block) => {
    if (block.type !== "paragraph") return block;
    return {
      ...block,
      runs: block.runs.map((run) =>
        run.type === "reference"
          ? { type: "text" as const, text: resolveLabel(context, run.kind, run.targetId) ?? run.fallback, style: "普通" as const }
          : run,
      ),
    };
  });
}

/** 按卷生成允许字段：学生卷结构上没有答案、解析与评分点，不靠隐藏实现隔离。 */
export function paperVolume(snapshot: PaperSnapshot, volume: Volume): VolumePaper {
  const contexts = new Map(itemContexts(snapshot).map((context) => [context.item.id, context]));
  const studentFigures = new Set<string>();
  if (volume === "student") {
    const collect = (itemId: string, blocks: QuestionBlock[]) => {
      for (const block of blocks) {
        if (block.type === "image" && block.figureId !== undefined) studentFigures.add(`${itemId}\u0000${block.figureId}`);
      }
    };
    for (const section of snapshot.sections) {
      for (const item of section.items) {
        collect(item.id, item.stem);
        for (const sub of item.subQuestions) {
          collect(item.id, sub.prompt);
          for (const option of sub.options) collect(item.id, option.content);
        }
      }
    }
  }
  return {
    paper: snapshot.paper,
    totalScore: snapshot.totalScore,
    sections: snapshot.sections.map((section) => ({
      title: section.title,
      number: section.number,
      items: section.items.map((item) => {
        const context = contexts.get(item.id);
        if (context === undefined) throw new Error("组卷数据损坏：题目上下文缺失");
        const subQuestions = item.subQuestions.map((sub) => {
          const base: VolumeSubQuestion = {
            id: sub.id,
            label: sub.label,
            prompt: resolveBlocks(sub.prompt, context),
            options: sub.options.map((option) => ({ label: option.label, content: resolveBlocks(option.content, context) })),
            slots: sub.slots ?? [],
          };
          if (volume === "student") return base;
          return {
            ...base,
            originalLabel: sub.originalLabel,
            answers: sub.answers.map((answer) => ({ ...answer, blocks: resolveBlocks(answer.blocks, context) })),
            explanation: resolveBlocks(sub.explanation, context),
            scoring: sub.scoring,
            originalScore: sub.originalScore,
          };
        });
        const base: VolumeItem = {
          id: item.id,
          number: item.number,
          score: item.score,
          blankSpace: item.blankSpace,
          source: item.source,
          stem: resolveBlocks(item.stem, context),
          subQuestions,
          materialLabels: snapshot.materials.filter((material) => material.itemIds[0] === item.id).map((material) => material.label),
        };
        if (volume === "student") return base;
        return { ...base, scoring: item.scoring, scoringState: item.scoringState, answerGap: item.answerGap };
      }),
    })),
    materials: snapshot.materials.map((material) => ({ label: material.label, title: material.title, content: material.content })),
    figures: volume === "student"
      ? snapshot.figures.filter((figure) => studentFigures.has(`${figure.itemId}\u0000${figure.figureId}`))
      : snapshot.figures,
  };
}
