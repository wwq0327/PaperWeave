import { expect, test } from "vitest";
import {
  buildPaperSnapshot,
  paperVolume,
  resolvePaperReferences,
  type SnapshotItemInput,
  type SnapshotSectionInput,
} from "../../../src/shared/paper-layout";
import type { QuestionContent } from "../../../src/shared/question";
import { paragraph, referenceGroup } from "../fixtures/questions";

const materialVersion = (versionId: string) => ({
  title: `材料 ${versionId}`,
  content: [paragraph(`材料正文 ${versionId}`)],
  source: "自制样题",
});

function item(id: string, content: QuestionContent, subQuestionIds: string[], score = 10): SnapshotItemInput {
  return {
    id,
    questionId: `question-${id}`,
    questionVersionId: `version-${id}`,
    subQuestionIds,
    score,
    blankSpace: "medium",
    scoring: { mode: "original" },
    scoringState: "original",
    content,
  };
}

function snapshot(sections: SnapshotSectionInput[]) {
  return buildPaperSnapshot({
    paper: { id: "paper-1", title: "测试卷", stage: "初中", subject: "数学", grade: "九年级" },
    sections,
    materialVersion,
  });
}

test("卷内编号：大题、题目连续编号，小问按所选集合重排，材料与图跨题去重", () => {
  const content = referenceGroup();
  content.subQuestions[0].originalLabel = "(3)";
  content.subQuestions[1].originalLabel = "(4)";
  const built = snapshot([
    { title: "一、阅读材料", items: [item("item-1", content, ["ref-1", "ref-2"])] },
    { title: "二、综合运用", items: [item("item-2", referenceGroup(), ["ref-1", "ref-2"], 8)] },
  ]);

  expect(built.sections.map((section) => section.number)).toEqual(["一", "二"]);
  expect(built.sections.map((section) => section.items.map((entry) => entry.number))).toEqual([["1"], ["2"]]);
  expect(built.sections[0].items[0].subQuestions.map((sub) => sub.label)).toEqual(["(1)", "(2)"]);
  expect(built.materials.map((material) => material.label)).toEqual(["材料一", "材料二"]);
  expect(built.materials.map((material) => material.materialId)).toEqual(["material-a", "material-b"]);
  expect(built.materials[0].itemIds).toEqual(["item-1", "item-2"]);
  expect(built.figures.map((figure) => figure.label)).toEqual(["图 1", "图 2"]);
  expect(built.figures.map((figure) => figure.itemId)).toEqual(["item-1", "item-2"]);
});

test("引用解析为卷内编号：小问、材料与图在题干、小问和答案中都正确", () => {
  const built = snapshot([
    { title: "阅读材料", items: [item("item-1", referenceGroup(), ["ref-1", "ref-2"])] },
  ]);
  const references = resolvePaperReferences(built);
  expect(references).toHaveLength(4);
  expect(references.every((reference) => reference.label !== null)).toBe(true);
  expect(references.map((reference) => [reference.kind, reference.label])).toEqual([
    ["material", "材料一"],
    ["figure", "图 1"],
    ["figure", "图 1"],
    ["subQuestion", "(1)"],
  ]);
});

test("目标不在本卷时引用标记待核，保留回退文字", () => {
  const built = snapshot([
    { title: "阅读材料", items: [item("item-1", referenceGroup(), ["ref-2"])] },
  ]);
  expect(built.materials.map((material) => material.materialId)).toEqual(["material-b"]);
  const references = resolvePaperReferences(built);
  expect(references.filter((reference) => reference.label === null).map((reference) => reference.kind)).toEqual(["material", "subQuestion"]);
  expect(references.filter((reference) => reference.label === null).every((reference) => reference.reason !== undefined)).toBe(true);
});

test("学生卷不包含仅出现在答案中的图，教师卷保留", () => {
  const content = referenceGroup();
  content.subQuestions[0].answers[0].blocks.push({ type: "image", id: "b".repeat(64), alt: "答案示意图", figureId: "answer-figure" });
  const built = snapshot([
    { title: "阅读材料", items: [item("item-1", content, ["ref-1", "ref-2"])] },
  ]);
  expect(JSON.stringify(paperVolume(built, "student"))).not.toContain("答案示意图");
  expect(JSON.stringify(paperVolume(built, "teacher"))).toContain("答案示意图");
});

test("作答位置进入双卷：学生卷保留位置标签但无答案，教师卷答案仍关联空位", () => {
  const content = referenceGroup();
  const sub = content.subQuestions[0];
  sub.slots = [
    { id: "slot-a", label: "空位甲", kind: "text", required: true, interchangeableWith: ["slot-b"] },
    { id: "slot-b", label: "空位乙", kind: "choice", required: false, interchangeableWith: ["slot-a"] },
  ];
  sub.answers = [
    { slotId: "slot-a", blocks: [paragraph("答案甲")], variants: [] },
    { slotId: "slot-b", blocks: [paragraph("答案乙")], variants: [] },
  ];
  const built = snapshot([
    { title: "阅读材料", items: [item("item-1", content, ["ref-1"])] },
  ]);
  expect(built.sections[0].items[0].subQuestions[0].slots).toEqual(sub.slots);

  const student = paperVolume(built, "student");
  expect(student.sections[0].items[0].subQuestions[0].slots).toEqual(sub.slots);
  const studentText = JSON.stringify(student);
  expect(studentText).toContain("空位甲");
  expect(studentText).not.toContain("答案甲");
  expect(studentText).not.toContain("答案乙");

  const teacher = paperVolume(built, "teacher");
  expect(teacher.sections[0].items[0].subQuestions[0].slots).toEqual(sub.slots);
  expect(teacher.sections[0].items[0].subQuestions[0].answers?.map((answer) => answer.slotId)).toEqual(["slot-a", "slot-b"]);
  expect(JSON.stringify(teacher)).toContain("答案甲");
});

test("学生卷结构中没有答案、解析与评分点，教师卷保留；引用已替换为卷内编号", () => {
  const built = snapshot([
    { title: "阅读材料", items: [item("item-1", referenceGroup(), ["ref-1", "ref-2"])] },
  ]);
  const student = paperVolume(built, "student");
  const teacher = paperVolume(built, "teacher");
  const studentText = JSON.stringify(student);
  expect(studentText).not.toContain("在 x=1 处取得最小值");
  expect(studentText).not.toContain("参考答案");
  expect(studentText).not.toContain("answers");
  expect(studentText).not.toContain("explanation");
  expect(studentText).not.toContain("scoring");
  expect(studentText).toContain("图 1");
  expect(studentText).toContain("材料一");

  const teacherText = JSON.stringify(teacher);
  expect(teacherText).toContain("在 x=1 处取得最小值");
  expect(teacherText).toContain("结论正确");
  expect(teacherText).toContain("图 1");
});
