import { useEffect, useState } from "react";
import type { AiConfig } from "../shared/ai-config";
import type { WholePaperTaskView } from "../shared/whole-paper-view";

const status = { pending: "待处理", running: "进行中", succeeded: "已处理", failed: "失败待重试", skipped: "无文字" };

export default function WholePaperPanel({ examId, sectionId, fileId, sectionName }: { examId: string; sectionId: string; fileId?: string; sectionName: string }) {
  const [tasks, setTasks] = useState<WholePaperTaskView[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
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
