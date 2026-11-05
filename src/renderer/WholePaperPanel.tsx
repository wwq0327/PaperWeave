import { useEffect, useState } from "react";
import type { WholePaperTaskView } from "../shared/whole-paper-view";

const status = { pending: "待处理", running: "进行中", succeeded: "已处理", failed: "失败待重试", skipped: "无文字" };

export default function WholePaperPanel({ examId, sectionId, fileId, sectionName }: { examId: string; sectionId: string; fileId?: string; sectionName: string }) {
  const [tasks, setTasks] = useState<WholePaperTaskView[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    window.paperweave.listWholePaper(examId).then((result) => { if (live) setTasks(result); }).catch((reason: unknown) => { if (live) setError(`读取任务失败：${String(reason)}`); });
    return () => { live = false; };
  }, [examId]);
  async function prepare() {
    if (!fileId || !sectionId || busy) return;
    setBusy(true); setError("");
    try {
      const task = await window.paperweave.prepareWholePaper(examId, sectionId, fileId);
      setTasks((previous) => [...previous, task]); setSelected(task.id);
    } catch (reason) { setError(`准备任务失败：${String(reason)}`); }
    finally { setBusy(false); }
  }
  const task = tasks.find((entry) => entry.id === selected);
  return <section className="paper-panel" aria-label="整卷任务">
    <header><h2>整卷任务</h2></header>
    <p>准备文字 PDF 的整卷任务，当前分部：{sectionName || "未选择"}。此步骤不发送模型，也不创建题目。</p>
    <button onClick={() => void prepare()} disabled={busy || !fileId || !sectionId}>{busy ? "正在准备…" : "准备整卷文字任务"}</button>
    {error && <p role="alert" className="error">{error}</p>}
    {tasks.length === 0 ? <p className="muted">尚无整卷任务。</p> : <ul>{tasks.map((entry, index) => <li key={entry.id}><button onClick={() => setSelected(entry.id)}>查看任务 {index + 1}</button> · {entry.batches.length} 批</li>)}</ul>}
    {task && <div aria-label="整卷任务详情" role="region">
      <p>已准备 {task.batches.length} 批。自动调用模型和批量建题尚未接入。</p>
      {task.emptyPages.length > 0 && <p role="status">第 {task.emptyPages.join("、")} 页没有可提取文字，可能是扫描页，尚未处理。</p>}
      <ul>{task.batches.map((batch, index) => <li key={index}>第 {index + 1} 批 · 原卷第 {batch.pages.join("、")} 页 · {status[batch.status]}{batch.reviewBoundaryBefore ? " · 跨批边界待核" : ""}</li>)}</ul>
    </div>}
  </section>;
}
