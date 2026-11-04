import { BrowserWindow, dialog, ipcMain } from "electron";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { isImportKind } from "../shared/import";
import type { Database } from "./database";
import { AttachmentStore } from "./attachments";
import { ImportStore } from "./import-store";

/** 旧库迁入 IPC：目录选择与扫描在主进程完成，渲染进程只拿扫描标识与预览。 */
export function registerImports(db: Database, root: string, currentWindow: () => BrowserWindow | undefined): void {
  const store = new ImportStore(db, new AttachmentStore(root));
  const permitted = (event: Electron.IpcMainInvokeEvent) => {
    const win = currentWindow();
    if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) throw new Error("无权访问考试资料");
    return win;
  };
  ipcMain.handle("import:scan", async (event, kind: unknown) => {
    const win = permitted(event);
    if (!isImportKind(kind)) throw new Error("旧库类型无效");
    const result = await dialog.showOpenDialog(win, {
      title: kind === "tiku" ? "选择 Tiku 根目录" : "选择 mathVault 根目录",
      properties: ["openDirectory"],
    });
    if (result.canceled) return { status: "canceled" as const };
    const path = result.filePaths[0];
    if (!path) return { status: "canceled" as const };
    return { status: "scanned" as const, scan: store.scan(kind, path) };
  });
  ipcMain.handle("import:apply", (event, input: unknown) => {
    permitted(event);
    return store.apply(input);
  });
  ipcMain.handle("import:correct", async (event, input: unknown) => {
    const win = permitted(event);
    const action = typeof input === "object" && input !== null && !Array.isArray(input)
      ? (input as Record<string, unknown>).action
      : undefined;
    if (action !== "attachImage") return { status: "corrected" as const, row: store.correct(input) };
    const result = await dialog.showOpenDialog(win, {
      title: "选择补入的图片",
      properties: ["openFile"],
      filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg"] }],
    });
    if (result.canceled || !result.filePaths[0]) return { status: "canceled" as const };
    let data: Buffer;
    try { data = readFileSync(result.filePaths[0]); } catch { throw new Error("读取图片失败，请重新选择"); }
    return {
      status: "corrected" as const,
      row: store.correct(input, { data, path: result.filePaths[0], alt: basename(result.filePaths[0]) }),
    };
  });
  ipcMain.handle("import:history", (event) => {
    permitted(event);
    return store.history();
  });
}
