import { app, BrowserWindow, dialog } from "electron";
import { join } from "node:path";
import { Database } from "./main/database";
import { createMainWindow } from "./main/window";

let database: Database | undefined;
app.whenReady().then(() => {
  try {
    database = new Database(join(app.getPath("userData"), "paperweave.sqlite"));
  } catch (error) {
    dialog.showErrorBox("题库打开失败", `无法打开本地题库，原数据未被替换。\n${String(error)}`);
    app.quit();
    return;
  }
  createMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on("will-quit", () => database?.close());

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
