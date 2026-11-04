import { useEffect, useState } from "react";
import type { ExamDetailView, ExamFileRole, ExamInput, ExamRecord } from "../shared/exam";
import type { Stage } from "../shared/question";

const stages: Stage[] = ["小学", "初中", "高中"];
const roleLabels: Record<ExamFileRole, string> = { paper: "原卷", answer: "答案", rubric: "评分细则", answer_sheet: "答题卡" };
const attachRoles: ExamFileRole[] = ["answer", "rubric", "answer_sheet"];

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function ExamLibrary({ onBack, onOpenExam }: { onBack: () => void; onOpenExam: (examId: string) => void }) {
  const [exams, setExams] = useState<ExamRecord[]>([]);
  const [examId, setExamId] = useState("");
  const [detail, setDetail] = useState<ExamDetailView | null>(null);
  const [form, setForm] = useState<ExamInput>({ title: "", stage: "初中", subject: "数学", grade: "九年级", region: "", examType: "", year: "", sourceName: "" });
  const [sectionTitle, setSectionTitle] = useState("");
  const [sectionSubject, setSectionSubject] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function openExam(id: string) {
    try {
      setDetail(await window.paperweave.getExam(id));
      setExamId(id);
    } catch (e) {
      setError(`读取考试失败：${errorText(e)}`);
    }
  }

  async function loadExams(select?: string) {
    try {
      const list = await window.paperweave.listExams();
      setExams(list);
      const next = select ?? (examId && list.some((exam) => exam.id === examId) ? examId : list[0]?.id ?? "");
      if (next) await openExam(next);
      else { setExamId(""); setDetail(null); }
    } catch (e) {
      setError(`读取考试列表失败：${errorText(e)}`);
    }
  }

  useEffect(() => { void loadExams(); }, []);

  async function importExam() {
    setBusy(true); setError(""); setMessage("");
    try {
      const result = await window.paperweave.importExam(form);
      if (result.status === "canceled") return;
      setMessage(result.existing ? `该原卷已登记为「${result.exam.title}」，未重复导入。` : `已导入「${result.exam.title}」。`);
      await loadExams(result.exam.id);
    } catch (e) {
      setError(`导入原卷失败：${errorText(e)}`);
    } finally { setBusy(false); }
  }

  async function attach(role: ExamFileRole) {
    if (!examId) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const result = await window.paperweave.attachExamFile(examId, role);
      if (result.status === "canceled") return;
      setMessage(result.existing ? `该${roleLabels[role]}文件已挂接。` : `${roleLabels[role]}文件已挂接。`);
      await openExam(examId);
      await loadExams(examId);
    } catch (e) {
      setError(`挂接${roleLabels[role]}失败：${errorText(e)}`);
    } finally { setBusy(false); }
  }

  async function addSection() {
    if (!examId) return;
    setError(""); setMessage("");
    try {
      await window.paperweave.addExamSection(examId, sectionTitle, sectionSubject.trim() || undefined);
      setSectionTitle(""); setSectionSubject("");
      await openExam(examId);
      setMessage("分部已添加。");
    } catch (e) {
      setError(`添加分部失败：${errorText(e)}`);
    }
  }

  return <main className="paper-app">
    <header className="paper-top">
      <div><h1>考试原卷</h1><p>登记整卷 PDF、答案与评分细则；录题时从这里进入双栏工作台。</p></div>
      <button onClick={onBack}>返回录题草稿</button>
    </header>
    {message && <p role="status" className="paper-message">{message}</p>}
    {error && <p role="alert" className="error">{error} <button onClick={() => setError("")}>关闭</button></p>}

    <section className="paper-panel" aria-label="导入原卷">
      <h2>导入原卷 PDF</h2>
      <div className="paper-grid">
        <label>考试标题<input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></label>
        <label>学段<select value={form.stage} onChange={(e) => setForm({ ...form, stage: e.target.value as Stage })}>{stages.map((stage) => <option key={stage}>{stage}</option>)}</select></label>
        <label>学科<input value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} /></label>
        <label>年级<input value={form.grade} onChange={(e) => setForm({ ...form, grade: e.target.value })} /></label>
        <label>地区<input value={form.region} onChange={(e) => setForm({ ...form, region: e.target.value })} /></label>
        <label>题型<input value={form.examType} onChange={(e) => setForm({ ...form, examType: e.target.value })} /></label>
        <label>年份<input value={form.year} onChange={(e) => setForm({ ...form, year: e.target.value })} /></label>
        <label>来源<input value={form.sourceName} onChange={(e) => setForm({ ...form, sourceName: e.target.value })} /></label>
      </div>
      <p className="muted">同一 PDF 会按文件指纹去重；重复导入直接打开原考试。</p>
      <button className="primary" onClick={() => void importExam()} disabled={busy}>{busy ? "处理中…" : "选择 PDF 并导入"}</button>
    </section>

    <section className="paper-panel" aria-label="考试列表">
      <h2>考试列表</h2>
      {exams.length === 0 ? <p className="muted">还没有登记考试。先导入一份原卷 PDF。</p> : <ul className="paper-list">
        {exams.map((exam) => <li key={exam.id} className="paper-card">
          <div>
            <strong>{exam.title}</strong>
            <p className="muted">{exam.stage} · {exam.subject} · {exam.grade}{exam.region ? ` · ${exam.region}` : ""}{exam.year ? ` · ${exam.year}` : ""}</p>
          </div>
          <div className="paper-actions">
            <button onClick={() => void openExam(exam.id)} disabled={busy || exam.id === examId}>查看</button>
            <button onClick={() => onOpenExam(exam.id)} disabled={busy}>进入录题</button>
          </div>
        </li>)}
      </ul>}
    </section>

    {detail && <section className="paper-panel" aria-label="考试详情">
      <header><h2>{detail.exam.title}</h2><span className="paper-state">{detail.questionCount} 道题</span></header>
      <p className="muted">{detail.exam.stage} · {detail.exam.subject} · {detail.exam.grade} · {detail.exam.examType || "题型待补"} · {detail.exam.sourceName || "来源待补"}</p>

      <h3>原件</h3>
      <ul className="paper-list">
        {detail.files.map((file) => <li key={`${file.id}-${file.role}`} className="paper-card">
          <div><strong>{file.originalName}</strong><p className="muted">{Math.ceil(file.size / 1024)} KB · SHA-256 {file.sha256.slice(0, 12)}…</p></div>
          <span className="paper-state">{roleLabels[file.role]}</span>
        </li>)}
      </ul>
      <div className="paper-actions">
        {attachRoles.map((role) => <button key={role} onClick={() => void attach(role)} disabled={busy}>挂接{roleLabels[role]} PDF</button>)}
      </div>

      <h3>卷内分部</h3>
      <ol>{detail.sections.map((section) => <li key={section.id}>{section.title}{section.subject ? `（${section.subject}）` : ""}</li>)}</ol>
      <div className="paper-inline">
        <label>分部标题<input value={sectionTitle} onChange={(e) => setSectionTitle(e.target.value)} /></label>
        <label>分部学科<input value={sectionSubject} onChange={(e) => setSectionSubject(e.target.value)} placeholder="留空沿用考试学科" /></label>
        <button onClick={() => void addSection()} disabled={busy || !sectionTitle.trim()}>添加分部</button>
      </div>
    </section>}
  </main>;
}
