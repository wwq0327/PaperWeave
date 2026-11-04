import { app, BrowserWindow, dialog, ipcMain, safeStorage } from "electron";
import { open } from "node:fs/promises";
import { basename } from "node:path";
import { isAiDraft, normalizeAiInput } from "../shared/ai";
import { normalizeAiConfig, parseAiConfig } from "../shared/ai-config";
import { Database } from "./database";
import { fakeAiDraft, type FakeScenario } from "./ai-fake";
import { clearApiKey, keyExists, loadApiKey, saveApiKey, type KeyStore } from "./ai-key";
import { requestAiDraft } from "./ai-provider";
import { extractPdfText } from "./pdf-text";

const configKey = "ai.config";
const maxPdfBytes = 50 * 1024 * 1024;
const requestIdPattern = /^[a-zA-Z0-9-]{8,64}$/;
const fakeScenarios = new Set(["ok", "invalid", "malicious", "timeout", "late"]);

export function registerAi(db: Database, root: string, currentWindow: () => BrowserWindow | undefined): void {
  const store: KeyStore = {
    isAvailable: () => safeStorage.isEncryptionAvailable(),
    encrypt: (value) => safeStorage.encryptString(value),
    decrypt: (data) => safeStorage.decryptString(data),
  };
  const permitted = (event: Electron.IpcMainInvokeEvent) => {
    const win = currentWindow();
    if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) throw new Error("无权访问 AI 设置");
  };
  const publicConfig = () => ({ ...parseAiConfig(db.getSetting(configKey)), hasKey: keyExists(root) });
  const inFlight = new Map<string, AbortController>();
  const choosePdf = async () => {
    const win = currentWindow();
    if (!win) throw new Error("窗口已关闭");
    const result = await dialog.showOpenDialog(win, { title: "选择原卷 PDF", properties: ["openFile"], filters: [{ name: "PDF", extensions: ["pdf"] }] });
    if (result.canceled || !result.filePaths[0]) return null;
    const path = result.filePaths[0];
    const file = await open(path, "r");
    let data: Buffer;
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size === 0 || info.size > maxPdfBytes) throw new Error("请选择不超过 50 MiB 的有效 PDF");
      data = Buffer.alloc(info.size);
      const { bytesRead } = await file.read(data, 0, data.length, 0);
      if (bytesRead !== data.length) throw new Error("PDF 读取不完整，请重试");
    } finally {
      await file.close();
    }
    return { name: basename(path), data };
  };

  ipcMain.handle("ai:getConfig", (event) => {
    permitted(event);
    return publicConfig();
  });

  ipcMain.handle("ai:saveConfig", (event, value: unknown) => {
    permitted(event);
    const config = normalizeAiConfig(value);
    db.setSetting(configKey, JSON.stringify(config));
    return publicConfig();
  });

  ipcMain.handle("ai:saveKey", (event, value: unknown) => {
    permitted(event);
    if (typeof value !== "string") throw new Error("密钥格式无效");
    saveApiKey(root, value, store);
    return publicConfig();
  });

  ipcMain.handle("ai:clearKey", (event) => {
    permitted(event);
    clearApiKey(root);
    return publicConfig();
  });

  ipcMain.handle("ai:draft", async (event, requestId: unknown, value: unknown) => {
    permitted(event);
    if (typeof requestId !== "string" || !requestIdPattern.test(requestId)) throw new Error("请求标识无效");
    if (inFlight.has(requestId)) throw new Error("重复的 AI 请求");
    const checked = normalizeAiInput(value);
    if (!checked.ok) throw new Error(checked.error);

    const scenario = process.env.PAPERWEAVE_AI_FAKE as FakeScenario | undefined;
    // 固定响应只用于未打包的开发/自动化运行，避免安装包被环境变量绕过真实调用。
    const fake = !app.isPackaged && scenario && fakeScenarios.has(scenario) ? scenario : undefined;
    const config = parseAiConfig(db.getSetting(configKey));
    const apiKey = fake ? "" : loadApiKey(root, store);
    if (!fake && !apiKey) throw new Error("尚未配置模型密钥，请先在 AI 设置中保存");

    const controller = new AbortController();
    inFlight.set(requestId, controller);
    try {
      const result = fake
        ? await fakeAiDraft(fake, checked.input, controller.signal)
        : await requestAiDraft(config, apiKey as string, checked.input, controller.signal);
      if (!isAiDraft(result)) throw new Error("模型返回格式无法解析，请重试或手工录入");
      return result;
    } finally {
      if (inFlight.get(requestId) === controller) inFlight.delete(requestId);
    }
  });

  ipcMain.handle("ai:cancel", (event, requestId: unknown) => {
    permitted(event);
    if (typeof requestId !== "string") return false;
    const controller = inFlight.get(requestId);
    if (!controller) return false;
    controller.abort();
    inFlight.delete(requestId);
    return true;
  });

  ipcMain.handle("ai:extractPdf", async (event) => {
    permitted(event);
    const picked = await choosePdf();
    if (!picked) return null;
    const extracted = await extractPdfText(new Uint8Array(picked.data));
    return { name: picked.name, ...extracted };
  });

  ipcMain.handle("ai:loadPdf", async (event) => {
    permitted(event);
    const picked = await choosePdf();
    if (!picked) return null;
    const extracted = await extractPdfText(new Uint8Array(picked.data));
    return { name: picked.name, data: new Uint8Array(picked.data), ...extracted };
  });
}
