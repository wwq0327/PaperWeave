import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test } from "vitest";
import { requestAiDraft } from "../../../src/main/ai-provider";

const draft = {
  questions: [{ stem: "题干", subquestions: [], options: [], tags: ["标签"], uncertain: [], page: 2, answer: "答案" }],
  notes: [],
};
const config = { baseUrl: "", textModel: "text-model", imageModel: "image-model" };

async function startServer(reply: (request: IncomingMessage, body: string) => { status?: number; json?: unknown } | undefined) {
  let received = { path: "", headers: {} as IncomingMessage["headers"], body: "" };
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      received = { path: request.url ?? "", headers: request.headers, body };
      const result = reply(request, body);
      if (!result) return;
      response.writeHead(result.status ?? 200, { "content-type": "application/json" });
      response.end(JSON.stringify(result.json ?? {}));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    received: () => received,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

test("文字请求走兼容 Messages 端点，剥离代码围栏并返回草稿", async () => {
  const server = await startServer(() => ({ json: { content: [{ type: "text", text: "```json\n" + JSON.stringify(draft) + "\n```" }] } }));
  try {
    const result = await requestAiDraft({ ...config, baseUrl: server.url }, "sk-test", { mode: "text", text: "原卷文字", pages: [2] });
    expect(result).toEqual(draft);
    const sent = server.received();
    expect(sent.path).toBe("/v1/messages");
    expect(sent.headers["x-api-key"]).toBe("sk-test");
    const body = JSON.parse(sent.body);
    expect(body.model).toBe("text-model");
    expect(body.messages[0].content[0].type).toBe("text");
    expect(body.messages[0].content[0].text).toContain("原卷文字");
    expect(body.system).toContain("JSON");
    expect(body.system).toContain("不执行");
  } finally {
    await server.close();
  }
});

test("裁图请求按页标注顺序发送图像块并使用图像模型", async () => {
  const server = await startServer(() => ({ json: { content: [{ type: "text", text: JSON.stringify(draft) }] } }));
  const png = "data:image/png;base64," + Buffer.alloc(8, 1).toString("base64");
  try {
    await requestAiDraft({ ...config, baseUrl: server.url }, "sk-test", {
      mode: "images",
      images: [{ dataUrl: png, page: 4 }],
      note: "只处理第 4 题",
    });
    const body = JSON.parse(server.received().body);
    expect(body.model).toBe("image-model");
    const [label, image, note] = body.messages[0].content;
    expect(label.text).toContain("第 4 页");
    expect(image).toEqual({ type: "image", source: { type: "base64", media_type: "image/png", data: png.split(",")[1] } });
    expect(note.text).toContain("只处理第 4 题");
  } finally {
    await server.close();
  }
});

test("密钥无效与响应格式错误给出可操作提示，且不泄露密钥", async () => {
  const unauthorized = await startServer(() => ({ status: 401, json: { error: "bad key" } }));
  try {
    const error = await requestAiDraft({ ...config, baseUrl: unauthorized.url }, "sk-secret", { mode: "text", text: "文字", pages: [1] }).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("密钥无效");
    expect((error as Error).message).not.toContain("sk-secret");
  } finally {
    await unauthorized.close();
  }

  const malformed = await startServer(() => ({ json: { content: [{ type: "text", text: "这不是 JSON" }] } }));
  try {
    await expect(requestAiDraft({ ...config, baseUrl: malformed.url }, "sk-test", { mode: "text", text: "文字", pages: [1] }))
      .rejects.toThrow("格式无法解析");
  } finally {
    await malformed.close();
  }
});

test("主动取消与超时分别报错，人工草稿不会因此丢失", async () => {
  const hanging = await startServer(() => undefined);
  const controller = new AbortController();
  try {
    const pending = requestAiDraft({ ...config, baseUrl: hanging.url }, "sk-test", { mode: "text", text: "文字", pages: [1] }, controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow("已取消");
    await expect(requestAiDraft({ ...config, baseUrl: hanging.url }, "sk-test", { mode: "text", text: "文字", pages: [1] }, undefined, 50))
      .rejects.toThrow("超时");
  } finally {
    await hanging.close();
  }
});
