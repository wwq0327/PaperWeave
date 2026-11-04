import { app, BrowserWindow } from "electron";
import { join } from "node:path";

declare const MAIN_WINDOW_VITE_NAME: string;
declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;

export function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    title: "拾题成卷 PaperWeave",
    width: 1280,
    height: 800,
    // 自动化测试模式隐藏窗口，避免跑套件时频繁弹窗打扰屏幕。
    show: !process.env.PAPERWEAVE_TEST,
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    void window.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    void window.loadFile(
      join(__dirname, "..", "renderer", MAIN_WINDOW_VITE_NAME, "index.html"),
    );
  }

  return window;
}
