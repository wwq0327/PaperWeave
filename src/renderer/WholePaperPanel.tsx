import { useEffect, useState } from "react";
import type { AiConfig } from "../shared/ai-config";
import type { WholePaperTaskDetail, WholePaperTaskView } from "../shared/whole-paper-view";

const status = { pending: "待处理", running: "进行中", succeeded: "已处理", failed: "失败待重试", skipped: "无文字" };

export default function WholePaperPanel({ examId, sectionId, fileId, sectionName, onPageChange }: { examId: string; sectionId: string; fileId?: string; sectionName: string; onPageChange: (page: number) => void }) {
  const [tasks, setTasks] = useState<WholePaperTaskView[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<WholePaperTaskDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<{ task: WholePaperTaskView; config: AiConfig & { hasKey: boolean } } | null>(null);
  const [error, setError] = useState("");
  async function refresh() { setTasks(await window.paperweave.listWholePaper(examId)); }
  useEffect(() => {
    let live = true;
    window.paperweave.listWholePaper(examId).then((result) => { if (live) setTasks(result); }).catch((reason: unknown) => { if (live) setError(`读取任务失败：${String(reason)}`); });
    return () => { live = false; };
  }, [examId]);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => { void refresh().catch(() => undefined); }, 1000);
    return () => clearInterval(timer);
  }, [running, examId]);
  async function prepare() {
    if (!fileId || !sectionId || busy) return;
    setBusy(true); setError("");
    try {
      const task = await window.paperweave.prepareWholePaper(examId, sectionId, fileId);
      setTasks((previous) => [...previous, task]); setSelected(task.id);
    } catch (reason) { setError(`准备任务失败：${String(reason)}`); }
    finally { setBusy(false); }
  }
  async function confirm(task: WholePaperTaskView) {
    setError("");
    try { setConfirmation({ task, config: await window.paperweave.getAiConfig() }); }
    catch (reason) { setError(`读取模型设置失败：${String(reason)}`); }
  }
  async function run() {
    if (!confirmation || running) return;
    const { task, config } = confirmation;
    setConfirmation(null); setRunning(task.id); setError("");
    try { await window.paperweave.runWholePaper(examId, task.id, task.revision, { baseUrl: config.baseUrl, textModel: config.textModel }); }
    catch (reason) { setError(`执行任务失败：${String(reason)}`); }
    finally { await refresh().catch(() => undefined); setRunning(null); }
  }
  const task = tasks.find((entry) => entry.id === selected);
  useEffect(() => {
    let live = true;
    setDetail(null);
    if (task) window.paperweave.getWholePaperDetail(examId, task.id).then((result) => { if (live) setDetail(result); }).catch((reason: unknown) => { if (live) setError(`读取识别结果失败：${String(reason)}`); });
    return () => { live = false; };
  }, [examId, task?.id, task?.revision]);
  const toSend = confirmation?.task.batches.filter((batch) => batch.status === "pending" || batch.status === "failed" || batch.status === "running") ?? [];
  const pages = [...new Set(toSend.flatMap((batch) => batch.pages))];
  return <section className="paper-panel" aria-label="整卷任务">
    <header><h2>整卷任务</h2></header>
    <p>准备文字 PDF 的整卷任务，当前分部：{sectionName || "未选择"}。准备步骤不发送模型，也不创建题目。</p>
    <button onClick={() => void prepare()} disabled={busy || !fileId || !sectionId}>{busy ? "正在准备…" : "准备整卷文字任务"}</button>
    {error && <p role="alert" className="error">{error}</p>}
    {tasks.length === 0 ? <p className="muted">尚无整卷任务。</p> : <ul>{tasks.map((entry, index) => <li key={entry.id}><button onClick={() => { setSelected(entry.id); setConfirmation(null); }}>查看任务 {index + 1}</button> · {entry.batches.length} 批</li>)}</ul>}
    {task && <div aria-label="整卷任务详情" role="region">
      <p>已准备 {task.batches.length} 批。模型结果尚需对照原卷核对，批量建题尚未接入。</p>
      {task.emptyPages.length > 0 && <p role="status">第 {task.emptyPages.join("、")} 页没有可提取文字，可能是扫描页，尚未处理。</p>}
      <ul>{task.batches.map((batch, index) => <li key={index}>第 {index + 1} 批 · 原卷第 {batch.pages.join("、")} 页 · {status[batch.status]}{batch.reviewBoundaryBefore ? " · 跨批边界待核" : ""}</li>)}</ul>
      {detail?.results.map((result, batchIndex) => result && <section key={batchIndex} aria-label={`第 ${batchIndex + 1} 批识别结果`}>
        <h3>第 {batchIndex + 1} 批识别结果 · 均待核对</h3>
        {result.notes.map((note, index) => <p key={index}>整体提示：{note}</p>)}
        {result.questions.map((question, index) => <article key={index} className="paper-card">
          <div><strong>原卷第 {question.page} 页 · 题 {question.originalNumber || "待核"}</strong><p>{question.stem}</p>
            {question.subquestions.map((sub, i) => <p key={i}>小问：{sub}</p>)}
            {question.options.map((option, i) => <p key={i}>选项：{option}</p>)}
            {question.answer && <p>答案：{question.answer}</p>}
            {question.questionType && <p>题型建议：{question.questionType}</p>}
            {[...question.tags, ...(question.knowledgePoints ?? [])].map((tag, i) => <p key={i}>标签建议：{tag}</p>)}
            {question.uncertain.map((item, i) => <p key={i}>待核：{item}</p>)}
            {(question.parts ?? []).map((part, i) => <div key={i}><p>小问 {part.label || "待核"}：{part.prompt}</p>{part.options.map((option, j) => <p key={j}>选项：{option}</p>)}{part.answer && <p>答案：{part.answer}</p>}{part.explanation && <p>解析：{part.explanation}</p>}<p>原分值：{part.score === null ? "待补" : part.score}</p>{part.uncertain.map((item, j) => <p key={j}>待核：{item}</p>)}</div>)}
            {(question.materials ?? []).map((material, i) => <p key={i}>材料建议：{material.title} · {material.content} · {material.source}</p>)}
          </div><button onClick={() => onPageChange(question.page)}>定位原页</button>
        </article>)}
      </section>)}
      <button disabled={!!running || !task.batches.some((batch) => batch.status === "pending" || batch.status === "failed" || batch.status === "running")} onClick={() => void confirm(task)}>发送或重试整卷任务</button>
      {running === task.id && <button onClick={() => void window.paperweave.cancelWholePaper(task.id)}>取消整卷处理</button>}
    </div>}
    {confirmation && <section aria-label="确认整卷发送" role="region">
      <p>服务：{confirmation.config.baseUrl} · 文字模型：{confirmation.config.textModel}</p>
      <p>将发送 {toSend.length} 个批次，原卷第 {pages.join("、")} 页的提取文字；费用按服务商规则计收。</p>
      <p>未识别页：{confirmation.task.emptyPages.length ? confirmation.task.emptyPages.join("、") : "无"}。请确认发送范围与费用后继续；结果不会自动入库。</p>
      <button onClick={() => void run()}>确认发送整卷文字</button><button onClick={() => setConfirmation(null)}>取消发送</button>
    </section>}
  </section>;
}
