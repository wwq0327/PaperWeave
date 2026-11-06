import { describe, expect, it, vi } from "vitest";
import { planWholePaperBatches } from "../../../src/shared/whole-paper-batches";
import { createWholePaperRun, WholePaperRunner, type WholePaperBatchInput } from "../../../src/shared/whole-paper-runner";

const draft = { questions: [{ stem: "题", subquestions: [], options: [], tags: [], uncertain: [], page: 1 }], notes: [] };
const input = () => createWholePaperRun(planWholePaperBatches([{ page: 1, text: "甲".repeat(19) }], 20));

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

  it("自动重试失败批次一次，不重复成功批次", async () => {
    const state = createWholePaperRun(planWholePaperBatches([{ page: 1, text: "甲" }, { page: 2, text: "乙" }], 20));
    let calls = 0;
    const request = vi.fn(async (sent: WholePaperBatchInput) => {
      calls += 1;
      if (calls === 1) throw new Error("secret");
      const page = sent.mode === "text" ? sent.pages[0] : 1;
      return { questions: [{ ...draft.questions[0], page }], notes: [] };
    });
    const result = await new WholePaperRunner(async () => {}, request).run(state, new AbortController().signal, false, true);
    expect(result.batches.map((batch) => batch.status)).toEqual(["succeeded", "succeeded"]);
    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls.map((call) => call[0].mode === "text" ? call[0].pages : [])).toEqual([[1], [2], [1]]);
  });

  it("自动重试仍失败时保留固定错误文案，最多请求两次", async () => {
    const request = vi.fn().mockRejectedValue(new Error("secret"));
    const state = createWholePaperRun(planWholePaperBatches([{ page: 1, text: "题" }]));
    const result = await new WholePaperRunner(async () => {}, request).run(state, new AbortController().signal, false, true);
    expect(result.batches[0].status).toBe("failed");
    expect(result.batches[0].error).toBe("批次处理失败，请重试");
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("取消后不自动重试", async () => {
    const controller = new AbortController();
    const request = vi.fn(async () => { controller.abort(); throw new Error("已取消"); });
    const result = await new WholePaperRunner(async () => {}, request).run(input(), controller.signal, false, true);
    expect(result.batches[0].status).toBe("failed");
    expect(request).toHaveBeenCalledTimes(1);
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
    const state = createWholePaperRun(planWholePaperBatches([{ page: 1, text: " " }, { page: 2, text: "题" }], 20));
    const request = vi.fn().mockResolvedValue({ questions: [{ ...draft.questions[0], page: 2 }], notes: [] });
    const result = await new WholePaperRunner(async () => {}, request).run(state, new AbortController().signal);
    expect(result.batches.map((b) => b.status)).toEqual(["skipped", "succeeded"]);
    expect(result.plan.emptyPages).toEqual([1]);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("向模型发送标注原页的文字，旧计划超限时拒绝发送", async () => {
    const request = vi.fn().mockResolvedValue(draft);
    const runner = new WholePaperRunner(async () => {}, request);
    await runner.run(createWholePaperRun(planWholePaperBatches([{ page: 4, text: "题目" }])), new AbortController().signal);
    expect(request.mock.calls[0][0]).toEqual({ mode: "text", text: "\n[原卷第 4 页]\n题目", pages: [4], sourceKind: "pdf" });
    const old = createWholePaperRun(planWholePaperBatches([{ page: 1, text: "甲" }]));
    old.plan.batches[0].text = "甲".repeat(8000);
    old.plan.batches[0].fragments[0] = { page: 1, start: 0, end: 8000, text: "甲".repeat(8000) };
    const result = await runner.run(old, new AbortController().signal);
    expect(result.batches[0].status).toBe("failed");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("DOCX 计划按文档段落标注来源，不把段落当页码", async () => {
    const request = vi.fn().mockResolvedValue(draft);
    const runner = new WholePaperRunner(async () => {}, request);
    const state = createWholePaperRun(planWholePaperBatches([{ page: 1, text: "题目" }], undefined, "docx"));
    await runner.run(state, new AbortController().signal);
    expect(request.mock.calls[0][0]).toEqual({ mode: "text", text: "\n[原卷第 1 段]\n题目", pages: [1], sourceKind: "docx" });
  });

  it("持久化失败时停止执行并抛错", async () => {
    const request = vi.fn();
    const runner = new WholePaperRunner(async () => { throw new Error("存储失败"); }, request);
    await expect(runner.run(input(), new AbortController().signal)).rejects.toThrow("存储失败");
    expect(request).not.toHaveBeenCalled();
  });

  it("扫描批次按页发送附件标识，缺扫描区域时自动重试一次", async () => {
    const image = { page: 1, attachmentId: "a".repeat(64), width: 1200, height: 1600 };
    const scan = createWholePaperRun({
      batches: [{ kind: "scan", fragments: [], pages: [1], text: "", sendable: true, reviewBoundaryBefore: false, image }],
      emptyPages: [],
    });
    const valid = { questions: [{ stem: "题", subquestions: [], options: [], tags: [], uncertain: [], page: 1, scanAreas: [{ page: 1, rect: { x: 0.1, y: 0.1, width: 0.8, height: 0.4 } }] }], notes: [] };
    const request = vi.fn().mockResolvedValueOnce({ questions: [{ ...valid.questions[0], scanAreas: undefined }], notes: [] }).mockResolvedValue(valid);
    const result = await new WholePaperRunner(async () => {}, request).run(scan, new AbortController().signal, false, true);
    expect(result.batches[0].status).toBe("succeeded");
    expect(request.mock.calls.map((call) => call[0])).toEqual([
      { mode: "scan", attachmentId: image.attachmentId, page: 1 },
      { mode: "scan", attachmentId: image.attachmentId, page: 1 },
    ]);
  });

  it("扫描结果没有本页区域时失败，不写入结果", async () => {
    const image = { page: 1, attachmentId: "a".repeat(64), width: 1200, height: 1600 };
    const scan = createWholePaperRun({
      batches: [{ kind: "scan", fragments: [], pages: [1], text: "", sendable: true, reviewBoundaryBefore: false, image }],
      emptyPages: [],
    });
    const request = vi.fn().mockResolvedValue({ questions: [{ stem: "题", subquestions: [], options: [], tags: [], uncertain: [], page: 1 }], notes: [] });
    const result = await new WholePaperRunner(async () => {}, request).run(scan, new AbortController().signal);
    expect(result.batches[0]).toEqual({ status: "failed", error: "批次处理失败，请重试" });
  });

  it("扫描题页码与本页不一致时失败，避免裁图归属错页", async () => {
    const image = { page: 1, attachmentId: "a".repeat(64), width: 1200, height: 1600 };
    const scan = createWholePaperRun({
      batches: [{ kind: "scan", fragments: [], pages: [1], text: "", sendable: true, reviewBoundaryBefore: false, image }],
      emptyPages: [],
    });
    const request = vi.fn().mockResolvedValue({ questions: [{ stem: "题", subquestions: [], options: [], tags: [], uncertain: [], page: 2, scanAreas: [{ page: 1, rect: { x: 0.1, y: 0.1, width: 0.8, height: 0.4 } }] }], notes: [] });
    const result = await new WholePaperRunner(async () => {}, request).run(scan, new AbortController().signal);
    expect(result.batches[0]).toEqual({ status: "failed", error: "批次处理失败，请重试" });
  });

  it("答案批次保存 answers 而非原卷结果，并校验答案页码", async () => {
    const answer = { fileId: "file-1", role: "answer" as const, name: "答案.pdf" };
    const plan = {
      batches: [{ kind: "answer-text" as const, fragments: [{ page: 1, start: 0, end: 4, text: "1. 4" }], pages: [1], text: "1. 4", sendable: true, reviewBoundaryBefore: false, answer }],
      emptyPages: [],
      answerFiles: [answer],
    };
    const request = vi.fn().mockResolvedValue({ answers: [{ originalNumber: "1", label: "", answer: "4", page: 1 }], notes: [] });
    const result = await new WholePaperRunner(async () => {}, request).run(createWholePaperRun(plan), new AbortController().signal);
    expect(request.mock.calls[0][0]).toEqual({ mode: "answer-text", text: "\n[原卷第 1 页]\n1. 4", pages: [1], sourceName: "答案.pdf" });
    expect(result.batches[0]).toEqual({ status: "succeeded", answers: { answers: [{ originalNumber: "1", label: "", answer: "4", page: 1 }], notes: [] } });

    const bad = vi.fn().mockResolvedValue({ answers: [{ originalNumber: "1", label: "", answer: "4", page: 2 }], notes: [] });
    const failed = await new WholePaperRunner(async () => {}, bad).run(createWholePaperRun(plan), new AbortController().signal);
    expect(failed.batches[0].status).toBe("failed");
  });
});
