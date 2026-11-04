import { defineConfig } from "@playwright/test";

// 规模与性能实测单独运行，不计入常规 E2E；不设置 PAPERWEAVE_TEST，应用窗口保持可见。
export default defineConfig({
  testDir: "tests/performance",
  workers: 1,
  timeout: 3_600_000,
  reporter: [["list"]],
});
