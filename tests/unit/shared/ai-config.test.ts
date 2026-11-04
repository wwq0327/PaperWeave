import { expect, test } from "vitest";
import { defaultAiConfig, normalizeAiConfig, parseAiConfig } from "../../../src/shared/ai-config";

test("未配置时使用默认服务与模型", () => {
  expect(parseAiConfig(undefined)).toEqual(defaultAiConfig);
  expect(parseAiConfig("坏数据")).toEqual(defaultAiConfig);
});

test("保存的配置经过校验，拒绝非法地址与空模型", () => {
  expect(normalizeAiConfig({ baseUrl: "https://example.com/", textModel: "文本模型", imageModel: "图像模型" }))
    .toEqual({ baseUrl: "https://example.com", textModel: "文本模型", imageModel: "图像模型" });
  expect(() => normalizeAiConfig({ baseUrl: "javascript:alert(1)", textModel: "m", imageModel: "m" })).toThrow("服务地址");
  expect(() => normalizeAiConfig({ baseUrl: "https://example.com", textModel: " ", imageModel: "m" })).toThrow("模型");
  expect(() => normalizeAiConfig({ baseUrl: "https://example.com", textModel: "m", imageModel: "" })).toThrow("模型");
});
