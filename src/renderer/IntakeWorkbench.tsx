import { useEffect, useState } from "react";
import katex from "katex";
import type { ExamDetailView, ExamQuestionSummary } from "../shared/exam";
import type { Block } from "../shared/document";
import { blankSubQuestion, buildContent, contentToForm, newIntakeForm, type IntakeBlock, type IntakeForm, type IntakeMaterial, type IntakeSubQuestion } from "../shared/intake";
import type { Classification, QuestionBlock, QuestionContent, ReviewStatus, Stage } from "../shared/question";
import BlockListEditor from "./BlockListEditor";
import ExamPdfPanel from "./ExamPdfPanel";

const stages: Stage[] = ["小学", "初中", "高中"];
const statusLabels: Record<ReviewStatus, string> = { draft: "草稿", pending: "待核", approved: "已审核" };
const materialLabels: Record<ReviewStatus, string> = { draft: "草稿", pending: "待核", approved: "已审核" };
const answerLabels: Record<"missing" | "pending" | "approved", string> = { missing: "待补", pending: "待核", approved: "已审核" };
const subFields = ["prompt", "answer", "explanation"] as const;
type SubField = typeof subFields[number];
type CropTarget = { field: "stem" } | { field: SubField; subKey: string };

const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);

function formulasOf(blocks: QuestionBlock[]): string[] {
  const result: string[] = [];
  for (const block of blocks) {
    if (block.type === "formula") result.push(block.latex);
    if (block.type === "paragraph") {
      for (const run of block.runs) if (run.type === "formula") result.push(run.latex);
    }
  }
  return result;
}

function formulaProblem(content: QuestionContent): string | null {
  const groups = [content.stem];
  for (const sub of content.subQuestions) {
    groups.push(sub.prompt, sub.explanation, ...sub.options.map((option) => option.content), ...sub.answers.map((answer) => answer.blocks));
  }
  for (const latex of groups.flatMap(formulasOf)) {
    try {
      katex.renderToString(latex, { displayMode: false, throwOnError: true, trust: false, strict: "error" });
    } catch {
      return `公式无法渲染：${latex}。请检查 LaTeX 写法。`;
    }
  }
  return null;
}

function parsePoints(text: string): string[] {
  return [...new Set(text.split(/[,，、]/).map((item) => item.trim()).filter(Boolean))];
}

export default function IntakeWorkbench({ examId, onBack }: { examId: string; onBack: () => void }) {
  const [exam, setExam] = useState<ExamDetailView | null>(null);
  const [questions, setQuestions] = useState<ExamQuestionSummary[]>([]);
  const [form, setForm] = useState<IntakeForm | null>(null);
  const [sectionId, setSectionId] = useState("");
  const [editing, setEditing] = useState<{ questionId: string; versionId: string; version: number } | null>(null);
  const [page, setPage] = useState(1);
  const [cropTarget, setCropTarget] = useState<CropTarget | null>(null);
  const [knowledgeText, setKnowledgeText] = useState("");
  const [materialForm, setMaterialForm] = useState({ title: "", content: "", source: "" });
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  function beginNew(detail: ExamDetailView) {
    const section = detail.sections[0];
    if (!section) {
      setError("这场考试还没有卷内分部，请先返回考试原卷页添加分部。");
      return;
    }
    const classification: Classification = {
      stage: detail.exam.stage,
      subject: detail.exam.subject,
      grade: detail.exam.grade,
      examType: detail.exam.examType,
      year: detail.exam.year,
      sourceName: detail.exam.sourceName,
      questionType: "",
      knowledgePoints: [],
    };
    setForm(newIntakeForm(classification, section.title));
    setSectionId(section.id);
    setEditing(null);
    setPage(1);
    setCropTarget(null);
    setKnowledgeText("");
    setMessage("新题录入。");
    setError("");
  }

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const [detail, list] = await Promise.all([window.paperweave.getExam(examId), window.paperweave.listExamQuestions(examId)]);
        if (!live) return;
        setExam(detail);
        setQuestions(list);
        beginNew(detail);
      } catch (e) {
        if (live) setError(`读取考试失败：${errorText(e)}`);
      }
    })();
    return () => { live = false; };
  }, [examId]);

  async function loadQuestion(summary: ExamQuestionSummary) {
    setBusy(true); setError(""); setMessage("");
    try {
      const detail = await window.paperweave.getQuestionDetail(summary.versionId);
      const converted = contentToForm(detail.content, detail.classification, detail.materials);
      if (!converted.form) { setError(converted.problem ?? "无法打开该题。"); return; }
      setForm(converted.form);
      setKnowledgeText(converted.form.classification.knowledgePoints.join("，"));
      setEditing({ questionId: detail.questionId, versionId: detail.versionId, version: detail.version });
      const matched = summary.sectionId ?? exam?.sections.find((section) => section.title === detail.content.source.section)?.id ?? exam?.sections[0]?.id ?? "";
      setSectionId(matched);
      setPage(detail.content.source.pdfPage);
      setCropTarget(null);
      setMessage(`已打开题目（版本 ${detail.version}）。`);
    } catch (e) {
      setError(`读取题目失败：${errorText(e)}`);
    } finally { setBusy(false); }
  }

  const updateSub = (key: string, patch: Partial<IntakeSubQuestion>) => {
    setForm((current) => current && ({ ...current, subQuestions: current.subQuestions.map((sub) => sub.key === key ? { ...sub, ...patch } : sub) }));
  };
  const setSubBlocks = (key: string, field: SubField, blocks: IntakeBlock[]) => {
    setForm((current) => current && ({ ...current, subQuestions: current.subQuestions.map((sub) => sub.key === key ? { ...sub, [field]: blocks } : sub) }));
  };

  function addSub() {
    setForm((current) => {
      if (!current) return current;
      const sub = blankSubQuestion();
      sub.originalLabel = `(${current.subQuestions.length + 1})`;
      sub.materialIds = current.materials.map((material) => material.materialId);
      return { ...current, subQuestions: [...current.subQuestions, sub] };
    });
  }

  function removeSub(key: string) {
    setForm((current) => {
      if (!current || current.subQuestions.length <= 1) return current;
      const remaining = current.subQuestions.filter((sub) => sub.key !== key);
      const ids = new Set(remaining.map((sub) => sub.id));
      return {
        ...current,
        subQuestions: remaining.map((sub) => ({ ...sub, dependsOn: sub.dependsOn.filter((id) => ids.has(id)) })),
        selection: current.selection.mode === "choose"
          ? { ...current.selection, candidates: current.selection.candidates.filter((id) => ids.has(id)), required: Math.max(1, Math.min(current.selection.required, current.selection.candidates.filter((id) => ids.has(id)).length)) }
          : current.selection,
      };
    });
  }

  function requestCrop(target: CropTarget) {
    setCropTarget(target);
    setMessage("请在左栏原卷页面上拖选区域。");
    setError("");
  }

  async function insertCrop(dataUrl: string) {
    const target = cropTarget;
    if (!target) return;
    setBusy(true);
    try {
      const saved = await window.paperweave.saveIntakeFigure(dataUrl);
      const block: IntakeBlock = { kind: "image", id: saved.id, alt: `第 ${page} 页裁图` };
      setForm((current) => {
        if (!current) return current;
        if (target.field === "stem") return { ...current, stem: [...current.stem, block] };
        return {
          ...current,
          subQuestions: current.subQuestions.map((sub) => sub.key === target.subKey ? { ...sub, [target.field]: [...sub[target.field], block] } : sub),
        };
      });
      setCropTarget(null);
      setMessage("裁图已插入当前编辑目标。");
    } catch (e) {
      setError(`裁图保存失败：${errorText(e)}`);
    } finally { setBusy(false); }
  }

  async function addMaterial() {
    if (!form) return;
    if (!materialForm.title.trim() || !materialForm.content.trim()) { setError("材料标题与内容都不能为空。"); return; }
    setBusy(true); setError("");
    try {
      const content: Block[] = [{ type: "paragraph", runs: [{ type: "text", text: materialForm.content, style: "普通" }] }];
      const created = await window.paperweave.createMaterial({ title: materialForm.title.trim(), content, source: materialForm.source.trim() });
      setForm((current) => current && ({
        ...current,
        materials: [...current.materials, { materialId: created.materialId, versionId: created.id, title: created.title, status: created.status }],
        subQuestions: current.subQuestions.map((sub) => ({ ...sub, materialIds: [...new Set([...sub.materialIds, created.materialId])] })),
      }));
      setMaterialForm({ title: "", content: "", source: "" });
      setMessage("材料草稿已建立，并关联到本组小问。");
    } catch (e) {
      setError(`建立材料失败：${errorText(e)}`);
    } finally { setBusy(false); }
  }

  async function advanceMaterial(material: IntakeMaterial) {
    if (material.status !== "draft" && material.status !== "pending") return;
    const next: ReviewStatus = material.status === "draft" ? "pending" : "approved";
    setBusy(true); setError("");
    try {
      await window.paperweave.setMaterialStatus(material.versionId, next);
      setForm((current) => current && ({ ...current, materials: current.materials.map((entry) => entry.versionId === material.versionId ? { ...entry, status: next } : entry) }));
      setMessage(next === "pending" ? "材料已提交待核。" : "材料已审核通过。");
    } catch (e) {
      setError(`材料状态更新失败：${errorText(e)}`);
    } finally { setBusy(false); }
  }

  function removeMaterial(materialId: string) {
    setForm((current) => current && ({
      ...current,
      materials: current.materials.filter((material) => material.materialId !== materialId),
      subQuestions: current.subQuestions.map((sub) => ({ ...sub, materialIds: sub.materialIds.filter((id) => id !== materialId) })),
    }));
  }

  async function save(submit: boolean) {
    if (!form) return;
    setError(""); setMessage("");
    const result = buildContent(form);
    if (!result.content) { setError(result.problems.join("；")); return; }
    const badFormula = formulaProblem(result.content);
    if (badFormula) { setError(badFormula); return; }
    if (!sectionId) { setError("请选择卷内分部。"); return; }
    setBusy(true);
    try {
      const saved = await window.paperweave.saveIntake({
        examId,
        sectionId,
        questionId: editing?.questionId,
        content: result.content,
        classification: form.classification,
        submit,
      });
      setEditing({ questionId: saved.questionId, versionId: saved.versionId, version: saved.version });
      setQuestions(await window.paperweave.listExamQuestions(examId));
      setMessage(submit ? `已提交待核（版本 ${saved.version}）。` : `草稿已保存（版本 ${saved.version}）。`);
      setCropTarget(null);
    } catch (e) {
      setError(`保存失败：${errorText(e)}。当前编辑内容仍在界面上。`);
    } finally { setBusy(false); }
  }

  const paper = exam?.files.find((file) => file.role === "paper");
  const cropLabel = (() => {
    if (!cropTarget || !form) return null;
    if (cropTarget.field === "stem") return "题干";
    const sub = form.subQuestions.find((entry) => entry.key === cropTarget.subKey);
    const label = sub?.originalLabel || "小问";
    return `${label} ${cropTarget.field === "prompt" ? "题干" : cropTarget.field === "answer" ? "答案" : "解析"}`;
  })();
  const section = exam?.sections.find((entry) => entry.id === sectionId);

  return <main className="paper-app intake-app">
    <header className="paper-top">
      <div><h1>{exam?.exam.title ?? "录题工作台"}</h1><p>左看原卷 · 右录题目{editing ? ` · 正在编辑版本 ${editing.version}` : " · 新题"}</p></div>
      <div className="paper-actions"><button onClick={onBack}>返回考试原卷</button><button onClick={() => exam && beginNew(exam)} disabled={busy}>新建题目</button></div>
    </header>
    {message && <p role="status" className="paper-message">{message}</p>}
    {error && <p role="alert" className="error">{error} <button onClick={() => setError("")}>关闭</button></p>}

    <div className="intake-grid">
      <aside className="intake-left">
        {paper ? <ExamPdfPanel fileId={paper.id} page={page} cropLabel={cropLabel} disabled={busy} onPageChange={setPage} onCrop={(dataUrl) => void insertCrop(dataUrl)} onError={setError} /> : <p role="alert" className="error">这场考试没有原卷文件，请先返回考试原卷页挂接 PDF。</p>}
      </aside>

      <section className="intake-right" aria-label="录题编辑">
        <section className="paper-panel" aria-label="本卷题目">
          <header><h2>本卷题目（{questions.length}）</h2></header>
          {questions.length === 0 ? <p className="muted">还没有保存的题目。</p> : <ul className="paper-list">
            {questions.map((question) => <li key={question.questionId} className="paper-card">
              <div>
                <strong>{question.preview || "（无题干预览）"}</strong>
                <p className="muted">{exam?.sections.find((entry) => entry.id === question.sectionId)?.title ?? "分部待补"} · 原卷第 {question.source.pdfPage} 页 · 题 {question.source.originalNumber} · {statusLabels[question.contentStatus]} · 答案{answerLabels[question.answerStatus]}</p>
              </div>
              <div className="paper-actions">
                <button onClick={() => void loadQuestion(question)} disabled={busy}>编辑</button>
                <button onClick={() => { setPage(question.source.pdfPage); setMessage(`已定位到原卷第 ${question.source.pdfPage} 页。`); }}>定位原页</button>
              </div>
            </li>)}
          </ul>}
        </section>

        {form && <>
          <section className="paper-panel" aria-label="分类与来源">
            <h2>分类与来源</h2>
            <div className="paper-grid">
              <label>学段<select value={form.classification.stage} onChange={(event) => setForm({ ...form, classification: { ...form.classification, stage: event.target.value as Stage } })}>{stages.map((stage) => <option key={stage}>{stage}</option>)}</select></label>
              <label>学科<input value={form.classification.subject} onChange={(event) => setForm({ ...form, classification: { ...form.classification, subject: event.target.value } })} /></label>
              <label>年级<input value={form.classification.grade} onChange={(event) => setForm({ ...form, classification: { ...form.classification, grade: event.target.value } })} /></label>
              <label>题型<input value={form.classification.questionType} onChange={(event) => setForm({ ...form, classification: { ...form.classification, questionType: event.target.value } })} /></label>
              <label>年份<input value={form.classification.year} onChange={(event) => setForm({ ...form, classification: { ...form.classification, year: event.target.value } })} /></label>
              <label>来源<input value={form.classification.sourceName} onChange={(event) => setForm({ ...form, classification: { ...form.classification, sourceName: event.target.value } })} /></label>
              <label>知识点（逗号分隔）<input value={knowledgeText} onChange={(event) => { const text = event.target.value; setKnowledgeText(text); setForm({ ...form, classification: { ...form.classification, knowledgePoints: parsePoints(text) } }); }} /></label>
            </div>
            <div className="paper-inline">
              <label>卷内分部<select value={sectionId} onChange={(event) => { const id = event.target.value; setSectionId(id); const picked = exam?.sections.find((entry) => entry.id === id); if (picked) setForm({ ...form, source: { ...form.source, section: picked.title } }); }}>{exam?.sections.map((entry) => <option key={entry.id} value={entry.id}>{entry.title}</option>)}</select></label>
              <label>原卷页码<input type="number" min={1} max={2000} value={form.source.pdfPage} onChange={(event) => setForm({ ...form, source: { ...form.source, pdfPage: event.target.value } })} /></label>
              <label>原题号<input value={form.source.originalNumber} onChange={(event) => setForm({ ...form, source: { ...form.source, originalNumber: event.target.value } })} /></label>
            </div>
            {section && <p className="muted">来源分部：{section.title}{section.subject ? `（${section.subject}）` : ""}；原文位置同时写入题目内容。</p>}
          </section>

          <section className="paper-panel" aria-label="题组内容">
            <h2>题组内容</h2>
            <BlockListEditor label="题干" blocks={form.stem} disabled={busy} onChange={(blocks) => setForm({ ...form, stem: blocks })} onCrop={() => requestCrop({ field: "stem" })} />
            {form.subQuestions.map((sub, index) => <fieldset className="intake-sub" key={sub.key} aria-label={`小问 ${index + 1}`}>
              <legend>小问 {index + 1}</legend>
              <div className="paper-inline">
                <label>小问号<input value={sub.originalLabel} onChange={(event) => updateSub(sub.key, { originalLabel: event.target.value })} /></label>
                <label>原分值<input type="number" min={0} max={1000} step={0.5} value={sub.originalScore} onChange={(event) => updateSub(sub.key, { originalScore: event.target.value })} /></label>
                <button onClick={() => removeSub(sub.key)} disabled={busy || form.subQuestions.length <= 1}>删除小问</button>
              </div>
              <BlockListEditor label={`小问 ${index + 1} 题干`} blocks={sub.prompt} disabled={busy} onChange={(blocks) => setSubBlocks(sub.key, "prompt", blocks)} onCrop={() => requestCrop({ field: "prompt", subKey: sub.key })} />
              <label>选项（每行一个）<textarea value={sub.options} onChange={(event) => updateSub(sub.key, { options: event.target.value })} placeholder="选项甲&#10;选项乙" /></label>
              <BlockListEditor label={`小问 ${index + 1} 答案`} blocks={sub.answer} disabled={busy} onChange={(blocks) => setSubBlocks(sub.key, "answer", blocks)} onCrop={() => requestCrop({ field: "answer", subKey: sub.key })} />
              <BlockListEditor label={`小问 ${index + 1} 解析`} blocks={sub.explanation} disabled={busy} onChange={(blocks) => setSubBlocks(sub.key, "explanation", blocks)} onCrop={() => requestCrop({ field: "explanation", subKey: sub.key })} />
              <fieldset className="intake-scoring" aria-label={`小问 ${index + 1} 评分点`}>
                <legend>评分点</legend>
                {sub.scoring.map((point, pointIndex) => <div className="paper-inline" key={pointIndex}>
                  <label>说明<input value={point.description} onChange={(event) => updateSub(sub.key, { scoring: sub.scoring.map((entry, i) => i === pointIndex ? { ...entry, description: event.target.value } : entry) })} /></label>
                  <label>分值<input type="number" min={0} max={1000} step={0.5} value={point.score} onChange={(event) => updateSub(sub.key, { scoring: sub.scoring.map((entry, i) => i === pointIndex ? { ...entry, score: event.target.value } : entry) })} /></label>
                  <button onClick={() => updateSub(sub.key, { scoring: sub.scoring.filter((_, i) => i !== pointIndex) })} disabled={busy}>删除</button>
                </div>)}
                <button onClick={() => updateSub(sub.key, { scoring: [...sub.scoring, { description: "", score: "" }] })} disabled={busy}>添加评分点</button>
              </fieldset>
              {index > 0 && <fieldset className="intake-dependencies" aria-label={`小问 ${index + 1} 依赖`}>
                <legend>依赖小问</legend>
                {form.subQuestions.slice(0, index).map((previous) => <label key={previous.key} className="inline">
                  <input type="checkbox" checked={sub.dependsOn.includes(previous.id)} onChange={(event) => updateSub(sub.key, { dependsOn: event.target.checked ? [...sub.dependsOn, previous.id] : sub.dependsOn.filter((id) => id !== previous.id) })} />
                  {previous.originalLabel || `第 ${form.subQuestions.indexOf(previous) + 1} 小问`}
                </label>)}
              </fieldset>}
            </fieldset>)}
            <button onClick={addSub} disabled={busy}>添加小问</button>

            <fieldset className="intake-selection" aria-label="组选答规则">
              <legend>组选答规则</legend>
              <label className="inline"><input type="radio" checked={form.selection.mode === "all"} onChange={() => setForm({ ...form, selection: { mode: "all" } })} />全部小问必答</label>
              <label className="inline"><input type="radio" checked={form.selection.mode === "choose"} onChange={() => setForm({ ...form, selection: form.selection.mode === "choose" ? form.selection : { mode: "choose", required: 1, candidates: [] } })} />选做</label>
              {form.selection.mode === "choose" && <div className="paper-inline">
                <label>选做数量<input type="number" min={1} value={form.selection.required} onChange={(event) => setForm({ ...form, selection: form.selection.mode === "choose" ? { ...form.selection, required: Number(event.target.value) || 1 } : form.selection })} /></label>
                {form.subQuestions.map((sub, index) => <label key={sub.key} className="inline">
                  <input type="checkbox" checked={form.selection.mode === "choose" && form.selection.candidates.includes(sub.id)} onChange={(event) => setForm({ ...form, selection: form.selection.mode === "choose" ? { ...form.selection, candidates: event.target.checked ? [...form.selection.candidates, sub.id] : form.selection.candidates.filter((id) => id !== sub.id) } : form.selection })} />
                  {sub.originalLabel || `第 ${index + 1} 小问`}
                </label>)}
              </div>}
            </fieldset>
          </section>

          <section className="paper-panel" aria-label="材料">
            <h2>题组材料</h2>
            {form.materials.length === 0 ? <p className="muted">本题未引用材料。</p> : <ul className="paper-list">
              {form.materials.map((material) => <li key={material.materialId} className="paper-card">
                <div><strong>{material.title}</strong><p className="muted">材料状态：{material.status ? materialLabels[material.status] : "未知"}</p></div>
                <div className="paper-actions">
                  {material.status === "draft" && <button onClick={() => void advanceMaterial(material)} disabled={busy}>提交待核</button>}
                  {material.status === "pending" && <button onClick={() => void advanceMaterial(material)} disabled={busy}>审核通过</button>}
                  <button onClick={() => removeMaterial(material.materialId)} disabled={busy}>从本题移除</button>
                </div>
              </li>)}
            </ul>}
            <details>
              <summary>新建材料</summary>
              <div className="paper-grid">
                <label>材料标题<input value={materialForm.title} onChange={(event) => setMaterialForm({ ...materialForm, title: event.target.value })} /></label>
                <label>材料出处<input value={materialForm.source} onChange={(event) => setMaterialForm({ ...materialForm, source: event.target.value })} /></label>
              </div>
              <label>材料正文<textarea value={materialForm.content} onChange={(event) => setMaterialForm({ ...materialForm, content: event.target.value })} /></label>
              <button onClick={() => void addMaterial()} disabled={busy}>建立材料草稿</button>
            </details>
          </section>

          <section className="paper-panel intake-actions" aria-label="保存">
            <div className="paper-actions">
              <button className="primary" onClick={() => void save(false)} disabled={busy}>{busy ? "处理中…" : "保存草稿"}</button>
              <button onClick={() => void save(true)} disabled={busy}>提交待核</button>
              <button onClick={() => exam && beginNew(exam)} disabled={busy}>放弃并新建</button>
            </div>
            <p className="muted">保存草稿不会进入组卷；提交待核后仍需审核。已审核题再次保存会生成新版本并回到待核。</p>
          </section>
        </>}
      </section>
    </div>
  </main>;
}
