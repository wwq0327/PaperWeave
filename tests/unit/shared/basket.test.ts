import { expect, test } from "vitest";
import { basketSelection } from "../../../src/shared/basket";
import { exercise, math, note, readingGroup, referenceGroup } from "../fixtures/questions";

test("整题加入带入全部小问与材料", () => {
  const selection = basketSelection(readingGroup(), null);
  expect(selection.subQuestionIds).toEqual(["read-1", "read-2", "read-3", "read-4"]);
  expect(selection.materialIds).toEqual(["material-a"]);
  expect(selection.wholeGroup).toBe(true);
  expect(selection.reasons).toEqual(["整题加入"]);
});

test("题组共用题干或组选答候选时整组加入", () => {
  const stem = basketSelection(readingGroup(), "read-1");
  expect(stem.subQuestionIds).toEqual(["read-1", "read-2", "read-3", "read-4"]);
  expect(stem.wholeGroup).toBe(true);
  expect(stem.reasons).toContain("题组共用题干");

  const choose = basketSelection(exercise(), "task-a");
  expect(choose.subQuestionIds).toEqual(["task-a", "task-b"]);
  expect(choose.wholeGroup).toBe(true);
  expect(choose.reasons).toContain("组选答候选项");
});

test("无题组指令时带入当前小问与直接、传递前问", () => {
  const direct = math();
  direct.stem = [];
  expect(basketSelection(direct, "part-2")).toEqual({
    subQuestionIds: ["part-1", "part-2"],
    materialIds: [],
    wholeGroup: false,
    reasons: ["直接前问：part-1"],
  });

  const transitive = readingGroup();
  transitive.stem = [];
  const selection = basketSelection(transitive, "read-4");
  expect(selection.subQuestionIds).toEqual(["read-1", "read-2", "read-3", "read-4"]);
  expect(selection.wholeGroup).toBe(false);
  expect(selection.reasons).toContain("直接前问：read-3");
  expect(selection.reasons).toContain("传递前问：read-1、read-2");
});

test("独立小问只带自身，材料按所选小问汇总", () => {
  const independent = note();
  independent.stem = [];
  expect(basketSelection(independent, "note-1")).toEqual({
    subQuestionIds: ["note-1"],
    materialIds: [],
    wholeGroup: false,
    reasons: ["独立小问"],
  });

  const referenced = referenceGroup();
  referenced.stem = [];
  expect(basketSelection(referenced, "ref-2").materialIds).toEqual(["material-a", "material-b"]);
});

test("只有共享材料依赖时列出材料原因，不标为独立小问", () => {
  const content = referenceGroup();
  content.stem = [];
  const sub = content.subQuestions[1];
  sub.dependsOn = [];
  sub.materialIds = ["material-b"];
  const selection = basketSelection(content, "ref-2");
  expect(selection.subQuestionIds).toEqual(["ref-2"]);
  expect(selection.wholeGroup).toBe(false);
  expect(selection.reasons).toEqual(["共享材料：material-b"]);
});

test("不存在的小问标识被拒绝", () => {
  expect(() => basketSelection(note(), "missing")).toThrow("小问不存在");
});
