import { app, dialog, ipcMain, type BrowserWindow } from "electron";
import { basename } from "node:path";
import type { BackupSummary } from "./backup";
import { BackupService, inspectBackup } from "./backup";
import type { Database } from "./database";

/** 备份与恢复只通过主进程选择路径；渲染进程拿到摘要与文件名，不拿本机路径。 */
export function registerBackup(service: BackupService, db: Database, currentWindow: () => BrowserWindow | undefined): void {
  let destination: string | null = null;
  let source: string | null = null;

  const permitted = (event: Electron.IpcMainInvokeEvent) => {
    const win = currentWindow();
    if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) throw new Error("无权访问备份与恢复");
    return win;
  };

  ipcMain.handle("backup:chooseDestination", async (event) => {
    const win = permitted(event);
    const choice = await dialog.showOpenDialog(win, { title: "选择备份保存位置", properties: ["openDirectory", "createDirectory"] });
    if (choice.canceled || choice.filePaths.length === 0) return null;
    destination = choice.filePaths[0];
    return { folder: basename(destination) };
  });

  ipcMain.handle("backup:create", async (event): Promise<BackupSummary> => {
    permitted(event);
    if (destination === null) throw new Error("请先选择备份保存位置");
    const summary = await service.create(destination);
    destination = null;
    return summary;
  });

  ipcMain.handle("backup:chooseSource", async (event): Promise<BackupSummary | null> => {
    const win = permitted(event);
    const choice = await dialog.showOpenDialog(win, { title: "选择 PaperWeave 备份目录", properties: ["openDirectory"] });
    if (choice.canceled || choice.filePaths.length === 0) return null;
    const summary = await inspectBackup(choice.filePaths[0], db.dataVersion());
    source = choice.filePaths[0];
    return summary;
  });

  ipcMain.handle("backup:restore", async (event) => {
    permitted(event);
    if (source === null) throw new Error("请先选择要恢复的备份");
    const prepared = await service.prepareRestore(source);
    source = null;
    setTimeout(() => {
      // 自动化测试自行重新启动应用，避免额外进程与测试实例争用同一数据目录。
      if (process.env.PAPERWEAVE_TEST !== "1") app.relaunch();
      app.exit(0);
    }, 500);
    return { summary: prepared.summary, restarting: true };
  });
}
