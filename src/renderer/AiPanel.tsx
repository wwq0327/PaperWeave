import { useEffect, useState } from "react";
import { AI_LIMITS, isAiDraft, normalizeAiInput, type AiDraft, type AiInput, type AiQuestion } from "../shared/ai";
import type { AiConfig } from "../shared/ai-config";
import AiImageInput, { type AiImageSelection } from "./AiImageInput";
import { messageOf } from "./messages";

type PdfPages = { name: string; pages: { page: number; text: string }[]; hasText: boolean };
type PublicConfig = AiConfig & { hasKey: boolean };

export default function AiPanel({ onAdopt }: { onAdopt: (questions: AiQuestion[]) => void }) {
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [configDraft, setConfigDraft] = useState<AiConfig>({ baseUrl: "", textModel: "", imageModel: "" });
  const [keyInput, setKeyInput] = useState("");
  const [configMessage, setConfigMessage] = useState("");
  const [configError, setConfigError] = useState("");
  const [pdf, setPdf] = useState<PdfPages | null>(null);
  const [selectedPages, setSelectedPages] = useState<number[]>([]);
  const [manualPage, setManualPage] = useState("1");
  const [text, setText] = useState("");
  const [mode, setMode] = useState<"text" | "image">("text");
  const [images, setImages] = useState<AiImageSelection[]>([]);
  const [imageNote, setImageNote] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [sending, setSending] = useState(false);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [result, setResult] = useState<AiDraft | null>(null);
  const [adopted, setAdopted] = useState<number[]>([]);
  const [resultMessage, setResultMessage] = useState("");
  const [resultError, setResultError] = useState("");
  const [canRetry, setCanRetry] = useState(false);

  useEffect(() => {
    window.paperweave.getAiConfig()
      .then((value) => { setConfig(value); setConfigDraft({ baseUrl: value.baseUrl, textModel: value.textModel, imageModel: value.imageModel }); })
      .catch((error: unknown) => setConfigError(`读取 AI 设置失败：${messageOf(error)}`));
  }, []);

  async function saveConfig() {
    setConfigMessage(""); setConfigError("");
    try {
      const value = await window.paperweave.saveAiConfig(configDraft);
      setConfig(value);
      setConfigDraft({ baseUrl: value.baseUrl, textModel: value.textModel, imageModel: value.imageModel });
      setConfigMessage("模型服务设置已保存。");
    } catch (error) { setConfigError(`保存设置失败：${messageOf(error)}`); }
  }

  async function saveKey() {
    setConfigMessage(""); setConfigError("");
    try {
      const value = await window.paperweave.saveAiKey(keyInput);
      setConfig(value); setKeyInput("");
      setConfigMessage("密钥已加密保存在本机，界面不会回显。");
    } catch (error) { setConfigError(`保存密钥失败：${messageOf(error)}`); }
  }

  async function clearKey() {
    setConfigMessage(""); setConfigError("");
    try {
      setConfig(await window.paperweave.clearAiKey());
      setConfigMessage("本机保存的密钥已清除。");
    } catch (error) { setConfigError(`清除密钥失败：${messageOf(error)}`); }
  }

  async function choosePdf() {
    setResultMessage(""); setResultError(""); setCanRetry(false);
    try {
      const picked = await window.paperweave.extractPdfText();
      if (!picked) return;
      setPdf(picked);
      const withText = picked.pages.filter((page) => page.text).map((page) => page.page);
      setSelectedPages(withText);
      if (!withText.length) {
        setText("");
        setResultError("未从这份 PDF 提取到文字，可能是扫描件。请改用裁图输入，或把文字粘贴到下方后人工核对。");
        return;
      }
      applyPages(picked, withText);
      if (picked.pages.some((page) => !page.text)) setResultMessage("部分页面没有可提取文字，已跳过。");
      else setResultMessage(`已提取 ${picked.name} 的 ${withText.length} 页文字，可勾选页面后重新载入。`);
    } catch (error) { setResultError(`提取 PDF 文字失败：${messageOf(error)}`); }
  }

  function applyPages(source = pdf, pages = selectedPages) {
    if (!source) return;
    const parts = source.pages
      .filter((page) => pages.includes(page.page) && page.text)
      .map((page) => `【第 ${page.page} 页】\n${page.text}`);
    setText(parts.join("\n\n"));
    setConfirming(false);
    setResult(null); setAdopted([]);
  }

  function togglePage(page: number) {
    setSelectedPages((old) => old.includes(page) ? old.filter((value) => value !== page) : [...old, page].sort((a, b) => a - b));
  }

  function requestConfirmation() {
    setResultMessage(""); setResultError(""); setCanRetry(false);
    const checked = buildInput();
    if (!checked.ok) { setResultError(checked.error); return; }
    setConfirming(true);
  }

  function buildInput(): { ok: true; input: AiInput } | { ok: false; error: string } {
    if (mode === "image") return normalizeAiInput({ mode: "images", images: images.map(({ dataUrl, page }) => ({ dataUrl, page })), note: imageNote });
    return normalizeAiInput({ mode: "text", text, pages: inputPages() });
  }

  function switchMode(next: "text" | "image") {
    if (sending) return;
    setMode(next); setConfirming(false); setResult(null); setAdopted([]);
    setResultMessage(""); setResultError("");
  }

  function changeImages(next: AiImageSelection[]) {
    setImages(next); setConfirming(false); setResult(null); setAdopted([]);
  }

  function inputPages(): number[] {
    if (pdf) return selectedPages;
    const page = Number(manualPage);
    return Number.isInteger(page) && page >= 1 && page <= 2000 ? [page] : [];
  }

  async function send() {
    const checked = buildInput();
    if (!checked.ok) { setResultError(checked.error); setConfirming(false); return; }
    const id = crypto.randomUUID();
    setRequestId(id); setSending(true); setResultError(""); setResultMessage(""); setCanRetry(false);
    try {
      const draft = await window.paperweave.generateAiDraft(id, checked.input);
      if (!isAiDraft(draft)) throw new Error("模型返回格式无法解析，请重试或手工录入");
      setResult(draft); setAdopted([]);
      setResultMessage("草稿已生成，请逐题对照原卷核对后再采纳。");
    } catch (error) {
      const message = messageOf(error);
      if (message.includes("已取消")) setResultMessage("已取消。输入文字与编辑器内容都保留在本机。");
      else { setResultError(message); setCanRetry(true); }
    } finally {
      setSending(false); setRequestId(null); setConfirming(false);
    }
  }

  async function cancel() {
    if (!requestId) return;
    await window.paperweave.cancelAiDraft(requestId).catch(() => undefined);
    setResultMessage("正在取消，已生成的文字不会自动写入编辑器。");
  }

  function adopt(questions: AiQuestion[], index?: number) {
    if (!questions.length) return;
    onAdopt(questions);
    if (index !== undefined) setAdopted((old) => [...old, index]);
    else setAdopted(result ? result.questions.map((_, i) => i) : []);
    setResultMessage(`已采纳 ${questions.length} 题。内容已进入编辑区，请核对修改后保存草稿。`);
  }

  const chars = [...text].length;
  const pagesLabel = inputPages();
  const imagePages = [...new Set(images.map((image) => image.page))];
  const localInsecure = config && /^http:\/\//.test(config.baseUrl) && !/^http:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(config.baseUrl);

  return <section className="ai-panel" aria-label="AI 草稿">
    <h2>AI 草稿</h2>
    <p className="muted">从本机提取文字或拖选裁图，确认发送内容后才调用模型。草稿必须对照原卷逐题核对；不确定处会标为待核。</p>
    <div className="ai-modes" role="tablist" aria-label="AI 输入方式">
      <button role="tab" aria-selected={mode === "text"} className={mode === "text" ? "active" : ""} onClick={() => switchMode("text")} disabled={sending}>文字输入</button>
      <button role="tab" aria-selected={mode === "image"} className={mode === "image" ? "active" : ""} onClick={() => switchMode("image")} disabled={sending}>裁图输入</button>
    </div>

    <details className="ai-settings">
      <summary>模型服务与密钥设置</summary>
      <div className="ai-grid">
        <label>服务地址<input value={configDraft.baseUrl} onChange={(e) => setConfigDraft({ ...configDraft, baseUrl: e.target.value })} placeholder="https://api.anthropic.com" /></label>
        <label>文字模型<input value={configDraft.textModel} onChange={(e) => setConfigDraft({ ...configDraft, textModel: e.target.value })} /></label>
        <label>图像模型（裁图输入用）<input value={configDraft.imageModel} onChange={(e) => setConfigDraft({ ...configDraft, imageModel: e.target.value })} /></label>
      </div>
      <div className="toolbar"><button onClick={saveConfig}>保存模型设置</button>{config?.hasKey ? <button onClick={clearKey}>清除已保存密钥</button> : null}</div>
      {localInsecure && <p className="error" role="alert">当前服务地址使用明文 HTTP，密钥可能在传输中泄露。除本机调试外请使用 HTTPS。</p>}
      <label>模型密钥（只保存到本机安全存储，不会回显）<input type="password" autoComplete="off" value={keyInput} onChange={(e) => setKeyInput(e.target.value)} placeholder={config?.hasKey ? "已保存密钥；输入新密钥可替换" : "输入 API 密钥"} /></label>
      <div className="toolbar"><button onClick={saveKey} disabled={!keyInput.trim()}>加密保存密钥</button><span className="muted">{config?.hasKey ? "本机已有密钥" : "本机尚未保存密钥"}</span></div>
      {configMessage && <p className="muted" role="status">{configMessage}</p>}
      {configError && <p className="error" role="alert">{configError}</p>}
    </details>

    {mode === "text" && <>
      <div className="toolbar">
        <button onClick={choosePdf} disabled={sending}>选择 PDF 并提取文字</button>
        {pdf && <span className="muted">{pdf.name}</span>}
      </div>

      {pdf && <>
        <div className="ai-pages" aria-label="选择原卷页">
          {pdf.pages.map((page) => <label key={page.page} className={page.text ? "ai-page" : "ai-page empty"}>
            <input type="checkbox" checked={selectedPages.includes(page.page)} disabled={!page.text} onChange={() => togglePage(page.page)} />
            第 {page.page} 页{page.text ? `（${[...page.text].length} 字）` : "（无可提取文字）"}
          </label>)}
        </div>
        <div className="toolbar"><button onClick={() => applyPages()} disabled={!selectedPages.length}>载入所选页文字</button><span className="muted">发送页码：{selectedPages.length ? selectedPages.join("、") : "未选择"}</span></div>
      </>}

      {!pdf && <label>原卷页码（手工粘贴文字时填写）<input type="number" min={1} max={2000} value={manualPage} onChange={(e) => { setManualPage(e.target.value); setConfirming(false); }} /></label>}

      <label>待处理文字（{chars} / {AI_LIMITS.textChars} 字）
        <textarea className="ai-text" value={text} onChange={(e) => { setText(e.target.value); setConfirming(false); setResult(null); setAdopted([]); }} placeholder="从 PDF 提取后会自动填入；也可以直接粘贴已确认的纯文字。" />
      </label>
      {chars > AI_LIMITS.textChars && <p className="error" role="alert">文字超过 {AI_LIMITS.textChars} 字，请取消勾选部分页面或按题分批提交。</p>}
    </>}

    {mode === "image" && <AiImageInput
      selections={images}
      onChange={changeImages}
      note={imageNote}
      onNoteChange={(value) => { setImageNote(value); setConfirming(false); }}
      onError={(message) => { setResultError(message); setCanRetry(false); }}
      disabled={sending}
    />}

    {!confirming && <button onClick={requestConfirmation} disabled={sending}>生成 AI 草稿…</button>}

    {confirming && <section className="ai-confirm" aria-label="发送前确认">
      <h3>确认发送内容</h3>
      <p>服务：{config?.baseUrl || "未读取"} · 模型：{(mode === "text" ? config?.textModel : config?.imageModel) || "未设置"} · {mode === "text" ? `页码：${pagesLabel.length ? pagesLabel.join("、") : "无效"}` : `裁图：${images.length} 张（第 ${imagePages.join("、")} 页）`}</p>
      <p>{mode === "text" ? "本次只发送下方文字，不会上传整份 PDF、题库或其他文件。" : "本次只发送下方裁图，不会上传整份 PDF、题库或其他文件。"}</p>
      {mode === "text"
        ? <pre className="ai-input-preview">{text}</pre>
        : <>
          <div className="ai-input-images">{images.map((image, index) => <figure key={index}>
            <img src={image.dataUrl} alt={`发送裁图 ${index + 1}`} />
            <figcaption>第 {image.page} 页 · {Math.ceil(image.bytes / 1024)} KiB</figcaption>
          </figure>)}</div>
          {imageNote.trim() && <p className="muted">补充说明：{imageNote}</p>}
        </>}
      <div className="toolbar">
        <button className="primary" onClick={send} disabled={sending}>{sending ? "正在生成…（最多 120 秒）" : "确认发送并生成草稿"}</button>
        <button onClick={() => setConfirming(false)} disabled={sending}>返回修改</button>
        {sending && <button onClick={cancel}>取消请求</button>}
      </div>
    </section>}

    {resultMessage && <p className="muted" role="status">{resultMessage}</p>}
    {resultError && <p className="error" role="alert">{resultError}{canRetry && <button onClick={requestConfirmation}>重试生成</button>} <button onClick={() => { setResultError(""); setCanRetry(false); }}>关闭提示</button></p>}

    {result && <section className="ai-result" aria-label="AI 草稿结果">
      <div className="ai-result-head"><h3>待核草稿（{result.questions.length} 题）</h3><button onClick={() => adopt(result.questions)}>全部采纳</button></div>
      {result.notes.map((note, index) => <p key={index} className="muted">说明：{note}</p>)}
      {result.questions.map((question, index) => {
        const done = adopted.includes(index);
        return <article className="ai-question" key={index} aria-label={`AI 草稿第 ${index + 1} 题`}>
          <header><strong>第 {index + 1} 题 · 原卷第 {question.page} 页</strong><button onClick={() => adopt([question], index)} disabled={done}>{done ? "已采纳" : "采纳此题"}</button></header>
          <p className="preview-text">{question.stem}</p>
          {question.subquestions.map((item, i) => <p key={i} className="preview-text">{item}</p>)}
          {question.options.map((item, i) => <p key={i} className="preview-text">{String.fromCharCode(65 + i)}. {item}</p>)}
          {question.tags.length > 0 && <p className="muted">标签：{question.tags.join("、")}</p>}
          {question.uncertain.length > 0 && <p className="uncertain">待核：{question.uncertain.join("；")}</p>}
          {question.answer && <p className="muted">参考答案（采纳后写入教师卷）：{question.answer}</p>}
        </article>;
      })}
    </section>}
  </section>;
}
