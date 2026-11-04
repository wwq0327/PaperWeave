import { describe, expect, it } from "vitest";
import { getRuntimeVersions } from "../../../src/shared/versions";

describe("getRuntimeVersions", () => {
  it("返回固定四键，缺失来源置 null", () => {
    expect(getRuntimeVersions({ app: "paperweave@1.0.0" }))
      .toEqual({ app: "paperweave@1.0.0", electron: null, node: null, chrome: null });
    expect(getRuntimeVersions({ app: "a@0.0.1", electron: "45.2.2", node: "22.11.0", chrome: "138.0.0" }))
      .toEqual({ app: "a@0.0.1", electron: "45.2.2", node: "22.11.0", chrome: "138.0.0" });
  });
});
