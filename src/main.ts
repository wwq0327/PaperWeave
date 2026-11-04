import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { join } from "node:path";
import { getRuntimeVersions } from "./shared/versions";
import { applyPendingRestore, BackupService } from "./main/backup";
import { registerBackup } from "./main/backup-ipc";
import { Database } from "./main/database";
import { registerAi } from "./main/ai";
import { registerEditor } from "./main/editor";
import { registerExams } from "./main/exam-ipc";
import { registerImports } from "./main/import-ipc";
import { parseJournal } from "./main/pdf-journal";
import { recoverPaperFinalizations } from "./main/paper-finalization";
import { recoverPendingOperations } from "./main/pdf-recovery";
import { registerPdf } from "./main/pdf";
import { registerPaper } from "./main/paper-ipc";
import { createMainWindow } from "./main/window";

let database: Database | undefined;
let mainWindow: BrowserWindow | undefined;
app.whenReady().then(async () => {
  const userData = app.getPath("userData");
  try {
    const restore = applyPendingRestore(userData);
    if (restore.rolledBack) {
      dialog.showErrorBox("题库恢复失败", "备份校验或切换未通过，已回滚到原题库。原数据仍可继续使用，请重新选择备份后重试。");
    }
  } catch (error) {
    dialog.showErrorBox("题库恢复未完成", `恢复请求处理失败，应用将尝试打开现有题库。\n${String(error)}`);
  }
  let db: Database;
  try {
    db = new Database(join(userData, "paperweave.sqlite"));
  } catch (error) {
    dialog.showErrorBox("题库打开失败", `无法打开本地题库，原数据未被替换。\n${String(error)}`);
    app.quit();
    return;
  }
  database = db;
  try {
    const pending = parseJournal(db.getSetting("pdf.pending"));
    if (pending.length) {
      const { kept } = await recoverPendingOperations(pending);
      db.setSetting("pdf.pending", JSON.stringify(kept));
      if (kept.length) {
        dialog.showErrorBox("发现未完成的 PDF 操作", `以下暂存目录含非预期文件，未自动删除：\n${kept.map((item) => `${item.parent}（${item.id}）`).join("\n")}`);
      }
    }
  } catch (error) {
    dialog.showErrorBox("清理未完成的 PDF 操作失败", `原文件未被删除，可稍后重试。\n${String(error)}`);
  }
  try {
    const { kept } = await recoverPaperFinalizations(db);
    if (kept.length) {
      dialog.showErrorBox("发现未完成的组卷定稿", `以下暂存目录含非预期文件，未自动删除：\n${kept.map((item) => `${item.parent}（${item.id}）`).join("\n")}`);
    }
  } catch (error) {
    dialog.showErrorBox("清理未完成的组卷定稿失败", `原文件未被删除，可稍后重试。\n${String(error)}`);
  }
  registerEditor(db, app.getPath("userData"), () => mainWindow);
  registerAi(db, app.getPath("userData"), () => mainWindow);
  registerPdf(db, () => mainWindow);
  registerPaper(db, () => mainWindow);
  registerExams(db, app.getPath("userData"), () => mainWindow);
  registerImports(db, app.getPath("userData"), () => mainWindow);
  registerBackup(new BackupService(db, userData, app.getVersion()), db, () => mainWindow);
  ipcMain.handle("app:getRuntimeVersions", (event) => {
    if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) throw new Error("无权读取运行信息");
    return getRuntimeVersions({
      app: `${app.getName()}@${app.getVersion()}`,
      electron: process.versions.electron,
      node: process.versions.node,
      chrome: process.versions.chrome,
    });
  });
  mainWindow = createMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createMainWindow();
    }
  });
});

app.on("will-quit", () => database?.close());

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
