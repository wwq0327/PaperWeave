import { BrowserWindow, dialog, ipcMain, shell } from "electron";
import { randomUUID } from "node:crypto";
import { rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/** M0 草稿样张：打印当前编辑预览，保存完成后打开同一份 PDF。 */
export function registerPdf(currentWindow: () => BrowserWindow | undefined): void {
  let busy = false;
  ipcMain.handle("pdf:export", async (event) => {
    const win = currentWindow();
    if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) throw new Error("无权导出 PDF");
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
}
