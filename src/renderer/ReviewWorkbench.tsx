import { useEffect, useState } from "react";
import katex from "katex";
import { answerPresent } from "../shared/intake";
import type { Block, TextStyle } from "../shared/document";
import type {
  MaterialView,
  QuestionDetailView,
  QuestionSearchView,
} from "../shared/paper-api";
import { contentReviewProblems } from "../shared/review";
import type {
  AnswerStatus,
  Classification,
  QuestionBlock,
  ReviewStatus,
  SubQuestionImpact,
} from "../shared/question";

const contentLabels: Record<ReviewStatus, string> = { draft: "内容草稿", pending: "内容待核", approved: "内容已审核" };
const answerLabels: Record<AnswerStatus, string> = { missing: "答案待补", pending: "答案待核", approved: "答案已审核" };
const materialLabels: Record<ReviewStatus, string> = { draft: "材料草稿", pending: "材料待核", approved: "材料已审核" };
const stages = ["小学", "初中", "高中"] as const;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface AffectedUsage {
  questionId: string;
  versionId: string;
  version: number;
  materialVersion: number;
  latestVersionId: string;
  latestVersion: number;
  impacts: SubQuestionImpact[];
  source: QuestionDetailView["content"]["source"];
  content: QuestionDetailView["content"];
}

function materialText(blocks: Block[]): string | null {
  const lines: string[] = [];
  for (const block of blocks) {
    if (block.type !== "paragraph") return null;
    if (block.runs.some((run) => run.type !== "text")) return null;
    lines.push(block.runs.map((run) => run.type === "text" ? run.text : "").join(""));
  }
  return lines.join("\n");
}

function Formula({ latex, display = false }: { latex: string; display?: boolean }) {
  try {
    return <span dangerouslySetInnerHTML={{ __html: katex.renderToString(latex, { displayMode: display, throwOnError: true, trust: false, strict: "error" }) }} />;
  } catch {
    return <span role="alert">公式无法渲染：{latex}</span>;
  }
}

function StyledText({ text, style }: { text: string; style: TextStyle }) {
  if (style === "粗体") return <strong>{text}</strong>;
  if (style === "斜体") return <em>{text}</em>;
  if (style === "下划线") return <u>{text}</u>;
  if (style === "上标") return <sup>{text}</sup>;
  if (style === "下标") return <sub>{text}</sub>;
  return <>{text}</>;
}

function AttachmentImage({ id, alt }: { id: string; alt: string }) {
  const [url, setUrl] = useState("");
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    setUrl("");
    setFailed(false);
    window.paperweave.getImage(id).then((value) => { if (live) setUrl(value); }).catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [id]);
  if (failed) return <span role="alert">题图无法读取（{alt || id.slice(0, 8)}），请核对附件。</span>;
  return url ? <img src={url} alt={alt || "题图"} /> : <span className="muted">正在读取题图…</span>;
}

function Blocks({ blocks }: { blocks: QuestionBlock[] }) {
  if (blocks.length === 0) return <span className="muted">（空）</span>;
  return <div className="review-blocks">{blocks.map((block, index) => {
    if (block.type === "paragraph") return <p key={index}>{block.runs.map((run, runIndex) => {
      if (run.type === "text") return <StyledText key={runIndex} text={run.text} style={run.style} />;
      if (run.type === "formula") return <Formula key={runIndex} latex={run.latex} />;
      return <span key={runIndex} className="muted">［引用：{run.fallback}］</span>;
    })}</p>;
    if (block.type === "formula") return <p key={index}><Formula latex={block.latex} display /></p>;
    if (block.type === "image") return <p key={index}><AttachmentImage id={block.id} alt={block.alt} /></p>;
    return <div className="table-scroll" key={index}><table><tbody>{block.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex}>{cell}</td>)}</tr>)}</tbody></table></div>;
  })}</div>;
}

function emptyClassification(): Classification {
  return { stage: "初中", subject: "", grade: "", examType: "", year: "", sourceName: "", questionType: "", knowledgePoints: [] };
}

function classificationText(classification: Classification | undefined): string {
  if (classification === undefined) return "未分类";
  return [
    classification.stage,
    classification.subject,
    classification.grade,
    classification.examType,
    classification.year,
    classification.sourceName,
    classification.questionType,
    ...classification.knowledgePoints,
  ].filter(Boolean).join(" · ");
}

export default function ReviewWorkbench({ onBack, onOpenPaper }: { onBack: () => void; onOpenPaper: () => void }) {
  const [rows, setRows] = useState<QuestionSearchView[]>([]);
  const [filter, setFilter] = useState<"all" | "content" | "answer">("all");
  const [keyword, setKeyword] = useState("");
  const [detail, setDetail] = useState<QuestionDetailView | null>(null);
  const [classification, setClassification] = useState<Classification>(emptyClassification());
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function loadRows() {
    try {
      const [contentPending, answerPending] = await Promise.all([
        window.paperweave.searchQuestions({ contentStatus: "pending", limit: 200 }),
        window.paperweave.searchQuestions({ answerStatus: "pending", limit: 200 }),
      ]);
      const merged = new Map<string, QuestionSearchView>();
      for (const row of [...contentPending, ...answerPending]) merged.set(row.versionId, row);
      setRows([...merged.values()]);
    } catch (e) { setError(`读取待核题目失败：${errorText(e)}`); }
  }
  useEffect(() => { void loadRows(); }, []);

  async function openDetail(versionId: string) {
    setBusy(true); setError(""); setMessage("");
    try {
      const next = await window.paperweave.getQuestionDetail(versionId);
      setDetail(next);
      setClassification(next.classification ?? emptyClassification());
    } catch (e) { setError(`读取题目失败：${errorText(e)}`); }
    finally { setBusy(false); }
  }

  async function refreshDetail(versionId: string) {
    const next = await window.paperweave.getQuestionDetail(versionId);
    setDetail(next);
    setClassification(next.classification ?? emptyClassification());
    await loadRows();
  }

  async function run(action: () => Promise<unknown>, success: string) {
    setBusy(true); setError(""); setMessage("");
    try {
      await action();
      if (detail) await refreshDetail(detail.versionId);
      setMessage(success);
    } catch (e) { setError(errorText(e)); }
    finally { setBusy(false); }
  }

  async function saveClassification() {
    if (!detail) return;
    const cleaned: Classification = {
      ...classification,
      stage: classification.stage,
      subject: classification.subject.trim(),
      grade: classification.grade.trim(),
      examType: classification.examType.trim(),
      year: classification.year.trim(),
      sourceName: classification.sourceName.trim(),
      questionType: classification.questionType.trim(),
      knowledgePoints: [...new Set(classification.knowledgePoints.map((point) => point.trim()).filter(Boolean))],
    };
    await run(() => window.paperweave.setQuestionClassification(detail.questionId, cleaned), "分类标签已保存。");
  }

  const problems = detail === null ? [] : contentReviewProblems({ content: detail.content, classification: detail.classification, materials: detail.materials });
  const visible = rows.filter((row) => {
    if (filter === "content" && row.contentStatus !== "pending") return false;
    if (filter === "answer" && row.answerStatus !== "pending") return false;
    if (!keyword.trim()) return true;
    const haystack = [row.preview, classificationText(row.classification)].join(" ");
    return haystack.includes(keyword.trim());
  });

  return <main className="paper-app review-app">
    <header className="paper-top">
      <div><h1>题目审核</h1><p>对照原卷核对题意、题图、公式与标签，逐项通过后入库。</p></div>
      <div className="paper-actions"><button onClick={onOpenPaper}>去题库与组卷</button><button onClick={onBack}>返回录题草稿</button></div>
    </header>
    {message && <p role="status" className="paper-message">{message}</p>}
    {error && <p role="alert" className="error">{error} <button onClick={() => setError("")}>关闭</button></p>}

    <section className="paper-panel" aria-label="待核题目">
      <header><h2>待核题目</h2><span className="muted">共 {visible.length} 题</span></header>
      <div className="paper-inline">
        <div role="tablist" aria-label="待核筛选" className="paper-actions">
          <button role="tab" aria-selected={filter === "all"} className={filter === "all" ? "primary" : ""} onClick={() => setFilter("all")}>全部待核</button>
          <button role="tab" aria-selected={filter === "content"} className={filter === "content" ? "primary" : ""} onClick={() => setFilter("content")}>内容待核</button>
          <button role="tab" aria-selected={filter === "answer"} className={filter === "answer" ? "primary" : ""} onClick={() => setFilter("answer")}>答案待核</button>
        </div>
        <label>关键词<input aria-label="审核关键词" value={keyword} onChange={(event) => setKeyword(event.target.value)} /></label>
        <button onClick={() => void loadRows()} disabled={busy}>刷新</button>
      </div>
      {visible.length === 0 ? <p className="muted">没有待核题目。</p> : <ul className="paper-list">
        {visible.map((row) => <li key={row.versionId} className="paper-card">
          <div>
            <strong>{row.preview || "（无题干预览）"}</strong>
            <p className="muted">{row.source.section} · 原卷第 {row.source.pdfPage} 页 · 题 {row.source.originalNumber}</p>
            <p className="muted">{classificationText(row.classification) || "未分类"}</p>
          </div>
          <div className="paper-actions">
            <span className={`paper-state ${row.contentStatus === "approved" ? "paper-state-original" : ""}`}>{contentLabels[row.contentStatus]}</span>
            <span className={`paper-state ${row.answerStatus === "approved" ? "paper-state-original" : ""}`}>{answerLabels[row.answerStatus]}</span>
            <button onClick={() => void openDetail(row.versionId)} disabled={busy}>查看并审核</button>
          </div>
        </li>)}
      </ul>}
    </section>

    {detail && <section className="paper-panel paper-detail" aria-label="题目审核详情">
      <header>
        <h2>审核详情</h2>
        <div className="paper-actions">
          <span className="paper-state">{contentLabels[detail.contentStatus]}</span>
          <span className="paper-state">{answerLabels[detail.answerStatus]}</span>
          <button onClick={() => setDetail(null)}>关闭</button>
        </div>
      </header>
      <p className="muted">题库第 {detail.version} 版 · {detail.content.source.section} · 原卷第 {detail.content.source.pdfPage} 页 · 题 {detail.content.source.originalNumber}</p>

      <section aria-label="分类标签">
        <h3>分类标签</h3>
        <p className="muted">当前：{classificationText(detail.classification)}</p>
        <div className="paper-grid">
          <label>学段<select aria-label="审核学段" value={classification.stage} onChange={(event) => setClassification({ ...classification, stage: event.target.value as Classification["stage"] })}>{stages.map((stage) => <option key={stage}>{stage}</option>)}</select></label>
          <label>学科<input aria-label="审核学科" value={classification.subject} onChange={(event) => setClassification({ ...classification, subject: event.target.value })} /></label>
          <label>年级<input aria-label="审核年级" value={classification.grade} onChange={(event) => setClassification({ ...classification, grade: event.target.value })} /></label>
          <label>考试类型<input aria-label="审核考试类型" value={classification.examType} onChange={(event) => setClassification({ ...classification, examType: event.target.value })} /></label>
          <label>年份<input aria-label="审核年份" value={classification.year} onChange={(event) => setClassification({ ...classification, year: event.target.value })} /></label>
          <label>来源<input aria-label="审核来源" value={classification.sourceName} onChange={(event) => setClassification({ ...classification, sourceName: event.target.value })} /></label>
          <label>题型<input aria-label="审核题型" value={classification.questionType} onChange={(event) => setClassification({ ...classification, questionType: event.target.value })} /></label>
          <label>知识点（逗号分隔）<input aria-label="审核知识点" value={classification.knowledgePoints.join("，")} onChange={(event) => setClassification({ ...classification, knowledgePoints: event.target.value.split(/[,，、]/) })} /></label>
        </div>
        <button onClick={() => void saveClassification()} disabled={busy}>保存分类标签</button>
      </section>

      {detail.content.stem.length > 0 && <section aria-label="题组指令"><h3>题组指令</h3><Blocks blocks={detail.content.stem} /></section>}

      <section aria-label="题目材料">
        <h3>材料</h3>
        {detail.content.materials.length === 0 && <p className="muted">本题无共享材料。</p>}
        {detail.content.materials.map((ref) => {
          const material = detail.materials.find((entry) => entry.versionId === ref.versionId);
          if (material === undefined) return <p key={ref.versionId} role="alert">材料「{ref.materialId}」缺失</p>;
          return <MaterialReview
            key={ref.versionId}
            material={material}
            busy={busy}
            onAdvance={(status) => void run(() => window.paperweave.setMaterialStatus(material.versionId, status), status === "approved" ? "材料已通过审核。" : "材料已提交待核。")}
            onSaved={(savedMessage) => { setMessage(savedMessage); void loadRows(); }}
            onAdopted={async (questionId, versionId, adoptedMessage) => {
              setMessage(adoptedMessage);
              await loadRows();
              if (detail?.questionId === questionId) await refreshDetail(versionId);
            }}
          />;
        })}
      </section>

      <section aria-label="题目内容">
        <h3>小问</h3>
        {detail.content.subQuestions.map((sub) => <article key={sub.id} className="review-sub">
          <header><strong>{sub.originalLabel || sub.id}</strong><span className="muted">原分值 {sub.originalScore ?? "未录入"}</span></header>
          <Blocks blocks={sub.prompt} />
          {sub.options.length > 0 && <ol className="paper-options">{sub.options.map((option) => <li key={option.label}><span>{option.label}. </span><Blocks blocks={option.content} /></li>)}</ol>}
          <details><summary>答案、解析与评分</summary>
            {sub.answers.length === 0 ? <p className="muted">尚无答案。</p> : sub.answers.map((answer, index) => <div key={index}><h4>答案 {index + 1}</h4><Blocks blocks={answer.blocks} /></div>)}
            {sub.explanation.length > 0 && <><h4>解析</h4><Blocks blocks={sub.explanation} /></>}
            {sub.scoring.length > 0 && <><h4>评分点</h4><ul>{sub.scoring.map((point) => <li key={point.id}>{point.description}：{point.score} 分</li>)}</ul></>}
          </details>
        </article>)}
      </section>

      <section aria-label="审核操作" className="review-actions">
        <h3>审核</h3>
        {detail.contentStatus === "draft" && <button onClick={() => void run(() => window.paperweave.setQuestionContentStatus(detail.versionId, "pending"), "内容已提交待核。")} disabled={busy}>提交内容待核</button>}
        {detail.contentStatus === "pending" && <>
          {problems.length > 0 && <ul className="review-problems">{problems.map((problem) => <li key={problem}>{problem}</li>)}</ul>}
          <button className="primary" onClick={() => void run(() => window.paperweave.setQuestionContentStatus(detail.versionId, "approved"), "内容已通过审核。")} disabled={busy || problems.length > 0}>通过内容审核</button>
        </>}
        {detail.contentStatus === "approved" && <p className="muted">内容已审核。</p>}
        {detail.answerStatus === "approved" && <p className="muted">答案与评分已审核。</p>}
        {detail.answerStatus === "pending" && <button className="primary" onClick={() => void run(() => window.paperweave.setQuestionAnswerStatus(detail.versionId, "approved"), "答案与评分已通过审核。")} disabled={busy}>通过答案审核</button>}
        {detail.answerStatus === "missing" && <p className="muted">{answerPresent(detail.content) ? "检测到答案内容，可先标记为答案待核。" : "答案或评分待补；出卷时需教师确认，教师版会标注待补。"}</p>}
        {detail.answerStatus === "missing" && answerPresent(detail.content) && <button onClick={() => void run(() => window.paperweave.setQuestionAnswerStatus(detail.versionId, "pending"), "答案已提交待核。")} disabled={busy}>标记答案待核</button>}
      </section>
    </section>}
  </main>;
}

function MaterialReview({ material, busy, onAdvance, onSaved, onAdopted }: {
  material: MaterialView;
  busy: boolean;
  onAdvance: (status: ReviewStatus) => void;
  onSaved: (message: string) => void;
  onAdopted: (questionId: string, versionId: string, message: string) => Promise<void>;
}) {
  const editableText = materialText(material.content);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ title: material.title, source: material.source, content: editableText ?? "" });
  const [affected, setAffected] = useState<AffectedUsage[] | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");

  async function loadAffected() {
    setWorking(true); setError("");
    try {
      const usages = await window.paperweave.questionsAffectedByMaterial(material.materialId);
      const rows = await Promise.all(usages.map(async (usage) => {
        const detail = await window.paperweave.getQuestionDetail(usage.versionId);
        return { ...usage, source: detail.content.source, content: detail.content };
      }));
      setAffected(rows);
    } catch (e) { setError(`读取受影响题失败：${errorText(e)}`); }
    finally { setWorking(false); }
  }

  async function saveVersion() {
    if (!draft.title.trim()) { setError("材料标题不能为空。"); return; }
    setWorking(true); setError("");
    try {
      const content: Block[] = editableText === null
        ? material.content
        : draft.content.split("\n").map((line) => ({ type: "paragraph", runs: [{ type: "text", text: line, style: "普通" as const }] }));
      const saved = await window.paperweave.saveMaterialVersion(material.materialId, { title: draft.title.trim(), content, source: draft.source.trim() });
      setEditing(false);
      onSaved(`材料第 ${saved.version} 版已保存；引用旧版的题目需逐题采用新版。`);
      await loadAffected();
    } catch (e) { setError(`保存材料改版失败：${errorText(e)}`); }
    finally { setWorking(false); }
  }

  async function adopt(usage: AffectedUsage) {
    setWorking(true); setError("");
    try {
      const saved = await window.paperweave.adoptMaterialVersion(usage.questionId, material.materialId, usage.latestVersionId);
      await onAdopted(usage.questionId, saved.id, `已采用材料第 ${usage.latestVersion} 版；题目第 ${saved.version} 版回到待核。`);
      await loadAffected();
    } catch (e) { setError(`采用材料新版失败：${errorText(e)}`); }
    finally { setWorking(false); }
  }

  return <article className="review-material">
    <header>
      <strong>{material.title}</strong>
      <span className="paper-state">{materialLabels[material.status]}</span>
      <button onClick={() => { setEditing(!editing); setError(""); }} disabled={busy || working}>编辑材料</button>
      <button onClick={() => void loadAffected()} disabled={busy || working}>查看受影响题</button>
    </header>
    {material.source && <p className="muted">出处：{material.source}</p>}
    <Blocks blocks={material.content} />
    {error && <p role="alert" className="error">{error}</p>}
    {editing && <div className="paper-grid">
      <label>材料标题<input aria-label="材料标题" value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} /></label>
      <label>出处<input aria-label="材料出处" value={draft.source} onChange={(event) => setDraft({ ...draft, source: event.target.value })} /></label>
      {editableText === null
        ? <p className="muted">正文含公式或图片，改版时保留原正文，只更新标题与出处。</p>
        : <label>正文<textarea aria-label="材料正文" value={draft.content} onChange={(event) => setDraft({ ...draft, content: event.target.value })} /></label>}
      <div className="paper-inline">
        <button className="primary" onClick={() => void saveVersion()} disabled={working || busy}>保存为新版本</button>
        <button onClick={() => setEditing(false)} disabled={working}>取消编辑</button>
      </div>
    </div>}
    {affected !== null && <div className="review-affected">
      <h4>仍引用旧版的题目</h4>
      {affected === null ? null : affected.length === 0 ? <p className="muted">没有题目仍引用旧版材料。</p> : <ul>
        {affected.map((usage) => {
          const label = (id: string) => usage.content.subQuestions.find((sub) => sub.id === id)?.originalLabel || id;
          const direct = usage.impacts.filter((impact) => impact.direct);
          const indirect = usage.impacts.filter((impact) => !impact.direct);
          return <li key={usage.questionId}>
            <span>原卷第 {usage.source.pdfPage} 页 题 {usage.source.originalNumber} · 题目第 {usage.version} 版 · 材料第 {usage.materialVersion} 版</span>
            <p className="muted">直接受影响：{direct.length > 0 ? direct.map((impact) => label(impact.subQuestionId)).join("、") : "无"}</p>
            <p className="muted">间接受影响：{indirect.length > 0
              ? indirect.map((impact) => `${label(impact.subQuestionId)}（经由 ${impact.via.map(label).join("、")}）`).join("；")
              : "无"}</p>
            <button onClick={() => void adopt(usage)} disabled={working || busy}>采用新版（材料第 {usage.latestVersion} 版）</button>
          </li>;
        })}
      </ul>}
    </div>}
    {material.status === "draft" && <button onClick={() => onAdvance("pending")} disabled={busy}>提交材料待核</button>}
    {material.status === "pending" && <button className="primary" onClick={() => onAdvance("approved")} disabled={busy}>通过材料审核</button>}
  </article>;
}
