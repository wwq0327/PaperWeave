import { useEffect, useState } from "react";
import katex from "katex";
import "katex/dist/katex.min.css";
import { emptyDraft, isDraft, type Block, type Draft, type DraftSource, type Inline, type TextStyle } from "../shared/document";
import { questionToBlocks, type AiQuestion } from "../shared/ai";
import { volumeSections, type Volume } from "../shared/volume";
import AiPanel from "./AiPanel";
import PaperWorkbench from "./PaperWorkbench";
import "./editor.css";

const styles: TextStyle[] = ["普通", "粗体", "斜体", "下划线", "上标", "下标"];
const newRun = (): Inline => ({ type: "text", text: "", style: "普通" });
function Formula({ latex, display = false }: { latex: string; display?: boolean }) {
  if (!latex) return <span className="muted" data-invalid-formula>输入 LaTeX 后预览</span>;
  try {
    const html = katex.renderToString(latex, { displayMode: display, throwOnError: true, trust: false, strict: "error" });
    return <span aria-label="公式预览" dangerouslySetInnerHTML={{ __html: html }} />;
  } catch { return <span role="alert" data-invalid-formula>公式无法渲染，请检查表达式。</span>; }
}
function ImageView({ id, alt, cache }: { id: string; alt: string; cache: Record<string, string> }) {
  const [loaded, setLoaded] = useState<{ id: string; url: string } | null>(null);
  const [failedId, setFailedId] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    window.paperweave.getImage(id).then((url) => { if (live) setLoaded({ id, url }); }).catch(() => { if (live) setFailedId(id); });
    return () => { live = false; };
  }, [id]);
  const url = loaded?.id === id ? loaded.url : cache[id];
  return failedId === id ? <p role="alert">图片无法读取，请勿覆盖原草稿。</p> : url ? <img src={url} alt={alt || "题图"} /> : <span>正在读取图片…</span>;
}
function TextPreview({ text, style }: { text: string; style: TextStyle }) {
  if (style === "粗体") return <strong>{text}</strong>;
  if (style === "斜体") return <em>{text}</em>;
  if (style === "下划线") return <u>{text}</u>;
  if (style === "上标") return <sup>{text}</sup>;
  if (style === "下标") return <sub>{text}</sub>;
  return <>{text}</>;
}
function Preview({ draft, cache, volume }: { draft: Draft; cache: Record<string, string>; volume: Volume }) {
  const sections = volumeSections(draft, volume);
  return <section className="preview" aria-label="内容预览"><h2 className="preview-title">内容预览</h2>{sections.blocks.map((block, index) => {
    if (block.type === "paragraph") return <p key={index} className="preview-text">{block.runs.map((run, i) => run.type === "text" ? <TextPreview key={i} {...run} /> : <Formula key={i} latex={run.latex} />)}</p>;
    if (block.type === "formula") return <Formula key={index} latex={block.latex} display />;
    if (block.type === "image") return <ImageView key={index} id={block.id} alt={block.alt} cache={cache} />;
    return <div className="table-scroll" key={index}><table><tbody>{block.rows.map((row, y) => <tr key={y}>{row.map((cell, x) => <td key={x}>{cell}</td>)}</tr>)}</tbody></table></div>;
  })}{sections.answer && <section className="answer"><h2>参考答案</h2><p className="preview-text">{sections.answer}</p></section>}</section>;
}
export default function App() {
  const [tab, setTab] = useState<"editor" | "paper">("editor");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saved, setSaved] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [volume, setVolume] = useState<Volume>("student");
  const [imageCache, setImageCache] = useState<Record<string, string>>({});
  useEffect(() => { window.paperweave.loadDraft().then((value) => { if (!isDraft(value)) throw Error("草稿格式不受支持"); setDraft(value); setSaved(JSON.stringify(value)); }).catch((e: unknown) => setError(`读取失败：${String(e)}。原数据已保留。`)); }, []);
  useEffect(() => { const handler = (event: BeforeUnloadEvent) => { if (draft && JSON.stringify(draft) !== saved) { event.preventDefault(); event.returnValue = ""; } }; window.addEventListener("beforeunload", handler); return () => window.removeEventListener("beforeunload", handler); }, [draft, saved]);
  const update = (index: number, block: Block) => setDraft((old) => old && ({ ...old, blocks: old.blocks.map((b, i) => i === index ? block : b) }));
  const append = (block: Block) => setDraft((old) => old && ({ ...old, blocks: [...old.blocks, block] }));
  function adoptAi(questions: AiQuestion[]) {
    setDraft((old) => {
      if (!old) return old;
      const blocks = [...old.blocks];
      const answers: string[] = [];
      const sources: DraftSource[] = [];
      for (const question of questions) {
        const adopted = questionToBlocks(question);
        blocks.push(...adopted.blocks);
        if (adopted.answer.trim()) answers.push(adopted.answer.trim());
        sources.push({ pages: [question.page], uncertain: [...question.uncertain] });
      }
      return { ...old, blocks, teacherAnswer: [old.teacherAnswer.trim(), ...answers].filter(Boolean).join("\n\n"), sources: [...old.sources, ...sources] };
    });
  }
  async function save() {
    if (!draft) return;
    const snapshot = draft;
    setSaving(true); setError(""); setMessage("");
    try { await window.paperweave.saveDraft(snapshot); setSaved(JSON.stringify(snapshot)); setMessage("草稿已保存到本机。"); }
    catch (e) { setError(`保存失败：${String(e)}。当前编辑内容仍在。`); }
    finally { setSaving(false); }
  }
  async function addImage() {
    try { const picked = await window.paperweave.chooseImage(); if (!picked) return; setImageCache((old) => ({ ...old, [picked.id]: picked.url })); append({ type: "image", id: picked.id, alt: "" }); }
    catch (e) { setError(`无法添加图片：${String(e)}`); }
  }
  async function ensurePreviewReady(current: Draft) {
    // 等待卷切换与界面渲染落定，再检查预览实际使用的字体、图片和尺寸。
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    await document.fonts.ready;
    if ([...document.fonts].some((font) => font.status === "error")) throw Error("字体加载失败，请重试");
    const preview = document.querySelector<HTMLElement>(".preview");
    if (!preview || preview.querySelector("[data-invalid-formula]")) throw Error("存在空白或无法渲染的公式，请先修改");
    if (preview.querySelectorAll("img").length !== current.blocks.filter((block) => block.type === "image").length) throw Error("图片尚未加载或读取失败，请稍后重试");
    const width = 170 * 96 / 25.4;
    const height = 257 * 96 / 25.4;
    for (const image of preview.querySelectorAll("img")) {
      await image.decode();
      if (!image.naturalWidth || !image.naturalHeight) throw Error("图片无法读取");
      if (image.naturalWidth > width || image.naturalHeight > height) throw Error("图片超过 A4 可打印区域，请先调整图片尺寸后重新添加");
    }
    for (const element of preview.querySelectorAll<HTMLElement>(".katex, tr")) {
      const rect = element.getBoundingClientRect();
      if (rect.width > width + 1 || rect.height > height + 1 || element.scrollWidth > width + 1) throw Error("公式或表格超出 A4 可打印区域，请调整后重试");
    }
  }
  async function exportPdf() {
    if (!draft) return;
    setExporting(true); setError(""); setMessage("");
    try {
      await ensurePreviewReady(draft);
      const result = await window.paperweave.exportPdf();
      if (!result.canceled) setMessage(result.openError ? `PDF 已保存，但无法自动打开：${result.openError}` : "PDF 已保存并打开。打印时请选择 A4 和 100% 缩放，避免自动缩放。");
    } catch (e) { setError(`无法生成 PDF：${String(e)}。草稿仍在。`); }
    finally { setExporting(false); }
  }
  async function exportDualPdf() {
    if (!draft) return;
    setExporting(true); setError(""); setMessage("");
    let id: string | null = null;
    try {
      id = await window.paperweave.beginPdfPair();
      if (!id) return;
      setVolume("student");
      await ensurePreviewReady(draft);
      await window.paperweave.captureStudentPdf(id);
      setVolume("teacher");
      await ensurePreviewReady(draft);
      const result = await window.paperweave.finishPdfPair(id);
      id = null;
      const failed = result.openErrors.filter(Boolean);
      setMessage(failed.length ? `双卷已保存，但有文件无法自动打开：${failed.join("；")}` : "学生卷与教师答案卷已保存并打开。打印时请选择 A4 和 100% 缩放。");
    } catch (e) {
      if (id) await window.paperweave.cancelPdfPair(id).catch(() => undefined);
      setError(`无法生成双卷：${String(e)}。草稿仍在。`);
    } finally {
      setVolume("student");
      setExporting(false);
    }
  }
  function paste(event: React.ClipboardEvent) {
    if (event.clipboardData.types.includes("text/html") || [...event.clipboardData.items].some((item) => item.kind === "file")) {
      event.preventDefault(); setError("不支持直接粘贴带格式的内容或图片。请先粘贴为纯文本，图片请用“添加图片”；复杂内容可保留清晰裁图并核对。");
    }
  }
  if (tab === "paper") return <PaperWorkbench onBack={() => setTab("editor")} />;
  if (!draft) return <main><h1>拾题成卷</h1><p role={error ? "alert" : undefined}>{error || "正在读取草稿…"}</p></main>;
  const dirty = JSON.stringify(draft) !== saved;
  const sourcePages = [...new Set(draft.sources.flatMap((source) => source.pages))].sort((a, b) => a - b);
  const sourceUncertain = [...new Set(draft.sources.flatMap((source) => source.uncertain))];
  return <main onPasteCapture={paste}>
    <nav className="paper-tabs" aria-label="功能切换"><strong>录题草稿</strong><button onClick={() => setTab("paper")}>题库与组卷</button></nav>
    <fieldset disabled={exporting} className="editor-controls">
    <header><div><h1>编辑草稿</h1><p>本地试用版 · 内容需要自行核对</p></div><button onClick={save} disabled={saving || !dirty}>{saving ? "保存中…" : "保存草稿"}</button></header>
    <p className="intro">按顺序添加内容。文本可分成多段以设置样式；公式使用 LaTeX。表格仅支持纯文字，不支持合并单元格。复杂格式请保留清晰裁图或手工改写并核对。</p>
    <AiPanel onAdopt={adoptAi} />
    {sourcePages.length > 0 && <section className="ai-result" aria-label="原卷来源">
      <h3>原卷来源</h3>
      <p>来源页：第 {sourcePages.join("、")} 页</p>
      {sourceUncertain.length > 0 && <p className="uncertain">待核：{sourceUncertain.join("；")}</p>}
    </section>}
    <div className="toolbar" aria-label="添加内容"><button onClick={() => append({ type: "paragraph", runs: [newRun()] })}>添加段落</button><button onClick={() => append({ type: "formula", latex: "" })}>添加独立公式</button><button onClick={addImage}>添加图片</button><button onClick={() => append({ type: "table", rows: [["", ""], ["", ""]] })}>添加表格</button></div>
    <p aria-live="polite">{dirty ? "有未保存的修改" : "没有未保存的修改"} {message}</p>{error && <p className="error" role="alert">{error} <button onClick={() => setError("")}>关闭提示</button></p>}
    {draft.blocks.map((block, index) => <section className="block" key={index} aria-label={`内容 ${index + 1}`}>
      <div className="block-head"><strong>{index + 1}. {block.type === "paragraph" ? "段落" : block.type === "formula" ? "独立公式" : block.type === "image" ? "图片" : "表格"}</strong><div><button disabled={index === 0} onClick={() => setDraft((old) => { if (!old) return old; const blocks = [...old.blocks]; [blocks[index - 1], blocks[index]] = [blocks[index], blocks[index - 1]]; return { ...old, blocks }; })}>上移</button><button disabled={index === draft.blocks.length - 1} onClick={() => setDraft((old) => { if (!old) return old; const blocks = [...old.blocks]; [blocks[index + 1], blocks[index]] = [blocks[index], blocks[index + 1]]; return { ...old, blocks }; })}>下移</button><button onClick={() => { if (confirm("删除此内容？")) setDraft((old) => old && ({ ...old, blocks: old.blocks.filter((_, i) => i !== index) })); }}>删除</button></div></div>
      {block.type === "paragraph" && <>
        {block.runs.map((run, ri) => <div className="run" key={ri}>
          {run.type === "text" ? <><label>文本 {ri + 1}<textarea value={run.text} onChange={(e) => update(index, { ...block, runs: block.runs.map((v, i) => i === ri ? { ...run, text: e.target.value } : v) })} /></label><label>样式<select value={run.style} onChange={(e) => update(index, { ...block, runs: block.runs.map((v, i) => i === ri ? { ...run, style: e.target.value as TextStyle } : v) })}>{styles.map((style) => <option key={style}>{style}</option>)}</select></label></> : <><label>行内公式 {ri + 1}<input value={run.latex} onChange={(e) => update(index, { ...block, runs: block.runs.map((v, i) => i === ri ? { ...run, latex: e.target.value } : v) })} /></label><Formula latex={run.latex} /></>}
          <button aria-label={`删除第 ${ri + 1} 段文本或公式`} onClick={() => update(index, { ...block, runs: block.runs.filter((_, i) => i !== ri) })}>删除</button>
        </div>)}
        <div className="toolbar"><button onClick={() => update(index, { ...block, runs: [...block.runs, newRun()] })}>添加文字</button><button onClick={() => update(index, { ...block, runs: [...block.runs, { type: "formula", latex: "" }] })}>添加行内公式</button></div>
      </>}
      {block.type === "formula" && <><label>LaTeX 公式<input value={block.latex} onChange={(e) => update(index, { ...block, latex: e.target.value })} /></label><Formula latex={block.latex} display /></>}
      {block.type === "image" && <><ImageView id={block.id} alt={block.alt} cache={imageCache} /><label>图片说明<input value={block.alt} onChange={(e) => update(index, { ...block, alt: e.target.value })} /></label></>}
      {block.type === "table" && <><div className="table-scroll"><table><tbody>{block.rows.map((row, y) => <tr key={y}>{row.map((cell, x) => <td key={x}><input aria-label={`第 ${y + 1} 行第 ${x + 1} 列`} value={cell} onChange={(e) => update(index, { ...block, rows: block.rows.map((r, yi) => r.map((c, xi) => yi === y && xi === x ? e.target.value : c)) })} /></td>)}</tr>)}</tbody></table></div><div className="toolbar"><button disabled={block.rows.length >= 30} onClick={() => update(index, { ...block, rows: [...block.rows, block.rows[0].map(() => "")] })}>添加行</button><button disabled={block.rows[0].length >= 10} onClick={() => update(index, { ...block, rows: block.rows.map((r) => [...r, ""]) })}>添加列</button></div></>}
    </section>)}
    {!draft.blocks.length && <p>暂无内容，可从上方添加段落。</p>}
    <section className="block"><label>教师参考答案（仅供教师卷样张使用）<textarea value={draft.teacherAnswer} onChange={(e) => setDraft((old) => old && ({ ...old, teacherAnswer: e.target.value }))} /></label><p className="muted">目前仅支持纯文本，答案与题号的自动对应及评分尚未实现。</p></section>
    <button onClick={exportPdf} disabled={saving}>{exporting ? "正在生成 PDF…" : "生成并预览草稿 PDF"}</button>
    <button onClick={exportDualPdf} disabled={saving}>{exporting ? "正在生成 PDF…" : "生成学生卷与教师答案卷"}</button>
    </fieldset>
    <Preview draft={draft} cache={imageCache} volume={volume} />
  </main>;
}
