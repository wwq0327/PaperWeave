import { useEffect, useState } from "react";
import { basketSelection, type BasketSelection } from "../shared/basket";
import type {
  BasketItemView,
  FinalizationCheckView,
  FinalizationRecordView,
  MaterialView,
  PaperDetailView,
  PaperItemView,
  PaperRecordView,
  QuestionDetailView,
  QuestionSearchView,
} from "../shared/paper-api";
import type { BlankSpace, PaperScoring } from "../shared/paper";
import { selectionDependencies, type AnswerStatus, type QuestionBlock, type QuestionContent, type ReviewStatus, type ScoringPoint, type Stage } from "../shared/question";
import PaperPrintView from "./PaperPrintView";

const stages: Stage[] = ["小学", "初中", "高中"];
const contentStatuses: { value: ReviewStatus; label: string }[] = [
  { value: "draft", label: "草稿" },
  { value: "pending", label: "待核" },
  { value: "approved", label: "已审核" },
];
const answerStatuses: { value: AnswerStatus; label: string }[] = [
  { value: "missing", label: "待补" },
  { value: "pending", label: "待核" },
  { value: "approved", label: "已审核" },
];

type SearchFilter = {
  stage: Stage | "";
  subject: string;
  grade: string;
  examType: string;
  year: string;
  sourceName: string;
  questionType: string;
  knowledgePoint: string;
  contentStatus: ReviewStatus | "";
  answerStatus: AnswerStatus | "";
  keyword: string;
};

function searchPayload(filter: SearchFilter): Record<string, string | number> {
  const payload: Record<string, string | number> = { limit: 30 };
  for (const [key, value] of Object.entries(filter)) if (value !== "") payload[key] = value;
  return payload;
}
const blankSpaces: { value: BlankSpace; label: string }[] = [
  { value: "none", label: "不留白" },
  { value: "small", label: "小留白" },
  { value: "medium", label: "中留白" },
  { value: "large", label: "大留白" },
];
const scoringLabels: Record<string, string> = {
  original: "原评分",
  needsAdjustment: "待调整",
  adjusted: "已调整",
  answerOnly: "仅答案",
};

type ScoringDraft = Omit<ScoringPoint, "score"> & { score: string };

function draftTotal(points: ScoringDraft[]): number {
  return Math.round(points.reduce((sum, point) => sum + (Number(point.score) || 0), 0) * 100) / 100;
}

function blockText(blocks: QuestionBlock[]): string {
  const out: string[] = [];
  for (const block of blocks) {
    if (block.type === "paragraph") out.push(block.runs.map((run) => run.type === "text" ? run.text : run.type === "reference" ? run.fallback : ` ${run.latex} `).join(""));
    else if (block.type === "formula") out.push(block.latex);
    else if (block.type === "image") out.push(`[图：${block.alt || block.id.slice(0, 6)}]`);
    else out.push(block.rows.map((row) => row.join(" ")).join(" / "));
  }
  return out.join(" ").trim();
}

function questionText(detail: QuestionDetailView): string {
  return detail.content.subQuestions.map((sub) => `${sub.originalLabel || sub.id} ${blockText(sub.prompt)}`).join("；");
}

function basketText(item: BasketItemView): string {
  return item.content.subQuestions.filter((sub) => item.subQuestionIds.includes(sub.id)).map((sub) => `${sub.originalLabel || sub.id} ${blockText(sub.prompt)}`).join("；");
}

function subLabel(content: QuestionContent, id: string): string {
  return content.subQuestions.find((sub) => sub.id === id)?.originalLabel || id;
}

function confirmSubText(detail: QuestionDetailView | null, id: string): string {
  const sub = detail?.content.subQuestions.find((item) => item.id === id);
  if (!sub) return id;
  const prompt = blockText(sub.prompt);
  return `${sub.originalLabel || sub.id}${prompt ? ` ${prompt}` : ""}`;
}

function confirmMaterialText(detail: QuestionDetailView | null, id: string): string {
  return detail?.materials.find((material) => material.materialId === id)?.title ?? id;
}

/** 题目详情中的依赖说明：前问用卷内题号，材料用标题；与入篮确认的原因一一对应。 */
function dependencyLines(content: QuestionContent, materials: MaterialView[], subId: string): string[] {
  const dependencies = selectionDependencies(content, subId);
  const label = (id: string) => subLabel(content, id);
  const lines: string[] = [];
  if (dependencies.usesGroupStem) lines.push("题组共用题干");
  if (dependencies.directPrevious.length > 0) lines.push(`直接前问：${dependencies.directPrevious.map(label).join("、")}`);
  const transitive = dependencies.previous.filter((id) => !dependencies.directPrevious.includes(id));
  if (transitive.length > 0) lines.push(`传递前问：${transitive.map(label).join("、")}`);
  if (dependencies.materialIds.length > 0) lines.push(`共享材料：${dependencies.materialIds.map((id) => materials.find((material) => material.materialId === id)?.title ?? id).join("、")}`);
  if (dependencies.groupCandidates.length > 0) lines.push(`组选答候选：${dependencies.groupCandidates.map(label).join("、")}`);
  if (dependencies.independent) lines.push("独立小问");
  return lines;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function PaperWorkbench({ onBack }: { onBack: () => void }) {
  const [papers, setPapers] = useState<PaperRecordView[]>([]);
  const [paperId, setPaperId] = useState("");
  const [paper, setPaper] = useState<PaperDetailView | null>(null);
  const [basket, setBasket] = useState<BasketItemView[]>([]);
  const [results, setResults] = useState<QuestionSearchView[]>([]);
  const [detail, setDetail] = useState<QuestionDetailView | null>(null);
  const [confirmAdd, setConfirmAdd] = useState<{ questionId: string; versionId: string; subQuestionId: string | null; selection: BasketSelection } | null>(null);
  const [finalizations, setFinalizations] = useState<FinalizationRecordView[]>([]);
  const [check, setCheck] = useState<FinalizationCheckView | null>(null);
  const [confirmAnswerGap, setConfirmAnswerGap] = useState(false);
  const [filter, setFilter] = useState<SearchFilter>({
    stage: "初中",
    subject: "数学",
    grade: "九年级",
    examType: "",
    year: "",
    sourceName: "",
    questionType: "",
    knowledgePoint: "",
    contentStatus: "",
    answerStatus: "",
    keyword: "",
  });
  const [form, setForm] = useState({ title: "九年级数学试卷", stage: "初中" as Stage, subject: "数学", grade: "九年级" });
  const [sectionTitle, setSectionTitle] = useState("解答题");
  const [creating, setCreating] = useState(false);
  const [scores, setScores] = useState<Record<string, string>>({});
  const [targets, setTargets] = useState<Record<string, string>>({});
  const [scoringDrafts, setScoringDrafts] = useState<Record<string, ScoringDraft[]>>({});
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [printJob, setPrintJob] = useState<{ id: string; paper: import("../shared/paper-layout").VolumePaper; phase: "student" | "teacher" } | { id: string; phase: "confirm" } | null>(null);

  async function loadBasket() {
    try { setBasket(await window.paperweave.listBasket()); } catch (e) { setError(`读取题篮失败：${errorText(e)}`); }
  }
  async function loadPaper(id = paperId) {
    if (!id) { setPaper(null); setFinalizations([]); return; }
    try {
      const [next, history] = await Promise.all([window.paperweave.getPaper(id), window.paperweave.listPaperFinalizations(id)]);
      setPaper(next);
      setFinalizations(history);
      setCheck(null);
      setConfirmAnswerGap(false);
      setScores(Object.fromEntries(next.sections.flatMap((section) => section.items).map((item) => [item.id, String(item.score)])));
      setTargets((old) => {
        const entries = next.sections.flatMap((section) => section.items.map((item) => [item.id, old[item.id] || next.sections[0]?.id || ""] as const));
        return Object.fromEntries(entries);
      });
    } catch (e) { setError(`读取试卷失败：${errorText(e)}`); }
  }
  async function loadPapers(select?: string) {
    try {
      const list = await window.paperweave.listPapers();
      setPapers(list);
      const next = select ?? (list.some((entry) => entry.id === paperId) ? paperId : list[0]?.id ?? "");
      setPaperId(next);
      await loadPaper(next);
    } catch (e) { setError(`读取试卷列表失败：${errorText(e)}`); }
  }
  async function search() {
    setBusy(true); setError(""); setMessage("");
    try { setResults(await window.paperweave.searchQuestions(searchPayload(filter))); }
    catch (e) { setError(`检索失败：${errorText(e)}`); }
    finally { setBusy(false); }
  }
  useEffect(() => { void loadPapers(); void loadBasket(); void search(); }, []);
  useEffect(() => { void loadPaper(); }, [paperId]);

  async function openDetail(versionId: string) {
    try { setDetail(await window.paperweave.getQuestionDetail(versionId)); }
    catch (e) { setError(`读取题目失败：${errorText(e)}`); }
  }
  async function addToBasket(questionId: string, versionId: string, subQuestionId: string | null, confirm = false) {
    setError(""); setMessage("");
    try {
      const result = await window.paperweave.addToBasket(questionId, versionId, subQuestionId, confirm);
      if (result.status === "confirmation_required") {
        setConfirmAdd({ questionId, versionId, subQuestionId, selection: result.selection });
        return;
      }
      setConfirmAdd(null);
      setMessage("已加入题篮。");
      await loadBasket();
    } catch (e) { setError(`加入题篮失败：${errorText(e)}`); }
  }
  async function createPaper() {
    setBusy(true); setError(""); setMessage("");
    try {
      const created = await window.paperweave.createPaper(form);
      setCreating(false);
      setMessage(`已创建试卷「${created.title}」。`);
      await loadPapers(created.id);
    } catch (e) { setError(`创建试卷失败：${errorText(e)}`); }
    finally { setBusy(false); }
  }
  async function addSection() {
    if (!paper) return;
    try {
      await window.paperweave.addPaperSection(paper.paper.id, sectionTitle);
      await loadPaper(paper.paper.id);
      setMessage("已添加小节。");
    } catch (e) { setError(`添加小节失败：${errorText(e)}`); }
  }
  async function addItem(basketItemId: string) {
    if (!paper) return;
    const sectionId = targets[basketItemId] ?? paper.sections[0]?.id;
    if (!sectionId) { setError("请先在试卷中新建小节。"); return; }
    try {
      await window.paperweave.addBasketItemToPaper(paper.paper.id, sectionId, basketItemId);
      await loadPaper(paper.paper.id);
      setMessage("已加入试卷。");
    } catch (e) { setError(`加入试卷失败：${errorText(e)}`); }
  }
  async function mutate(action: () => Promise<unknown>, success: string) {
    setError(""); setMessage("");
    try { await action(); await loadPaper(); setMessage(success); }
    catch (e) { setError(errorText(e)); }
  }
  function updateItem(item: PaperItemView, patch: Partial<PaperItemView>) {
    if (!paper) return;
    setPaper({ ...paper, sections: paper.sections.map((section) => ({ ...section, items: section.items.map((entry) => entry.id === item.id ? { ...entry, ...patch } : entry) })) });
  }
  async function setScore(item: PaperItemView) {
    const raw = scores[item.id];
    if (raw === undefined || raw.trim() === "") { setError("卷内分值必须是数字。"); return; }
    const score = Number(raw);
    if (!Number.isFinite(score)) { setError("卷内分值必须是数字。"); return; }
    await mutate(async () => {
      const updated = await window.paperweave.setPaperItemScore(item.id, score);
      updateItem(item, updated);
    }, "卷内分值已更新。");
  }
  async function setBlankSpace(item: PaperItemView, blankSpace: BlankSpace) {
    await mutate(async () => {
      const updated = await window.paperweave.setPaperItemBlankSpace(item.id, blankSpace);
      updateItem(item, updated);
    }, "留白已更新。");
  }
  async function setScoring(item: PaperItemView, scoring: PaperScoring): Promise<boolean> {
    setError(""); setMessage("");
    try {
      const updated = await window.paperweave.setPaperItemScoring(item.id, scoring);
      updateItem(item, updated);
      await loadPaper();
      setMessage("评分状态已更新。");
      return true;
    } catch (e) { setError(errorText(e)); return false; }
  }
  function editScoring(item: PaperItemView) {
    const base: ScoringPoint[] = item.scoring.mode === "adjusted"
      ? item.scoring.points
      : item.content.subQuestions
          .filter((sub) => item.subQuestionIds.includes(sub.id))
          .flatMap((sub) => sub.scoring);
    setScoringDrafts((old) => ({ ...old, [item.id]: base.map((point) => ({ ...point, score: String(point.score) })) }));
  }
  function patchDraftPoint(item: PaperItemView, index: number, patch: Partial<ScoringDraft>) {
    setScoringDrafts((old) => ({ ...old, [item.id]: (old[item.id] ?? []).map((point, i) => i === index ? { ...point, ...patch } : point) }));
  }
  function removeDraftPoint(item: PaperItemView, index: number) {
    setScoringDrafts((old) => ({ ...old, [item.id]: (old[item.id] ?? []).filter((_, i) => i !== index) }));
  }
  function addDraftPoint(item: PaperItemView) {
    const point: ScoringDraft = { id: crypto.randomUUID(), description: "", score: "0", slotIds: [] };
    setScoringDrafts((old) => ({ ...old, [item.id]: [...(old[item.id] ?? []), point] }));
  }
  function closeScoring(item: PaperItemView) {
    setScoringDrafts((old) => {
      const next = { ...old };
      delete next[item.id];
      return next;
    });
  }
  async function saveScoring(item: PaperItemView) {
    const draft = scoringDrafts[item.id];
    if (!draft) return;
    if (draft.length === 0) { setError("至少保留一个评分点。"); return; }
    const points: ScoringPoint[] = [];
    for (const point of draft) {
      const score = Number(point.score);
      if (point.description.trim() === "") { setError("评分点说明不能为空。"); return; }
      if (!Number.isFinite(score) || score < 0 || score > 1000) { setError("评分点分值必须是 0 到 1000 之间的数字。"); return; }
      points.push({ id: point.id, description: point.description.trim(), score, slotIds: point.slotIds });
    }
    const saved = await setScoring(item, { mode: "adjusted", points });
    const total = draftTotal(draft);
    if (saved && total !== item.score) setError(`评分点合计 ${total} 分与卷内分值 ${item.score} 分不一致，调整一致后才能定稿。`);
  }
  async function confirmConflict(item: PaperItemView, key: string) {
    await mutate(async () => {
      const updated = await window.paperweave.confirmPaperScoreConflict(item.id, key);
      updateItem(item, updated);
    }, "分值冲突已确认。");
  }
  async function move(item: PaperItemView, sectionId: string, position: number) {
    await mutate(() => window.paperweave.movePaperItem(item.id, sectionId, position), "题目位置已更新。");
  }
  async function printReady() {
    const job = printJob;
    if (!job) return;
    try {
      if (job.phase === "student") {
        await window.paperweave.capturePaperStudent(job.id);
        const teacher = await window.paperweave.getPaperTeacherVolume(job.id);
        setPrintJob({ ...job, paper: teacher, phase: "teacher" });
      } else if (job.phase === "teacher") {
        const preview = await window.paperweave.capturePaperTeacher(job.id);
        setPrintJob({ id: job.id, phase: "confirm" });
        const failed = preview.openErrors.filter(Boolean);
        if (failed.length) setError(`双卷预览无法自动打开，请检查后重试：${failed.join("；")}`);
      }
    } catch (e) {
      await window.paperweave.cancelPaperFinalize(job.id).catch(() => undefined);
      setPrintJob(null);
      setError(`生成双卷失败：${errorText(e)}`);
    }
  }
  async function confirmFinalize(id: string) {
    try {
      await window.paperweave.confirmPaperFinalize(id);
      setPrintJob(null);
      setMessage("双卷已保存为定稿。打印请选 A4 与 100% 缩放。");
      await loadPaper(paperId);
    } catch (e) {
      await window.paperweave.cancelPaperFinalize(id).catch(() => undefined);
      setPrintJob(null);
      setError(`保存定稿失败：${errorText(e)}`);
    }
  }
  async function cancelPrint(id: string) {
    await window.paperweave.cancelPaperFinalize(id).catch(() => undefined);
    setPrintJob(null);
    setMessage("已取消定稿。");
  }
  async function beginFinalize() {
    if (!paper) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const result = await window.paperweave.beginPaperFinalize(paper.paper.id, { confirmAnswerGap });
      if (result.status === "canceled") return;
      if (result.status === "blocked") { setCheck(result.check); setMessage("定稿被阻断，请先处理下列问题。"); return; }
      setCheck(null);
      setPrintJob({ id: result.id, paper: result.student, phase: "student" });
    } catch (e) { setError(`无法开始定稿：${errorText(e)}`); }
    finally { setBusy(false); }
  }
  async function checkReady() {
    if (!paper) return;
    try { setCheck(await window.paperweave.checkPaperFinalize(paper.paper.id, { confirmAnswerGap })); }
    catch (e) { setError(`检查失败：${errorText(e)}`); }
  }

  if (printJob?.phase === "confirm") return <main className="paper-app">
    <section className="paper-confirm" role="dialog" aria-label="确认定稿">
      <h1>检查双卷预览</h1>
      <p>学生卷与教师答案卷已在系统程序中打开。确认页码、排版与答案无误后保存为定稿；取消不会产生定稿记录。</p>
      {error && <p role="alert" className="error">{error} <button onClick={() => setError("")}>关闭</button></p>}
      <button className="primary" onClick={() => void confirmFinalize(printJob.id)}>确认保存为定稿</button>
      <button onClick={() => void cancelPrint(printJob.id)}>取消并丢弃</button>
    </section>
  </main>;
  if (printJob) return <PaperPrintView paper={printJob.paper} onReady={() => void printReady()} onCancel={() => void cancelPrint(printJob.id)} />;

  const confirmSource = confirmAdd && detail?.versionId === confirmAdd.versionId ? detail : null;
  const confirmPrimary = confirmAdd?.subQuestionId ?? null;
  const confirmAppended = confirmAdd && confirmPrimary ? confirmAdd.selection.subQuestionIds.filter((id) => id !== confirmPrimary) : [];

  return <main className="paper-app">
    <header className="paper-top">
      <div><h1>题库与组卷</h1><p>检索选题 → 题篮 → 组卷 → 双卷定稿</p></div>
      <button onClick={onBack}>返回录题草稿</button>
    </header>
    {message && <p role="status" className="paper-message">{message}</p>}
    {error && <p role="alert" className="error">{error} <button onClick={() => setError("")}>关闭</button></p>}
    {confirmAdd && <section className="paper-confirm" role="dialog" aria-label="依赖确认">
      <h2>加入题篮需要确认依赖</h2>
      <p><strong>本项：</strong>{confirmSubText(confirmSource, confirmPrimary ?? "")}</p>
      <p><strong>追加小问：</strong>{confirmAppended.length > 0 ? confirmAppended.map((id) => confirmSubText(confirmSource, id)).join("；") : "无（仅本项）"}</p>
      <p><strong>依赖材料：</strong>{confirmAdd.selection.materialIds.length > 0 ? confirmAdd.selection.materialIds.map((id) => confirmMaterialText(confirmSource, id)).join("、") : "无"}</p>
      <p><strong>依赖原因：</strong></p>
      <ul>{confirmAdd.selection.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
      <p className="muted">确认后只加入以上范围，不会额外扩大选择。</p>
      <button className="primary" onClick={() => void addToBasket(confirmAdd.questionId, confirmAdd.versionId, confirmAdd.subQuestionId, true)}>确认加入</button>
      <button onClick={() => setConfirmAdd(null)}>取消</button>
    </section>}

    <section className="paper-panel" aria-label="题库检索">
      <h2>题库检索</h2>
      <div className="paper-grid">
        <label>学段<select value={filter.stage} onChange={(e) => setFilter({ ...filter, stage: e.target.value as Stage | "" })}><option value="">全部</option>{stages.map((stage) => <option key={stage}>{stage}</option>)}</select></label>
        <label>学科<input value={filter.subject} onChange={(e) => setFilter({ ...filter, subject: e.target.value })} /></label>
        <label>年级<input value={filter.grade} onChange={(e) => setFilter({ ...filter, grade: e.target.value })} /></label>
        <label>考试类型<input value={filter.examType} onChange={(e) => setFilter({ ...filter, examType: e.target.value })} /></label>
        <label>学年<input value={filter.year} onChange={(e) => setFilter({ ...filter, year: e.target.value })} /></label>
        <label>来源<input value={filter.sourceName} onChange={(e) => setFilter({ ...filter, sourceName: e.target.value })} /></label>
        <label>题型<input value={filter.questionType} onChange={(e) => setFilter({ ...filter, questionType: e.target.value })} /></label>
        <label>知识点<input value={filter.knowledgePoint} onChange={(e) => setFilter({ ...filter, knowledgePoint: e.target.value })} /></label>
        <label>内容状态<select value={filter.contentStatus} onChange={(e) => setFilter({ ...filter, contentStatus: e.target.value as ReviewStatus | "" })}><option value="">全部</option>{contentStatuses.map((entry) => <option key={entry.value} value={entry.value}>{entry.label}</option>)}</select></label>
        <label>答案状态<select value={filter.answerStatus} onChange={(e) => setFilter({ ...filter, answerStatus: e.target.value as AnswerStatus | "" })}><option value="">全部</option>{answerStatuses.map((entry) => <option key={entry.value} value={entry.value}>{entry.label}</option>)}</select></label>
        <label>关键词<input value={filter.keyword} onChange={(e) => setFilter({ ...filter, keyword: e.target.value })} /></label>
      </div>
      <button onClick={() => void search()} disabled={busy}>检索</button>
      <ul className="paper-list">
        {results.map((result) => <li key={result.versionId} className="paper-card">
          <div><strong>{result.preview || "（无题干预览）"}</strong><p className="muted">{result.source.section} · 原卷第 {result.source.pdfPage} 页 · 题 {result.source.originalNumber} · {result.classification?.subject ?? "未分类"} {result.classification?.grade ?? ""}</p></div>
          <div className="paper-actions">
            <button onClick={() => void addToBasket(result.questionId, result.versionId, null)}>整题入篮</button>
            <button onClick={() => void openDetail(result.versionId)}>查看小问/答案</button>
          </div>
        </li>)}
        {results.length === 0 && <li className="muted">没有检索结果。</li>}
      </ul>
      {detail && <section className="paper-detail" aria-label="题目详情">
        <header><h3>题目详情</h3><button onClick={() => setDetail(null)}>关闭</button></header>
        <p className="muted">{detail.classification?.subject} · {detail.classification?.grade} · 题库第 {detail.version} 版</p>
        {detail.content.stem.length > 0 && <p><strong>题组指令：</strong>{blockText(detail.content.stem)}</p>}
        {detail.materials.map((material) => <p key={material.versionId}><strong>{material.title}：</strong>{blockText(material.content as QuestionBlock[])}</p>)}
        <ul>{detail.content.subQuestions.map((sub) => {
          const selection = basketSelection(detail.content, sub.id);
          return <li key={sub.id}>
            <p><strong>{sub.originalLabel || sub.id}</strong> {blockText(sub.prompt)}　<span className="muted">原分值 {sub.originalScore ?? "未录入"}</span></p>
            <p className="muted">依赖提示：{dependencyLines(detail.content, detail.materials, sub.id).join("；")}</p>
            <p className="muted">入篮将带入：{selection.subQuestionIds.map((id) => subLabel(detail.content, id)).join("、")}{selection.materialIds.length > 0 ? `；材料：${selection.materialIds.map((id) => confirmMaterialText(detail, id)).join("、")}` : ""}</p>
            <button onClick={() => void addToBasket(detail.questionId, detail.versionId, sub.id)}>加入此小问</button>
            <details><summary>查看答案与评分</summary>
              {sub.answers.map((answer, index) => <p key={index}>答案：{blockText(answer.blocks)}</p>)}
              {sub.explanation.length > 0 && <p>解析：{blockText(sub.explanation)}</p>}
              {sub.scoring.length > 0 && <p>评分：{sub.scoring.map((point) => `${point.description} ${point.score} 分`).join("；")}</p>}
            </details>
          </li>;
        })}</ul>
        <p className="muted">完整题干：{questionText(detail)}</p>
      </section>}
    </section>

    <section className="paper-panel" aria-label="题篮">
      <header><h2>题篮</h2><button onClick={() => void window.paperweave.clearBasket().then(loadBasket).catch((e: unknown) => setError(`清空题篮失败：${errorText(e)}`))} disabled={basket.length === 0}>清空题篮</button></header>
      {basket.length === 0 ? <p className="muted">题篮为空。</p> : <ul className="paper-list">{basket.map((item) => <li key={item.id} className="paper-card">
        <div><strong>{basketText(item) || "（无题干）"}</strong><p className="muted">小问：{item.subQuestionIds.join("、")} · 依赖：{item.dependencies.reasons.join("；") || "无"}</p></div>
        <div className="paper-actions">
          <select aria-label="加入的小节" value={targets[item.id] ?? paper?.sections[0]?.id ?? ""} onChange={(e) => setTargets({ ...targets, [item.id]: e.target.value })}>
            {(paper?.sections ?? []).map((section) => <option key={section.id} value={section.id}>{section.title}</option>)}
          </select>
          <button onClick={() => void addItem(item.id)} disabled={!paper || paper.sections.length === 0}>加入试卷</button>
          <button onClick={() => void window.paperweave.removeBasketItem(item.id).then(loadBasket).catch((e: unknown) => setError(`移除题篮项失败：${errorText(e)}`))}>移除</button>
        </div>
      </li>)}</ul>}
    </section>

    <section className="paper-panel" aria-label="组卷">
      <header><h2>组卷</h2><div className="paper-actions">{papers.length > 1 && <select aria-label="选择试卷" value={paperId} onChange={(e) => { setPaperId(e.target.value); setCreating(false); }}>{papers.map((entry) => <option key={entry.id} value={entry.id}>{entry.title}</option>)}</select>}{paper && !creating && <button onClick={() => setCreating(true)}>新建试卷</button>}</div></header>
      {(!paper || creating) && <div className="paper-create">
        <h3>{paper ? "新建试卷" : "创建试卷"}</h3>
        <div className="paper-grid">
          <label>标题<input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></label>
          <label>学段<select value={form.stage} onChange={(e) => setForm({ ...form, stage: e.target.value as Stage })}>{stages.map((stage) => <option key={stage}>{stage}</option>)}</select></label>
          <label>学科<input value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} /></label>
          <label>年级<input value={form.grade} onChange={(e) => setForm({ ...form, grade: e.target.value })} /></label>
        </div>
        <button className="primary" onClick={() => void createPaper()} disabled={busy}>创建试卷</button>
        {paper && <button onClick={() => setCreating(false)}>取消新建</button>}
      </div>}
      {paper && <>
        <h3>{paper.paper.title}　<span className="paper-total">总分 {paper.totalScore} 分</span></h3>
        <p className="muted">{paper.paper.stage} · {paper.paper.subject} · {paper.paper.grade}</p>
        <div className="paper-inline"><input aria-label="新小节标题" value={sectionTitle} onChange={(e) => setSectionTitle(e.target.value)} /><button onClick={() => void addSection()}>添加小节</button></div>
        {paper.sections.map((section) => <section key={section.id} className="paper-section-edit" aria-label={section.title}>
          <header><h4>{section.title}</h4><button onClick={() => void mutate(() => window.paperweave.removePaperSection(section.id), "小节已删除。")} disabled={section.items.length > 0}>删除小节</button></header>
          {section.items.length === 0 && <p className="muted">此小节暂无题目。</p>}
          {section.items.map((item, index) => <article key={item.id} className="paper-item-edit">
            <header>
              <strong>第 {item.position} 题 · {item.content.subQuestions.filter((sub) => item.subQuestionIds.includes(sub.id)).map((sub) => sub.originalLabel || sub.id).join("、")}</strong>
              <span className={`paper-state paper-state-${item.scoringState}`}>{scoringLabels[item.scoringState]}</span>
            </header>
            <p>{blockText(item.content.stem)} {item.content.subQuestions.filter((sub) => item.subQuestionIds.includes(sub.id)).map((sub) => blockText(sub.prompt)).join("；")}</p>
            <div className="paper-inline">
              <label>卷内分值<input aria-label="卷内分值" type="number" min="0" step="0.5" value={scores[item.id] ?? item.score} onChange={(e) => setScores({ ...scores, [item.id]: e.target.value })} /></label>
              <button onClick={() => void setScore(item)}>改分</button>
              <label>留白<select aria-label="答题留白" value={item.blankSpace} onChange={(e) => void setBlankSpace(item, e.target.value as BlankSpace)}>{blankSpaces.map((entry) => <option key={entry.value} value={entry.value}>{entry.label}</option>)}</select></label>
              <button onClick={() => editScoring(item)}>编辑评分点</button>
              <button disabled={index === 0} onClick={() => void move(item, section.id, index)}>上移</button>
              <button disabled={index === section.items.length - 1} onClick={() => void move(item, section.id, index + 2)}>下移</button>
              <button onClick={() => void mutate(() => window.paperweave.removePaperItem(item.id), "题目已移除。")}>移除</button>
            </div>
            {scoringDrafts[item.id] && <div className="paper-scoring-edit" aria-label="卷内评分点编辑">
              <p>评分点合计 {draftTotal(scoringDrafts[item.id])} 分，卷内分值 {item.score} 分{draftTotal(scoringDrafts[item.id]) !== item.score ? "，不一致时不可定稿。" : "。"}</p>
              {scoringDrafts[item.id].map((point, pointIndex) => <div key={point.id} className="paper-inline">
                <input aria-label={`评分点 ${pointIndex + 1} 说明`} value={point.description} onChange={(e) => patchDraftPoint(item, pointIndex, { description: e.target.value })} />
                <input aria-label={`评分点 ${pointIndex + 1} 分值`} type="number" min="0" step="0.5" value={point.score} onChange={(e) => patchDraftPoint(item, pointIndex, { score: e.target.value })} />
                <button onClick={() => removeDraftPoint(item, pointIndex)}>删除评分点</button>
              </div>)}
              {scoringDrafts[item.id].length === 0 && <p className="muted">暂无评分点，请添加。</p>}
              <div className="paper-inline">
                <button onClick={() => addDraftPoint(item)}>添加评分点</button>
                <button className="primary" onClick={() => void saveScoring(item)}>保存评分点</button>
                <button onClick={() => closeScoring(item)}>收起</button>
              </div>
            </div>}
            {item.scoringState === "needsAdjustment" && <div className="paper-adjust">
              <p role="alert">原评分不适用于当前分值，待调整。</p>
              <button onClick={() => void setScoring(item, { mode: "answerOnly", note: "评分标准待补" })}>仅输出参考答案</button>
              <button onClick={() => void mutate(() => window.paperweave.setPaperItemScore(item.id, item.defaultScore), "已恢复默认分值。")}>恢复默认分 {item.defaultScore} 分</button>
            </div>}
            {item.scoreConflicts.map((conflict) => <p key={conflict.key} className="paper-conflict">
              卷内文字中仍有「{conflict.text}」（原分值 {conflict.value} 分）{conflict.confirmed ? "，已确认。" : <> <button onClick={() => void confirmConflict(item, conflict.key)}>确认保留</button></>}
            </p>)}
            {paper.sections.length > 1 && <div className="paper-inline">
              <label>移动到<select aria-label="目标小节" value={targets[item.id] ?? section.id} onChange={(e) => setTargets({ ...targets, [item.id]: e.target.value })}>{paper.sections.map((entry) => <option key={entry.id} value={entry.id}>{entry.title}</option>)}</select></label>
              <button onClick={() => void move(item, targets[item.id] ?? section.id, 1)} disabled={(targets[item.id] ?? section.id) === section.id}>移入本节首位</button>
            </div>}
          </article>)}
        </section>)}
        <section className="paper-finalize" aria-label="定稿">
          <h3>定稿</h3>
          <label className="paper-inline">
            <input
              type="checkbox"
              aria-label="确认答案或评分待补出卷"
              checked={confirmAnswerGap}
              disabled={busy}
              onChange={(event) => { setConfirmAnswerGap(event.target.checked); setCheck(null); }}
            />
            答案或评分待补的题已核对，确认出卷（教师卷会标注）
          </label>
          <button onClick={() => void checkReady()}>检查定稿</button>
          <button className="primary" onClick={() => void beginFinalize()} disabled={busy}>生成学生卷与教师答案卷</button>
          {check && <div className={check.ready ? "paper-ok" : "paper-blockers"}>
            <p>{check.ready ? "定稿检查通过。" : "尚未满足定稿条件："}</p>
            {check.blockers.length > 0 && <ul>{check.blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul>}
            {check.notices.length > 0 && <ul>{check.notices.map((notice) => <li key={notice}>{notice}</li>)}</ul>}
          </div>}
          <h4>历史定稿</h4>
          {finalizations.length === 0 ? <p className="muted">暂无定稿记录。</p> : <ul className="paper-list">{finalizations.map((record) => <li key={record.id} className="paper-card">
            <div><strong>{new Date(record.createdAt).toLocaleString()}</strong><p className="muted">学生卷与教师答案卷已冻结</p></div>
            <button onClick={() => void window.paperweave.reprintPaper(record.id).then((result) => setMessage(result.openErrors.filter(Boolean).length ? "定稿已存在，但有文件无法自动打开。" : "已打开原定稿 PDF。")).catch((e: unknown) => setError(`重印失败：${errorText(e)}`))}>重印</button>
          </li>)}</ul>}
        </section>
      </>}
    </section>
  </main>;
}
