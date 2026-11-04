import { BrowserWindow, dialog, ipcMain, shell } from "electron";
import { randomUUID } from "node:crypto";
import { rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { writePdfPair } from "./pdf-pair";

/** M0 草稿样张：打印当前编辑预览，保存完成后打开同一份 PDF。 */
export function registerPdf(currentWindow: () => BrowserWindow | undefined): void {
  let busy = false;
  let pair: { id: string; parent: string; owner: number; student?: Buffer } | undefined;
  const requireOwner = (event: Electron.IpcMainInvokeEvent) => {
    const win = currentWindow();
    if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) throw new Error("无权导出 PDF");
    return win;
  };
  const requirePair = (event: Electron.IpcMainInvokeEvent, id: unknown) => {
    const win = requireOwner(event);
    if (!pair || typeof id !== "string" || pair.id !== id || pair.owner !== event.sender.id) throw new Error("PDF 生成操作无效或已结束");
    return { win, pair };
  };
  ipcMain.handle("pdf:export", async (event) => {
    const win = requireOwner(event);
    if (busy) throw new Error("正在生成 PDF，请稍候");
    busy = true;
    try {
      const result = await dialog.showSaveDialog(win, { title: "保存草稿样张 PDF", defaultPath: "拾题成卷-草稿样张.pdf", filters: [{ name: "PDF 文档", extensions: ["pdf"] }] });
      if (result.canceled || !result.filePath) return { canceled: true as const };
      const bytes = await win.webContents.printToPDF({ pageSize: "A4", preferCSSPageSize: true, printBackground: true, scale: 1 });
      if (bytes.length < 100 || !bytes.subarray(0, 5).equals(Buffer.from("%PDF-"))) throw new Error("生成的 PDF 无效");
      const target = result.filePath;
      const temporary = join(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`);
      try { await writeFile(temporary, bytes, { flag: "wx" }); await rename(temporary, target); }
      finally { await rm(temporary, { force: true }); }
      const openError = await shell.openPath(target);
      return { canceled: false as const, path: target, openError };
    } finally { busy = false; }
  });
  ipcMain.handle("pdf:beginPair", async (event) => {
    const win = requireOwner(event);
    if (busy) throw new Error("正在生成 PDF，请稍候");
    busy = true;
    try {
      const choice = await dialog.showOpenDialog(win, { title: "选择双卷样张保存位置", properties: ["openDirectory", "createDirectory"] });
      if (choice.canceled || !choice.filePaths[0]) { busy = false; return null; }
      pair = { id: randomUUID(), parent: choice.filePaths[0], owner: event.sender.id };
      return pair.id;
    } catch (error) { busy = false; throw error; }
  });
  ipcMain.handle("pdf:captureStudent", async (event, id: unknown) => {
    const current = requirePair(event, id);
    if (current.pair.student) throw new Error("学生卷已生成");
    current.pair.student = await current.win.webContents.printToPDF({ pageSize: "A4", preferCSSPageSize: true, printBackground: true, scale: 1 });
  });
  ipcMain.handle("pdf:finishPair", async (event, id: unknown) => {
    const current = requirePair(event, id);
    if (!current.pair.student) throw new Error("请先生成学生卷");
    try {
      const teacher = await current.win.webContents.printToPDF({ pageSize: "A4", preferCSSPageSize: true, printBackground: true, scale: 1 });
      const directory = await writePdfPair(current.pair.parent, current.pair.id, current.pair.student, teacher);
      const studentPath = join(directory, "学生卷.pdf");
      const teacherPath = join(directory, "教师答案卷.pdf");
      const openErrors = await Promise.all([shell.openPath(studentPath), shell.openPath(teacherPath)]);
      return { directory, studentPath, teacherPath, openErrors };
    } finally { pair = undefined; busy = false; }
  });
  ipcMain.handle("pdf:cancelPair", (event, id: unknown) => {
    requirePair(event, id);
    pair = undefined; busy = false;
  });

}
