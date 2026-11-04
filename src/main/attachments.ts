import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const hash = (data: Buffer) => createHash("sha256").update(data).digest("hex");

export function imageMime(data: Buffer): "image/png" | "image/jpeg" | undefined {
  if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (data.length > 3 && data[0] === 255 && data[1] === 216 && data[2] === 255) return "image/jpeg";
  return undefined;
}

/** 哈希附件池：编辑器图片与录题裁图共用同一目录，读取时重新校验内容。 */
export class AttachmentStore {
  private readonly directory: string;

  constructor(root: string) {
    this.directory = join(root, "attachments");
  }

  read(id: string): { data: Buffer; mime: "image/png" | "image/jpeg" } {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("图片标识无效");
    try {
      const file = join(this.directory, id);
      if (!lstatSync(file).isFile()) throw new Error("not a file");
      const data = readFileSync(file);
      const mime = imageMime(data);
      if (data.length === 0 || data.length > MAX_IMAGE_BYTES || mime === undefined || hash(data) !== id) throw new Error("invalid image");
      return { data, mime };
    } catch {
      throw new Error("图片缺失或校验失败");
    }
  }

  readDataUrl(id: string): string {
    const { data, mime } = this.read(id);
    return `data:${mime};base64,${data.toString("base64")}`;
  }

  save(data: Buffer): { id: string; mime: "image/png" | "image/jpeg"; created: boolean } {
    const mime = imageMime(data);
    if (data.length === 0 || data.length > MAX_IMAGE_BYTES) throw new Error("图片为空或超过 5 MiB");
    if (mime === undefined) throw new Error("只支持 PNG 或 JPEG 图片");
    const id = hash(data);
    mkdirSync(this.directory, { recursive: true });
    const destination = join(this.directory, id);
    if (existsSync(destination)) {
      this.read(id);
      return { id, mime, created: false };
    }
    const temporary = join(this.directory, `.tmp-${randomUUID()}`);
    try {
      writeFileSync(temporary, data, { flag: "wx" });
      renameSync(temporary, destination);
    } finally {
      rmSync(temporary, { force: true });
    }
    this.read(id);
    return { id, mime, created: true };
  }

  saveDataUrl(value: unknown): { id: string; url: string } {
    if (typeof value !== "string") throw new Error("图片数据无效");
    const match = /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
    if (!match) throw new Error("只支持 PNG 或 JPEG 图片");
    const data = Buffer.from(match[2], "base64");
    const saved = this.save(data);
    return { id: saved.id, url: `data:${saved.mime};base64,${data.toString("base64")}` };
  }
}
