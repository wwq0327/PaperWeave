import { expect, test } from "vitest";
import { addOperation, parseJournal, removeOperation } from "../../../src/main/pdf-journal";

test("解析保存的操作列表，坏数据视为空", () => {
  expect(parseJournal(undefined)).toEqual([]);
  expect(parseJournal("not json")).toEqual([]);
  expect(parseJournal(JSON.stringify([{ id: "a" }, { id: 1 }]))).toEqual([]);
  expect(parseJournal(JSON.stringify([{ id: "5b1c5f5e-4c47-4c1e-9a55-0d0f3f1f2a3b", parent: "/tmp/卷" }])))
    .toEqual([{ id: "5b1c5f5e-4c47-4c1e-9a55-0d0f3f1f2a3b", parent: "/tmp/卷" }]);
});

test("按 id 添加与移除，保留其他项", () => {
  const a = { id: "5b1c5f5e-4c47-4c1e-9a55-0d0f3f1f2a3b", parent: "/tmp/a" };
  const b = { id: "6c2d6f6f-5d58-5d2f-ab66-1e1f4f2f3b4c", parent: "/tmp/b" };
  expect(addOperation([], a)).toEqual([a]);
  expect(addOperation([a], b)).toEqual([a, b]);
  expect(addOperation([a], { ...a, parent: "/tmp/c" })).toEqual([{ ...a, parent: "/tmp/c" }]);
  expect(removeOperation([a, b], a.id)).toEqual([b]);
  expect(removeOperation([a, b], "missing")).toEqual([a, b]);
});
