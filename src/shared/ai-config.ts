export interface AiConfig {
  baseUrl: string;
  textModel: string;
  imageModel: string;
}

export const defaultAiConfig: AiConfig = {
  baseUrl: "https://api.anthropic.com",
  textModel: "claude-sonnet-5-5",
  imageModel: "claude-sonnet-5-5",
};

export function normalizeAiConfig(value: unknown): AiConfig {
  if (typeof value !== "object" || value === null) throw new Error("模型配置格式无效");
  const input = value as Record<string, unknown>;
  const rawUrl = typeof input.baseUrl === "string" ? input.baseUrl.trim() : "";
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("模型服务地址无效");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("模型服务地址只支持 http 或 https");
  const textModel = typeof input.textModel === "string" ? input.textModel.trim() : "";
  const imageModel = typeof input.imageModel === "string" ? input.imageModel.trim() : "";
  if (!textModel || !imageModel || textModel.length > 200 || imageModel.length > 200) throw new Error("模型名称不能为空且不超过 200 字符");
  return { baseUrl: rawUrl.replace(/\/+$/, ""), textModel, imageModel };
}

export function parseAiConfig(raw: string | undefined): AiConfig {
  if (!raw) return defaultAiConfig;
  try {
    return normalizeAiConfig(JSON.parse(raw));
  } catch {
    return defaultAiConfig;
  }
}
