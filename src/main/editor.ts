import { BrowserWindow, dialog, ipcMain } from "electron";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "./database";
import { emptyDraft, isDraft, upgradeDraft, type Draft } from "../shared/document";

const maxImageBytes = 5 * 1024 * 1024;
const hash = (data: Buffer) => createHash("sha256").update(data).digest("hex");
function mime(data: Buffer): string | undefined {
  if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (data.length > 3 && data[0] === 255 && data[1] === 216 && data[2] === 255) return "image/jpeg";
  return undefined;
}

export function registerEditor(db: Database, root: string, currentWindow: () => BrowserWindow | undefined): void {
  const attachments = join(root, "attachments");
  const permitted = (event: Electron.IpcMainInvokeEvent) => {
    const win = currentWindow();
    if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) throw new Error("无权访问编辑器");
  };
  const readImage = (id: string): Buffer => {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("图片标识无效");
    try {
      const file = join(attachments, id);
      // 只读取附件目录内的普通文件，拒绝符号链接指向目录外的内容。
      if (!lstatSync(file).isFile()) throw new Error("not a file");
      const data = readFileSync(file);
      if (data.length > maxImageBytes || !mime(data) || hash(data) !== id) throw new Error("invalid image");
      return data;
    } catch {
      throw new Error("图片缺失或校验失败");
    }
  };
  ipcMain.handle("editor:load", (event) => {
    permitted(event);
    const stored = db.getDraft();
    if (stored === undefined) return emptyDraft();
    const value: unknown = JSON.parse(stored);
    if (!isDraft(value)) throw new Error("草稿格式不受支持，已保留原数据");
    for (const block of value.blocks) if (block.type === "image") readImage(block.id);
    return upgradeDraft(value);
  });
  ipcMain.handle("editor:save", (event, value: unknown) => {
    permitted(event);
    if (!isDraft(value)) throw new Error("内容格式不受支持，未保存");
    const serialized = JSON.stringify(value);
    if (Buffer.byteLength(serialized) > 5 * 1024 * 1024) throw new Error("草稿文字过多，未保存");
    for (const block of (value as Draft).blocks) if (block.type === "image") readImage(block.id);
    db.saveDraft(serialized);
  });
  ipcMain.handle("editor:chooseImage", async (event) => {
    permitted(event);
    const win = currentWindow();
    if (!win) throw new Error("窗口已关闭");
    const result = await dialog.showOpenDialog(win, { title: "选择图片", properties: ["openFile"], filters: [{ name: "图片（PNG、JPEG）", extensions: ["png", "jpg", "jpeg"] }] });
    if (result.canceled || !result.filePaths[0]) return null;
    // 限制读取大小，避免将任意大文件一次载入内存。
    const { open } = await import("node:fs/promises");
    const file = await open(result.filePaths[0], "r");
    let data: Buffer;
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > maxImageBytes || info.size === 0) throw new Error("请选择不超过 5 MiB 的 PNG 或 JPEG 图片");
      const buffer = Buffer.alloc(maxImageBytes + 1);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      data = buffer.subarray(0, bytesRead);
      if (data.length > maxImageBytes || !mime(data)) throw new Error("只支持不超过 5 MiB 的 PNG 或 JPEG 图片");
    } finally { await file.close(); }
    const id = hash(data);
    mkdirSync(attachments, { recursive: true });
    const destination = join(attachments, id);
    if (existsSync(destination)) readImage(id);
    else {
      const temporary = join(attachments, `.tmp-${randomUUID()}`);
      try { writeFileSync(temporary, data, { flag: "wx" }); renameSync(temporary, destination); }
      finally { rmSync(temporary, { force: true }); }
      readImage(id);
    }
    return { id, url: `data:${mime(data)};base64,${data.toString("base64")}` };
  });
  ipcMain.handle("editor:image", (event, id: unknown) => {
    permitted(event);
    if (typeof id !== "string") throw new Error("图片标识无效");
    const data = readImage(id);
    return `data:${mime(data)};base64,${data.toString("base64")}`;
  });
}
