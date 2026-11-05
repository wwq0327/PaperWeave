import { useEffect, useState } from "react";
import type { AiConfig } from "../shared/ai-config";
import type { AnswerStatus, Classification, ReviewStatus, Stage } from "../shared/question";
import type { WholePaperIntakeItem, WholePaperIntakeSummary } from "../shared/whole-paper-intake";
import type { WholePaperTaskDetail, WholePaperTaskView } from "../shared/whole-paper-view";

const status = { pending: "待处理", running: "进行中", succeeded: "已处理", failed: "失败待重试", skipped: "无文字" };
const stages: Stage[] = ["小学", "初中", "高中"];
const intakeFilters = ["all", "pending", "duplicate", "failed", "approved"] as const;
type IntakeFilter = (typeof intakeFilters)[number];
const intakeFilterLabels: Record<IntakeFilter, string> = { all: "全部", pending: "待核", duplicate: "重复候选", failed: "失败", approved: "已通过" };
const contentStatusLabels: Record<ReviewStatus, string> = { draft: "内容草稿", pending: "内容待核", approved: "内容已通过" };
const answerStatusLabels: Record<AnswerStatus, string> = { missing: "答案待补", pending: "答案待核", approved: "答案已通过" };
const emptyClassification: Classification = { stage: "初中", subject: "", grade: "", examType: "", year: "", sourceName: "", questionType: "", knowledgePoints: [] };

type WholePaperBatchResult = NonNullable<WholePaperTaskDetail["results"][number]>;

/** 知识点输入与单题录题一致：中英文逗号（含顿号）拆分、trim、去重、去空。 */
function parsePoints(text: string): string[] {
  return [...new Set(text.split(/[,，、]/).map((item) => item.trim()).filter(Boolean))];
}

function intakeRowLabel(row: WholePaperIntakeItem): string {
  return `第 ${row.batchIndex + 1} 批 · ${row.page > 0 ? `原卷第 ${row.page} 页` : "页码待核"} · 题 ${row.originalNumber || "待核"}`;
}

function intakeSelectable(row: WholePaperIntakeItem): boolean {
  return (row.status === "created" || row.status === "revised") && row.problems.length === 0 && row.contentStatus !== "approved";
}

function intakeMatches(row: WholePaperIntakeItem, filter: IntakeFilter): boolean {
  if (filter === "all") return true;
  if (filter === "pending") return (row.status === "created" || row.status === "revised") && row.contentStatus !== "approved";
  if (filter === "duplicate") return row.status === "duplicate";
  if (filter === "failed") return row.status === "failed";
  return row.contentStatus === "approved";
}

function intakeSummaryText(summary: WholePaperIntakeSummary): string {
  const parts = [`已建档 ${summary.created} 题`, `重复候选 ${summary.duplicates} 题`, `失败 ${summary.failed} 题`];
  if (summary.existing > 0) parts.push(`已有 ${summary.existing} 题`);
  if (summary.materials > 0) parts.push(`新建材料 ${summary.materials} 份`);
  return `${parts.join("，")}。`;
}

function classificationSummaryText(value: Classification): string {
  return [
    `学段：${value.stage}`,
    `学科：${value.subject || "未填"}`,
    `年级：${value.grade || "未填"}`,
    `考试类型：${value.examType || "未填"}`,
    `学年：${value.year || "未填"}`,
    `来源：${value.sourceName || "未填"}`,
    `题型：${value.questionType || "未填"}`,
    `知识点：${value.knowledgePoints.length > 0 ? value.knowledgePoints.join("，") : "未填"}`,
  ].join(" · ");
}

export default function WholePaperPanel({ examId, sectionId, fileId, sectionName, onPageChange }: { examId: string; sectionId: string; fileId?: string; sectionName: string; onPageChange: (page: number) => void }) {
  const [tasks, setTasks] = useState<WholePaperTaskView[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<WholePaperTaskDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<{ task: WholePaperTaskView; config: AiConfig & { hasKey: boolean } } | null>(null);
  const [error, setError] = useState("");
  const [intakes, setIntakes] = useState<WholePaperIntakeItem[]>([]);
  const [intakeFilter, setIntakeFilter] = useState<IntakeFilter>("all");
  const [intakeForm, setIntakeForm] = useState<Classification>({ ...emptyClassification });
  const [knowledgeText, setKnowledgeText] = useState("");
  const [intakeConfirm, setIntakeConfirm] = useState(false);
  const [intakeBusy, setIntakeBusy] = useState(false);
  const [createNotice, setCreateNotice] = useState("");
  const [createAlert, setCreateAlert] = useState("");
  const [auditNotice, setAuditNotice] = useState("");
  const [auditAlert, setAuditAlert] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
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
  useEffect(() => {
    let live = true;
    setIntakes([]); setSelectedIds(new Set()); setIntakeFilter("all"); setIntakeConfirm(false);
    setCreateNotice(""); setCreateAlert(""); setAuditNotice(""); setAuditAlert("");
    if (task) window.paperweave.listWholePaperIntakes(examId, task.id).then((rows) => { if (live) setIntakes(rows); }).catch((reason: unknown) => { if (live) setAuditAlert(`读取建档记录失败：${String(reason)}`); });
    return () => { live = false; };
  }, [examId, task?.id]);
  async function refreshIntakes() {
    if (!task) { setIntakes([]); setSelectedIds(new Set()); return; }
    const rows = await window.paperweave.listWholePaperIntakes(examId, task.id);
    setIntakes(rows);
    setSelectedIds((current) => new Set([...current].filter((id) => rows.some((row) => row.id === id))));
  }
  async function createIntake() {
    if (!task || intakeBusy) return;
    setIntakeBusy(true); setCreateAlert(""); setCreateNotice("");
    try {
      const summary = await window.paperweave.createWholePaperIntake(examId, task.id, intakeForm);
      setIntakeConfirm(false);
      setCreateNotice(intakeSummaryText(summary));
      await refreshIntakes().catch(() => undefined);
    } catch (reason) {
      setCreateAlert(`批量建档失败：${String(reason)}`);
    } finally { setIntakeBusy(false); }
  }
  async function resolveDuplicate(row: WholePaperIntakeItem, action: "skip" | "revise") {
    if (!task || intakeBusy) return;
    setIntakeBusy(true); setAuditAlert(""); setAuditNotice("");
    try {
      await window.paperweave.resolveWholePaperIntake(examId, task.id, row.id, action);
      await refreshIntakes().catch(() => undefined);
      setAuditNotice(action === "skip" ? "已跳过重复候选。" : "已创建修订版。");
    } catch (reason) {
      setAuditAlert(`处理重复候选失败：${String(reason)}`);
    } finally { setIntakeBusy(false); }
  }
  async function approveSelected() {
    if (!task || intakeBusy || selectedIds.size === 0) return;
    setIntakeBusy(true); setAuditAlert(""); setAuditNotice("");
    const targets = intakes.filter((row) => selectedIds.has(row.id));
    let ok = 0;
    const failures: string[] = [];
    try {
      for (const row of targets) {
        const label = `第 ${row.batchIndex + 1} 批第 ${row.questionIndex + 1} 题`;
        try {
          if (row.versionId === null) throw new Error("缺少最新题目版本");
          await window.paperweave.setQuestionContentStatus(row.versionId, "approved");
          if (row.answerStatus === "pending") await window.paperweave.setQuestionAnswerStatus(row.versionId, "approved");
          ok += 1;
        } catch (reason) { failures.push(`${label}：${String(reason)}`); }
      }
      setAuditNotice(`已确认通过 ${ok} 题。`);
      if (failures.length > 0) setAuditAlert(`有 ${failures.length} 题未确认通过：${failures.join("；")}`);
      setSelectedIds(new Set());
      await refreshIntakes().catch(() => undefined);
    } finally { setIntakeBusy(false); }
  }
  function toggleSelected(id: string, checked: boolean) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (checked) next.add(id); else next.delete(id);
      return next;
    });
  }
  function updateClassification(patch: Partial<Classification>) { setIntakeForm((current) => ({ ...current, ...patch })); }
  const toSend = confirmation?.task.batches.filter((batch) => batch.status === "pending" || batch.status === "failed" || batch.status === "running") ?? [];
  const pages = [...new Set(toSend.flatMap((batch) => batch.pages))];
  const succeededResults = (detail?.results ?? []).filter((result): result is WholePaperBatchResult => result !== null);
  const succeededBatches = succeededResults.length;
  const questionCount = succeededResults.reduce((sum, result) => sum + result.questions.length, 0);
  const materialCount = succeededResults.reduce((sum, result) => sum + result.questions.reduce((count, question) => count + (question.materials?.length ?? 0), 0), 0);
  const failedBatches = task?.batches.filter((batch) => batch.status === "failed").length ?? 0;
  const visibleIntakes = intakes.filter((row) => intakeMatches(row, intakeFilter));
  return <section className="paper-panel" aria-label="整卷任务">
    <header><h2>整卷任务</h2></header>
    <p>准备文字 PDF 的整卷任务，当前分部：{sectionName || "未选择"}。准备步骤不发送模型，也不创建题目。</p>
    <button onClick={() => void prepare()} disabled={busy || !fileId || !sectionId}>{busy ? "正在准备…" : "准备整卷文字任务"}</button>
    {error && <p role="alert" className="error">{error}</p>}
    {tasks.length === 0 ? <p className="muted">尚无整卷任务。</p> : <ul>{tasks.map((entry, index) => <li key={entry.id}><button onClick={() => { setSelected(entry.id); setConfirmation(null); }}>查看任务 {index + 1}</button> · {entry.batches.length} 批</li>)}</ul>}
    {task && <div aria-label="整卷任务详情" role="region">
      <p>已准备 {task.batches.length} 批。识别结果仍是待核草稿，需设置整卷参数后批量建档；未建档的识别结果不会进入题库。</p>
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
    {task && succeededBatches > 0 && <section className="paper-panel" aria-label="整卷批量建档" role="region">
      <h2>整卷批量建档</h2>
      <p>把已成功识别的批次按同一套分类建档；失败批次不建档，可重试后再建档。材料建议会一并建立草稿并关联。</p>
      <div className="paper-grid">
        <label>学段<select value={intakeForm.stage} onChange={(event) => updateClassification({ stage: event.target.value as Stage })}>{stages.map((stage) => <option key={stage}>{stage}</option>)}</select></label>
        <label>学科<input value={intakeForm.subject} onChange={(event) => updateClassification({ subject: event.target.value })} /></label>
        <label>年级<input value={intakeForm.grade} onChange={(event) => updateClassification({ grade: event.target.value })} /></label>
        <label>考试类型<input value={intakeForm.examType} onChange={(event) => updateClassification({ examType: event.target.value })} /></label>
        <label>学年<input value={intakeForm.year} onChange={(event) => updateClassification({ year: event.target.value })} /></label>
        <label>来源<input value={intakeForm.sourceName} onChange={(event) => updateClassification({ sourceName: event.target.value })} /></label>
        <label>题型<input value={intakeForm.questionType} onChange={(event) => updateClassification({ questionType: event.target.value })} /></label>
        <label>知识点（逗号分隔）<input value={knowledgeText} onChange={(event) => { const text = event.target.value; setKnowledgeText(text); updateClassification({ knowledgePoints: parsePoints(text) }); }} /></label>
      </div>
      <p className="muted">成功批次 {succeededBatches} · 识别题目 {questionCount} · 材料建议 {materialCount} · 失败批次 {failedBatches}</p>
      {failedBatches > 0 && <p className="error">有 {failedBatches} 个批次识别失败，不会建档；可在上方重试后再建档。</p>}
      <button onClick={() => setIntakeConfirm(true)} disabled={intakeBusy}>批量建档</button>
      {intakeConfirm && <section aria-label="确认批量建档" role="region">
        <h3>确认批量建档</h3>
        <p>{classificationSummaryText(intakeForm)}</p>
        <p>将为 {questionCount} 道识别题目建档；重复候选只记录不覆盖已有题目，建档后进入整卷审核区待核。</p>
        <button onClick={() => void createIntake()} disabled={intakeBusy}>确认建档</button>
        <button onClick={() => setIntakeConfirm(false)} disabled={intakeBusy}>取消</button>
      </section>}
      {createNotice && <p role="status">{createNotice}</p>}
      {createAlert && <p role="alert" className="error">{createAlert}</p>}
    </section>}
    {task && intakes.length > 0 && <section className="paper-panel" aria-label="整卷审核" role="region">
      <h2>整卷审核</h2>
      <p className="muted">识别结果均为待核草稿；逐题核对后勾选并批量确认通过，才会进入题库。</p>
      <div className="intake-filters">{intakeFilters.map((filter) => <button key={filter} aria-pressed={intakeFilter === filter} onClick={() => setIntakeFilter(filter)}>{intakeFilterLabels[filter]}</button>)}</div>
      {visibleIntakes.length === 0 ? <p className="muted">当前筛选没有记录。</p> : <ul>
        {visibleIntakes.map((row) => {
          const contentText = row.contentStatus === null ? "—" : contentStatusLabels[row.contentStatus];
          const answerText = row.answerStatus === null ? "—" : answerStatusLabels[row.answerStatus];
          return <li key={row.id} className="intake-review-row">
            <input type="checkbox" aria-label={`选择第 ${row.batchIndex + 1} 批第 ${row.questionIndex + 1} 题`} checked={selectedIds.has(row.id)} disabled={intakeBusy || !intakeSelectable(row)} onChange={(event) => toggleSelected(row.id, event.target.checked)} />
            <div>
              <p><strong>{intakeRowLabel(row)}</strong>{row.status === "duplicate" ? " · 重复候选" : row.status === "failed" ? " · 建档失败" : row.status === "skipped" ? " · 已跳过" : ""}</p>
              {row.preview && <p>{row.preview}</p>}
              <p><span className="intake-badge">{contentText}</span> <span className="intake-badge">{answerText}</span></p>
              {row.message && <p className="muted">{row.message}</p>}
              {row.problems.length > 0 && <ul>{row.problems.map((problem, index) => <li key={index}>{problem}</li>)}</ul>}
              <div className="paper-inline">
                {row.status === "duplicate" && <>
                  <button onClick={() => void resolveDuplicate(row, "skip")} disabled={intakeBusy}>跳过</button>
                  <button onClick={() => void resolveDuplicate(row, "revise")} disabled={intakeBusy}>建修订版</button>
                </>}
                {row.page > 0 && <button onClick={() => onPageChange(row.page)}>定位原页</button>}
              </div>
            </div>
          </li>;
        })}
      </ul>}
      <button onClick={() => void approveSelected()} disabled={intakeBusy || selectedIds.size === 0}>批量确认通过({selectedIds.size})</button>
      {auditNotice && <p role="status">{auditNotice}</p>}
      {auditAlert && <p role="alert" className="error">{auditAlert}</p>}
    </section>}
    {confirmation && <section aria-label="确认整卷发送" role="region">
      <p>服务：{confirmation.config.baseUrl} · 文字模型：{confirmation.config.textModel}</p>
      <p>将发送 {toSend.length} 个批次，原卷第 {pages.join("、")} 页的提取文字；费用按服务商规则计收。</p>
      <p>未识别页：{confirmation.task.emptyPages.length ? confirmation.task.emptyPages.join("、") : "无"}。请确认发送范围与费用后继续；结果不会自动入库。</p>
      <button onClick={() => void run()}>确认发送整卷文字</button><button onClick={() => setConfirmation(null)}>取消发送</button>
    </section>}
  </section>;
}
