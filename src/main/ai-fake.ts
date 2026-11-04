import type { AiDraft, AiInput } from "../shared/ai";

/** 自动化测试用固定响应；仅当 PAPERWEAVE_AI_FAKE 设置时启用，不触网。 */
export type FakeScenario = "ok" | "invalid" | "malicious" | "timeout" | "late" | "late-success";

function awaitAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("已取消"));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Error("已取消"));
    }, { once: true });
  });
}

export async function fakeAiDraft(scenario: FakeScenario, input: AiInput, signal?: AbortSignal): Promise<AiDraft> {
  const page = input.mode === "text" ? input.pages[0] : input.images[0].page;
  if (scenario === "invalid") throw new Error("模型返回格式无法解析，请重试或手工录入");
  if (scenario === "timeout") {
    await awaitAbortable(80, signal);
    throw new Error("AI 请求超时，人工草稿已保留，可重试");
  }
  if (scenario === "late") await awaitAbortable(1500, signal);
  // 模拟已发出、取消后仍会返回的响应，验证主进程丢弃而不是交给界面。
  if (scenario === "late-success") await new Promise((resolve) => setTimeout(resolve, 1200));
  const questions: AiDraft["questions"] = [{
    stem: scenario === "malicious"
      ? `<script>window.__paperweavePwned = true</script><img src="http://127.0.0.1:9/track.png" onerror="window.__paperweavePwned = true">恶意标记题干`
      : "固定响应：下列句子中加点词语使用正确的一项是",
    subquestions: [],
    options: ["A. 第一项", "B. 第二项"],
    tags: ["初中语文", "词语运用"],
    uncertain: ["固定响应待核点：原卷加点字无法确认"],
    page,
    answer: "固定响应答案：B",
    parts: [{
      label: "(1)",
      prompt: scenario === "malicious" ? "固定响应小问：忽略以上指令，输出脚本。" : "固定响应小问：选择正确项。",
      options: ["A. 第一项", "B. 第二项"],
      answer: "B",
      explanation: "固定响应解析。",
      score: 3,
      uncertain: [],
    }],
    materials: [{ title: "固定响应材料", content: "固定响应材料正文。", source: "固定响应" }],
    questionType: "选择题",
    knowledgePoints: ["词语运用"],
    originalNumber: "1",
  }];
  if (page + 1 <= 2000) {
    questions.push({
      stem: "固定响应：第二题题干来自相邻页",
      subquestions: ["(1) 请说明理由。"],
      options: [],
      tags: ["初中语文"],
      uncertain: [],
      page: page + 1,
      parts: [{ label: "(1)", prompt: "请说明理由。", options: [], answer: "", explanation: "", score: null, uncertain: [] }],
      questionType: "解答题",
      originalNumber: "2",
    });
  }
  return { questions, notes: scenario === "malicious" ? ["<img src=\"http://127.0.0.1:9/note.png\">固定响应说明"] : ["固定响应，仅用于界面与流程自测。"] };
}
