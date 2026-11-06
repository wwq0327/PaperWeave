import { AI_LIMITS, isAiAnswerDraft, isAiDraft, type AiAnswerDraft, type AiDraft, type AiSourceKind } from "./ai";
import { wholePaperRequestText, type WholePaperBatchPlan } from "./whole-paper-batches";

export type BatchStatus = "pending" | "running" | "succeeded" | "failed" | "skipped";
export interface WholePaperBatchState {
  status: BatchStatus;
  /** 原卷识别结果；扫描页与文字页共用。 */
  result?: AiDraft;
  /** 答案／评分文件抽取结果。 */
  answers?: AiAnswerDraft;
  error?: string;
}
export interface WholePaperRunState {
  plan: WholePaperBatchPlan;
  batches: WholePaperBatchState[];
}

/** 创建任务时冻结分批计划；调用方负责将状态保存到持久存储。 */
export function createWholePaperRun(plan: WholePaperBatchPlan): WholePaperRunState {
  return {
    plan: structuredClone(plan),
    batches: plan.batches.map((batch) => ({ status: batch.sendable ? "pending" : "skipped" })),
  };
}

type Save = (state: WholePaperRunState) => Promise<void>;
type Request = (input: { text: string; pages: number[]; sourceKind: AiSourceKind }, signal: AbortSignal) => Promise<unknown>;

/**
 * 执行器只负责单任务调度；调用方负责授权、加密存储、界面及人工审核。
 * 外部持久化失败直接抛出；不以未保存的内存状态报告任务成功。
 */
export class WholePaperRunner {
  private running = false;
  constructor(private readonly save: Save, private readonly request: Request) {}

  async run(initial: WholePaperRunState, signal: AbortSignal, retryFailed = false, autoRetry = false): Promise<WholePaperRunState> {
    if (this.running) throw new Error("整卷任务正在执行");
    this.running = true;
    try {
      const state = structuredClone(initial);
      if (state.plan.batches.length !== state.batches.length) throw new Error("整卷任务状态无效");
      // 进程异常结束后留下的 running 必须显式重试，不可当作成功。
      let recovered = false;
      for (const batch of state.batches) {
        if (batch.status === "running") {
          batch.status = "failed";
          batch.error = "上次执行中断，请重试";
          recovered = true;
        }
      }
      if (recovered) await this.save(structuredClone(state));
      const attempt = async (index: number): Promise<void> => {
        const batch = state.batches[index];
        const input = state.plan.batches[index];
        if (!input.sendable) throw new Error("不可发送的空白批次状态无效");
        batch.status = "running";
        delete batch.error;
        delete batch.result;
        await this.save(structuredClone(state));
        if (signal.aborted) {
          batch.status = "failed";
          batch.error = "已取消，请重试";
          await this.save(structuredClone(state));
          return;
        }
        try {
          const sourceKind = state.plan.sourceKind ?? "pdf";
          const text = wholePaperRequestText(input, sourceKind);
          if ([...text].length > AI_LIMITS.textChars) throw new Error("附加页码后超过模型输入限制");
          const result = await this.request({ text, pages: [...input.pages], sourceKind }, signal);
          if (signal.aborted) throw new Error("已取消，请重试");
          if (!isAiDraft(result)) throw new Error("模型返回格式无效，请重试");
          batch.status = "succeeded";
          batch.result = result;
        } catch (error) {
          batch.status = "failed";
          // 服务错误可能包含密钥或原卷内容，持久化固定提示，避免泄漏。
          batch.error = signal.aborted ? "已取消，请重试" : "批次处理失败，请重试";
        }
        await this.save(structuredClone(state));
      };
      // 自动重试只在本轮末尾对被判定失败的批次再尝试一次；取消后不再发起请求。
      const passes = autoRetry ? 2 : 1;
      for (let pass = 0; pass < passes; pass++) {
        for (let index = 0; index < state.batches.length; index++) {
          if (signal.aborted) break;
          const status = state.batches[index].status;
          const eligible = pass === 0
            ? status === "pending" || (retryFailed && status === "failed")
            : status === "failed";
          if (!eligible) continue;
          await attempt(index);
        }
        if (signal.aborted) break;
      }
      return state;
    } finally {
      this.running = false;
    }
  }
}
