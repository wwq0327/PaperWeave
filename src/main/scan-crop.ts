import { nativeImage } from "electron";
import type { AiScanRect } from "../shared/ai";
import { scanCropRect } from "../shared/scan-crop";
import type { WholePaperPageImage } from "../shared/whole-paper-batches";
import type { AttachmentStore } from "./attachments";

/** 扫描页裁图只在主进程使用本机像素坐标，不把坐标或整页图回传渲染进程。 */
export function cropScanPage(attachments: AttachmentStore, pageImage: WholePaperPageImage, rect: AiScanRect): { attachmentId: string } | { error: string } {
  try {
    const image = nativeImage.createFromBuffer(attachments.read(pageImage.attachmentId).data);
    if (image.isEmpty()) return { error: "页面图无法解码" };
    const size = image.getSize();
    const crop = scanCropRect(rect, size.width, size.height);
    if (crop === null) return { error: "扫描区域过小或超出页面" };
    const bytes = image.crop(crop).toJPEG(90);
    if (bytes.length === 0) return { error: "裁图结果为空" };
    return { attachmentId: attachments.save(bytes).id };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
