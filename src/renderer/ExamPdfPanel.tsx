import { useEffect, useRef, useState } from "react";
import { getDocument, type PDFDocumentProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
// 在主线程注册 worker，避免 file:// 页面再加载独立 worker 文件。
import "pdfjs-dist/legacy/build/pdf.worker.mjs";
import { normalizeRegion, type Point } from "../shared/ai-image";
import { messageOf } from "./messages";

interface Props {
  fileId: string;
  page: number;
  cropLabel: string | null;
  disabled: boolean;
  onPageChange: (page: number) => void;
  onCrop: (dataUrl: string) => void;
  onError: (message: string) => void;
}

export default function ExamPdfPanel({ fileId, page, cropLabel, disabled, onPageChange, onCrop, onError }: Props) {
  const [numPages, setNumPages] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [pageImage, setPageImage] = useState<{ url: string; width: number; height: number } | null>(null);
  const [rendering, setRendering] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadSeq, setLoadSeq] = useState(0);
  const [drag, setDrag] = useState<{ start: Point; current: Point } | null>(null);
  const documentRef = useRef<PDFDocumentProxy | null>(null);
  const loadingTaskRef = useRef<ReturnType<typeof getDocument> | null>(null);
  const imageRef = useRef<HTMLImageElement>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setNumPages(0);
    setPageImage(null);
    onError("");
    window.paperweave.getExamFile(fileId).then(async ({ data }) => {
      await loadingTaskRef.current?.destroy().catch(() => undefined);
      const task = getDocument({ data });
      const document = await task.promise;
      if (cancelled) { void task.destroy(); return; }
      documentRef.current = document;
      loadingTaskRef.current = task;
      setNumPages(document.numPages);
      setLoadSeq((value) => value + 1);
    }).catch((error: unknown) => {
      if (!cancelled) onError(`读取原卷失败：${messageOf(error)}。请重新导入同一 PDF 后再试。`);
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => {
      cancelled = true;
      void loadingTaskRef.current?.destroy().catch(() => undefined);
      loadingTaskRef.current = null;
      documentRef.current = null;
    };
  }, [fileId]);

  useEffect(() => {
    const document = documentRef.current;
    if (!document || !numPages) return;
    let cancelled = false;
    setRendering(true);
    setPageImage(null);
    (async () => {
      const pdfPage = await document.getPage(Math.min(Math.max(1, page), numPages));
      const viewport = pdfPage.getViewport({ scale: 1.5 * zoom });
      const canvas = window.document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) throw new Error("无法创建页面画布");
      await pdfPage.render({ canvas, canvasContext: context, viewport }).promise;
      if (cancelled) return;
      setPageImage({ url: canvas.toDataURL("image/jpeg", 0.9), width: canvas.width, height: canvas.height });
    })()
      .catch((error: unknown) => { if (!cancelled) onError(`渲染第 ${page} 页失败：${messageOf(error)}`); })
      .finally(() => { if (!cancelled) setRendering(false); });
    return () => { cancelled = true; };
  }, [page, zoom, numPages, loadSeq]);

  function pointOf(event: React.PointerEvent): Point {
    const image = imageRef.current;
    if (!image) return { x: 0, y: 0 };
    const rect = image.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
    };
  }

  function startDrag(event: React.PointerEvent) {
    if (!pageImage || rendering || disabled || cropLabel === null) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = pointOf(event);
    setDrag({ start: point, current: point });
  }

  function moveDrag(event: React.PointerEvent) {
    if (!drag) return;
    setDrag({ start: drag.start, current: pointOf(event) });
  }

  function endDrag(event: React.PointerEvent) {
    if (!drag) return;
    const region = normalizeRegion(drag.start, pointOf(event));
    setDrag(null);
    if (!region) return;
    const image = imageRef.current;
    if (!image) return;
    const sx = Math.round(region.x * image.naturalWidth);
    const sy = Math.round(region.y * image.naturalHeight);
    const width = Math.max(1, Math.round(region.width * image.naturalWidth));
    const height = Math.max(1, Math.round(region.height * image.naturalHeight));
    const canvas = window.document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) { onError("无法创建裁图画布"); return; }
    context.drawImage(image, sx, sy, width, height, 0, 0, width, height);
    onCrop(canvas.toDataURL("image/jpeg", 0.9));
  }

  const dragRegion = drag ? normalizeRegion(drag.start, drag.current) : null;
  const current = Math.min(Math.max(1, page), Math.max(1, numPages));

  return <section className="intake-pdf" aria-label="原卷预览">
    <header className="paper-inline">
      <button onClick={() => onPageChange(Math.max(1, current - 1))} disabled={current <= 1}>上一页</button>
      <label>页码 <input aria-label="原卷页码跳转" type="number" min={1} max={numPages || 1} value={current} onChange={(event) => onPageChange(Math.max(1, Math.min(numPages || 1, Number(event.target.value) || 1)))} /> / {numPages || "…"} 页</label>
      <button onClick={() => onPageChange(Math.min(numPages || 1, current + 1))} disabled={current >= numPages}>下一页</button>
    </header>
    <label>缩放 <input type="range" min={1} max={3} step={0.5} value={zoom} onChange={(event) => setZoom(Number(event.target.value))} /> {zoom.toFixed(1)}×</label>
    <p className="muted">{cropLabel ? `拖动页面选区，裁图将插入：${cropLabel}` : "在右栏内容块点「插入裁图」，再回到此处拖选区域。"}</p>
    <div className={`intake-page-view${cropLabel ? " intake-cropping" : ""}`} onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={() => setDrag(null)} aria-label={`原卷第 ${current} 页`}>
      {pageImage ? <img ref={imageRef} src={pageImage.url} alt={`原卷第 ${current} 页`} draggable={false} /> : <p className="muted">{loading || rendering ? `正在渲染第 ${current} 页…` : "原卷页面不可用。"}</p>}
      {dragRegion && <span className="exam-selection" style={{ left: `${dragRegion.x * 100}%`, top: `${dragRegion.y * 100}%`, width: `${dragRegion.width * 100}%`, height: `${dragRegion.height * 100}%` }} />}
    </div>
  </section>;
}
