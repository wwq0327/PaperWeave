import { useEffect, useRef, useState } from "react";
import { getDocument, type PDFDocumentProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
// 在主线程注册 worker，避免 file:// 页面再加载独立 worker 文件。
import "pdfjs-dist/legacy/build/pdf.worker.mjs";
import { AI_LIMITS, base64Bytes, checkImages } from "../shared/ai";
import { normalizeRegion, type ImageRegion, type Point } from "../shared/ai-image";
import { messageOf } from "./messages";

export interface AiImageSelection {
  page: number;
  dataUrl: string;
  bytes: number;
}

interface Props {
  selections: AiImageSelection[];
  onChange: (selections: AiImageSelection[]) => void;
  note: string;
  onNoteChange: (note: string) => void;
  onError: (message: string) => void;
  disabled: boolean;
}

const pageScale = 2.5;

export default function AiImageInput({ selections, onChange, note, onNoteChange, onError, disabled }: Props) {
  const [pdfName, setPdfName] = useState("");
  const [numPages, setNumPages] = useState(0);
  const [page, setPage] = useState(1);
  const [pageImage, setPageImage] = useState<{ url: string; width: number; height: number } | null>(null);
  const [rendering, setRendering] = useState(false);
  const [loading, setLoading] = useState(false);
  const [drag, setDrag] = useState<{ start: Point; current: Point } | null>(null);
  const documentRef = useRef<PDFDocumentProxy | null>(null);
  const loadingTaskRef = useRef<ReturnType<typeof getDocument> | null>(null);
  const imageRef = useRef<HTMLImageElement>(null);

  useEffect(() => () => { void loadingTaskRef.current?.destroy(); }, []);

  useEffect(() => {
    const document = documentRef.current;
    if (!document || !numPages) return;
    let cancelled = false;
    setRendering(true);
    setPageImage(null);
    (async () => {
      const pdfPage = await document.getPage(page);
      const viewport = pdfPage.getViewport({ scale: pageScale });
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
  }, [page, numPages]);

  async function choosePdf() {
    setLoading(true);
    onError("");
    try {
      const picked = await window.paperweave.loadPdfForImages();
      if (!picked) return;
      await loadingTaskRef.current?.destroy().catch(() => undefined);
      const loadingTask = getDocument({ data: picked.data });
      const document = await loadingTask.promise;
      documentRef.current = document;
      loadingTaskRef.current = loadingTask;
      setPdfName(picked.name);
      setNumPages(document.numPages);
      setPage(1);
      setPageImage(null);
      onChange([]);
      if (!picked.hasText) onError("这份 PDF 没有可提取的文字，已按扫描件处理；请在页面上拖选题目区域。");
    } catch (error) {
      onError(`加载 PDF 失败：${messageOf(error)}`);
    } finally {
      setLoading(false);
    }
  }

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
    if (!pageImage || rendering || disabled) return;
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
    if (region) addRegion(region);
  }

  function addRegion(region: ImageRegion) {
    const image = imageRef.current;
    if (!image || !pageImage) return;
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
    let dataUrl = canvas.toDataURL("image/jpeg", 0.9);
    if (base64Bytes(dataUrl) > AI_LIMITS.imageBytes) dataUrl = canvas.toDataURL("image/jpeg", 0.7);
    const bytes = base64Bytes(dataUrl);
    const next = [...selections, { page, dataUrl, bytes }];
    const error = checkImages(next);
    if (error) { onError(error); return; }
    onChange(next);
    onError("");
  }

  function move(index: number, delta: number) {
    const target = index + delta;
    if (target < 0 || target >= selections.length) return;
    const next = [...selections];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  }

  const dragRegion = drag ? normalizeRegion(drag.start, drag.current) : null;

  return <section className="ai-image-input" aria-label="裁图选区">
    <div className="toolbar">
      <button onClick={choosePdf} disabled={loading || disabled}>{loading ? "正在打开 PDF…" : "选择 PDF 并选取裁图"}</button>
      {pdfName && <span className="muted">{pdfName}</span>}
    </div>
    <p className="muted">在页面上拖出选区，按添加顺序编号；可切换页码继续添加。选区请包含题干、设问和必要图表；跨页题或缺前页材料时请补选。图形无法辨认时，换更清晰页面、调整图像模型或改手工录入。</p>

    {numPages > 0 && <>
      <div className="toolbar ai-page-nav">
        <button onClick={() => setPage((value) => Math.max(1, value - 1))} disabled={page <= 1}>上一页</button>
        <label className="inline">第 <input type="number" min={1} max={numPages} value={page} onChange={(event) => setPage(Math.max(1, Math.min(numPages, Number(event.target.value) || 1)))} /> / {numPages} 页</label>
        <button onClick={() => setPage((value) => Math.min(numPages, value + 1))} disabled={page >= numPages}>下一页</button>
        {rendering && <span className="muted">正在渲染第 {page} 页…</span>}
      </div>
      <div className="ai-page-view" onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={() => setDrag(null)}>
        {pageImage && <img ref={imageRef} src={pageImage.url} alt={`原卷第 ${page} 页`} draggable={false} />}
        {dragRegion && <span className="ai-selection" style={{
          left: `${dragRegion.x * 100}%`, top: `${dragRegion.y * 100}%`,
          width: `${dragRegion.width * 100}%`, height: `${dragRegion.height * 100}%`,
        }} />}
      </div>
    </>}

    {selections.length > 0 && <ol className="ai-selection-list" aria-label="已选裁图">
      {selections.map((selection, index) => <li key={`${selection.page}-${index}`}>
        <img src={selection.dataUrl} alt={`第 ${selection.page} 页选区 ${index + 1}`} />
        <span>第 {selection.page} 页 · {Math.ceil(selection.bytes / 1024)} KiB</span>
        <div className="toolbar">
          <button onClick={() => move(index, -1)} disabled={index === 0}>上移</button>
          <button onClick={() => move(index, 1)} disabled={index === selections.length - 1}>下移</button>
          <button onClick={() => onChange(selections.filter((_, i) => i !== index))}>删除</button>
        </div>
      </li>)}
    </ol>}

    <label>补充说明（可选）<textarea value={note} onChange={(event) => onNoteChange(event.target.value)} placeholder="例如：本组包含第 29 题的设问、车票图和手续费表；请保留表格行。" /></label>
  </section>;
}
