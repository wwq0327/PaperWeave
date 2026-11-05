import { describe, expect, it, vi } from "vitest";
import { planWholePaperBatches } from "../../../src/shared/whole-paper-batches";
import { createWholePaperRun, WholePaperRunner } from "../../../src/shared/whole-paper-runner";

const draft = { questions: [{ stem: "题", subquestions: [], options: [], tags: [], uncertain: [], page: 1 }], notes: [] };
const input = () => createWholePaperRun(planWholePaperBatches([{ page: 1, text: "甲乙丙" }], 1));

describe("整卷任务调度", () => {
  it("记录每批状态，重试失败批次时保留成功结果", async () => {
    const snapshots: string[][] = [];
    const save = vi.fn(async (s) => { snapshots.push(s.batches.map((b: { status: string }) => b.status)); });
    const request = vi.fn().mockResolvedValueOnce(draft).mockRejectedValueOnce(new Error("secret")).mockResolvedValue(draft);
    const runner = new WholePaperRunner(save, request);
    const first = await runner.run(input(), new AbortController().signal);
    expect(first.batches.map((b) => b.status)).toEqual(["succeeded", "failed", "succeeded"]);
    expect(JSON.stringify(first)).not.toContain("secret");
    const second = await runner.run(first, new AbortController().signal, true);
    expect(second.batches.map((b) => b.status)).toEqual(["succeeded", "succeeded", "succeeded"]);
    expect(request).toHaveBeenCalledTimes(4);
    expect(snapshots[0]).toEqual(["running", "pending", "pending"]);
  });

  it("取消后丢弃迟到结果并保留未执行批次", async () => {
    const controller = new AbortController();
    const runner = new WholePaperRunner(async () => {}, async () => { controller.abort(); return draft; });
    const result = await runner.run(input(), controller.signal);
    expect(result.batches.map((b) => b.status)).toEqual(["failed", "pending", "pending"]);
    expect(result.batches[0].result).toBeUndefined();
  });

  it("恢复中断批次后需要显式重试", async () => {
    const state = input();
    state.batches[0].status = "running";
    const request = vi.fn().mockResolvedValue(draft);
    const runner = new WholePaperRunner(async () => {}, request);
    const recovered = await runner.run(state, new AbortController().signal);
    expect(recovered.batches[0].status).toBe("failed");
    expect(request).toHaveBeenCalledTimes(2);
    await runner.run(recovered, new AbortController().signal, true);
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("跳过纯空白批次并保留空页信息", async () => {
    const state = createWholePaperRun(planWholePaperBatches([{ page: 1, text: " " }, { page: 2, text: "题" }], 1));
    const request = vi.fn().mockResolvedValue(draft);
    const result = await new WholePaperRunner(async () => {}, request).run(state, new AbortController().signal);
    expect(result.batches.map((b) => b.status)).toEqual(["skipped", "succeeded"]);
    expect(result.plan.emptyPages).toEqual([1]);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("持久化失败时停止执行并抛错", async () => {
    const request = vi.fn();
    const runner = new WholePaperRunner(async () => { throw new Error("存储失败"); }, request);
    await expect(runner.run(input(), new AbortController().signal)).rejects.toThrow("存储失败");
    expect(request).not.toHaveBeenCalled();
  });
});
