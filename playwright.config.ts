import { defineConfig } from "@playwright/test";

// 让所有 E2E 启动的应用窗口隐藏，避免跑套件时频繁弹窗打扰屏幕。
process.env.PAPERWEAVE_TEST = "1";

export default defineConfig({
  testDir: "tests/e2e",
  workers: 1,
  timeout: 60000,
});
