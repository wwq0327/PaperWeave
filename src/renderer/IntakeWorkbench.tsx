import { useEffect, useState } from "react";
import katex from "katex";
import { AI_LIMITS, base64Bytes, isAiDraft, normalizeAiInput, type AiDraft, type AiMaterialSuggestion, type AiQuestion } from "../shared/ai";
import type { AiConfig } from "../shared/ai-config";
import { aiQuestionToIntake, type AiIntakeResult } from "../shared/ai-intake";
import type { ExamDetailView, ExamQuestionSummary } from "../shared/exam";
import type { Block } from "../shared/document";
import { blankSubQuestion, buildContent, contentToForm, newIntakeForm, type IntakeBlock, type IntakeDuplicateSummary, type IntakeForm, type IntakeMaterial, type IntakeSlot, type IntakeSubQuestion } from "../shared/intake";
import type { Classification, QuestionBlock, QuestionContent, ReviewStatus, Stage } from "../shared/question";
import BlockListEditor from "./BlockListEditor";
import ExamPdfPanel from "./ExamPdfPanel";

const stages: Stage[] = ["小学", "初中", "高中"];
const statusLabels: Record<ReviewStatus, string> = { draft: "草稿", pending: "待核", approved: "已审核" };
const materialLabels: Record<ReviewStatus, string> = { draft: "草稿", pending: "待核", approved: "已审核" };
const answerLabels: Record<"missing" | "pending" | "approved", string> = { missing: "待补", pending: "待核", approved: "已审核" };
const subFields = ["prompt", "answer", "explanation"] as const;
type SubField = typeof subFields[number];
type CropTarget = { field: "stem" } | { field: SubField; subKey: string } | { field: "ai" };

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
  const [duplicate, setDuplicate] = useState<{ summary: IntakeDuplicateSummary; submit: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [aiMode, setAiMode] = useState<"images" | "text">("images");
  const [aiImages, setAiImages] = useState<{ dataUrl: string; page: number }[]>([]);
  const [aiText, setAiText] = useState("");
  const [aiPages, setAiPages] = useState("");
  const [aiNote, setAiNote] = useState("");
  const [aiConfig, setAiConfig] = useState<(AiConfig & { hasKey: boolean }) | null>(null);
  const [aiConfirming, setAiConfirming] = useState(false);
  const [aiSending, setAiSending] = useState(false);
  const [aiRequestId, setAiRequestId] = useState<string | null>(null);
  const [aiDraft, setAiDraft] = useState<AiDraft | null>(null);
  const [aiAdopted, setAiAdopted] = useState<number[]>([]);
  const [aiMessage, setAiMessage] = useState("");
  const [aiError, setAiError] = useState("");
  const [aiUncertain, setAiUncertain] = useState<string[]>([]);
  const [aiUncertainAck, setAiUncertainAck] = useState(false);
  const [aiPendingAdopt, setAiPendingAdopt] = useState<{ index: number; result: AiIntakeResult } | null>(null);
  const [aiMaterials, setAiMaterials] = useState<AiMaterialSuggestion[]>([]);
  const [aiMaterialMessage, setAiMaterialMessage] = useState("");

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
    setDuplicate(null);
    setPage(1);
    setCropTarget(null);
    setKnowledgeText("");
    resetAiAdoption();
    setMessage("新题录入。");
    setError("");
  }

  function resetAiAdoption() {
    setAiUncertain([]);
    setAiUncertainAck(false);
    setAiMaterials([]);
    setAiPendingAdopt(null);
    setAiMaterialMessage("");
  }

  useEffect(() => {
    if (!aiOpen || aiConfig !== null) return;
    let live = true;
    window.paperweave.getAiConfig()
      .then((value) => { if (live) setAiConfig(value); })
      .catch((reason: unknown) => { if (live) setAiError(`读取 AI 设置失败：${errorText(reason)}`); });
    return () => { live = false; };
  }, [aiOpen, aiConfig]);

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
      setDuplicate(null);
      const matched = summary.sectionId ?? exam?.sections.find((section) => section.title === detail.content.source.section)?.id ?? exam?.sections[0]?.id ?? "";
      setSectionId(matched);
      setPage(detail.content.source.pdfPage);
      setCropTarget(null);
      resetAiAdoption();
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
  const setSlotAnswer = (key: string, slotId: string, blocks: IntakeBlock[]) => {
    setForm((current) => current && ({
      ...current,
      subQuestions: current.subQuestions.map((sub) => {
        if (sub.key !== key) return sub;
        const existing = sub.slotAnswers.some((entry) => entry.slotId === slotId);
        const slotAnswers = existing
          ? sub.slotAnswers.map((entry) => entry.slotId === slotId ? { ...entry, blocks } : entry)
          : [...sub.slotAnswers, { slotId, blocks }];
        return { ...sub, slotAnswers };
      }),
    }));
  };
  const updateSlot = (key: string, slotId: string, patch: Partial<IntakeSlot>) => {
    updateSub(key, {
      slots: form?.subQuestions.find((sub) => sub.key === key)?.slots.map((slot) => slot.id === slotId ? { ...slot, ...patch } : slot) ?? [],
    });
  };
  const addSlot = (key: string) => {
    const sub = form?.subQuestions.find((entry) => entry.key === key);
    if (!sub) return;
    updateSub(key, {
      slots: [...sub.slots, { id: globalThis.crypto.randomUUID(), label: `空位 ${sub.slots.length + 1}`, kind: "text", required: true, interchangeableWith: [] }],
    });
  };
  const removeSlot = (key: string, slotId: string) => {
    const sub = form?.subQuestions.find((entry) => entry.key === key);
    if (!sub) return;
    updateSub(key, {
      slots: sub.slots.filter((slot) => slot.id !== slotId).map((slot) => ({ ...slot, interchangeableWith: slot.interchangeableWith.filter((id) => id !== slotId) })),
      slotAnswers: sub.slotAnswers.filter((entry) => entry.slotId !== slotId),
      scoring: sub.scoring.map((point) => ({ ...point, slotIds: point.slotIds.filter((id) => id !== slotId) })),
    });
  };
  const toggleInterchange = (key: string, slotId: string, otherId: string, checked: boolean) => {
    const sub = form?.subQuestions.find((entry) => entry.key === key);
    if (!sub) return;
    updateSub(key, {
      slots: sub.slots.map((slot) => {
        if (slot.id !== slotId && slot.id !== otherId) return slot;
        const linked = slot.id === slotId ? otherId : slotId;
        return {
          ...slot,
          interchangeableWith: checked
            ? [...new Set([...slot.interchangeableWith, linked])]
            : slot.interchangeableWith.filter((id) => id !== linked),
        };
      }),
    });
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
    if (target.field === "ai") {
      setAiImages((current) => [...current, { dataUrl, page }]);
      setCropTarget(null);
      setAiConfirming(false);
      setAiDraft(null);
      setAiAdopted([]);
      setAiMessage(`已添加第 ${page} 页 AI 选区，共 ${aiImages.length + 1} 张。`);
      setAiError("");
      return;
    }
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

  async function save(submit: boolean, revisionOf?: string) {
    if (!form) return;
    if (aiUncertain.length > 0 && !aiUncertainAck) {
      setError("AI 待核项尚未确认，请先核对并勾选「我已核对 AI 待核项」。");
      return;
    }
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
        questionId: revisionOf ?? editing?.questionId,
        content: result.content,
        classification: form.classification,
        submit,
      });
      if (!saved.saved) {
        setDuplicate({ summary: saved.duplicate, submit });
        return;
      }
      setDuplicate(null);
      setEditing({ questionId: saved.questionId, versionId: saved.versionId, version: saved.version });
      setQuestions(await window.paperweave.listExamQuestions(examId));
      resetAiAdoption();
      setMessage(submit ? `已提交待核（版本 ${saved.version}）。` : `草稿已保存（版本 ${saved.version}）。`);
      setCropTarget(null);
    } catch (e) {
      setError(`保存失败：${errorText(e)}。当前编辑内容仍在界面上。`);
    } finally { setBusy(false); }
  }

  function editDuplicate() {
    if (!duplicate) return;
    const target = questions.find((question) => question.questionId === duplicate.summary.questionId);
    if (!target) { setError("题目列表已变化，请重新载入本卷题目。"); setDuplicate(null); return; }
    setDuplicate(null);
    void loadQuestion(target);
  }

  function reviseDuplicate() {
    if (!duplicate) return;
    void save(duplicate.submit, duplicate.summary.questionId);
  }

  const paper = exam?.files.find((file) => file.role === "paper");
  const cropLabel = (() => {
    if (!cropTarget || !form) return null;
    if (cropTarget.field === "ai") return "AI 拆题选区";
    if (cropTarget.field === "stem") return "题干";
    const sub = form.subQuestions.find((entry) => entry.key === cropTarget.subKey);
    const label = sub?.originalLabel || "小问";
    return `${label} ${cropTarget.field === "prompt" ? "题干" : cropTarget.field === "answer" ? "答案" : "解析"}`;
  })();
  const section = exam?.sections.find((entry) => entry.id === sectionId);

  function formHasContent(current: IntakeForm): boolean {
    const blocksHaveText = (blocks: IntakeBlock[]) => blocks.some((block) => block.kind === "text" ? block.text.trim() !== "" : block.kind === "formula" ? block.latex.trim() !== "" : block.kind === "table" ? block.rows.some((row) => row.some((cell) => cell.trim() !== "")) : true);
    return current.stem.some((block) => block.kind !== "image" ? blocksHaveText([block]) : true)
      || current.subQuestions.some((sub) => blocksHaveText(sub.prompt) || blocksHaveText(sub.answer) || blocksHaveText(sub.explanation) || sub.options.trim() !== "" || sub.originalScore.trim() !== "")
      || current.materials.length > 0
      || current.source.originalNumber.trim() !== "";
  }

  function parsedAiPages(): number[] {
    return [...new Set(aiPages.split(/[,，、\s]+/).map((item) => Number(item)).filter((page) => Number.isInteger(page) && page >= 1 && page <= 2000))].sort((a, b) => a - b);
  }

  function buildAiInput() {
    if (aiMode === "images") return normalizeAiInput({ mode: "images", images: aiImages, note: aiNote });
    return normalizeAiInput({ mode: "text", text: aiText, pages: parsedAiPages() });
  }

  function requestAiSend() {
    setAiError(""); setAiMessage("");
    const checked = buildAiInput();
    if (!checked.ok) { setAiError(checked.error); return; }
    setAiConfirming(true);
  }

  async function sendAi() {
    const checked = buildAiInput();
    if (!checked.ok) { setAiError(checked.error); setAiConfirming(false); return; }
    const id = crypto.randomUUID();
    setAiRequestId(id); setAiSending(true); setAiError(""); setAiMessage(""); setAiConfirming(false);
    try {
      const draft = await window.paperweave.generateAiDraft(id, checked.input);
      if (!isAiDraft(draft)) throw new Error("模型返回格式无法解析，请重试或手工录入");
      setAiDraft(draft); setAiAdopted([]);
      setAiMessage("AI 草稿已生成，请逐题对照原卷核对后采纳。");
    } catch (e) {
      const text = errorText(e);
      if (text.includes("已取消")) setAiMessage("已取消。AI 输入与当前表单都保留在本机。");
      else setAiError(text);
    } finally { setAiSending(false); setAiRequestId(null); }
  }

  async function cancelAi() {
    if (!aiRequestId) return;
    await window.paperweave.cancelAiDraft(aiRequestId).catch(() => undefined);
    setAiMessage("正在取消，已生成的内容不会自动写入表单。");
  }

  function requestAdoptQuestion(index: number) {
    const question = aiDraft?.questions[index];
    if (!question || !form) return;
    const result = aiQuestionToIntake(question, form.classification, section?.title ?? form.source.section);
    if (formHasContent(form)) setAiPendingAdopt({ index, result });
    else adoptQuestion(index, result);
  }

  function adoptQuestion(index: number, result: AiIntakeResult) {
    setForm(result.form);
    setKnowledgeText(result.form.classification.knowledgePoints.join("，"));
    setAiUncertain(result.uncertain);
    setAiUncertainAck(result.uncertain.length === 0);
    setAiMaterials(result.materials);
    setAiMaterialMessage("");
    setAiPendingAdopt(null);
    setAiAdopted((current) => current.includes(index) ? current : [...current, index]);
    const nextPage = Number(result.form.source.pdfPage);
    if (Number.isInteger(nextPage) && nextPage >= 1) setPage(nextPage);
    setMessage(`已采纳 AI 第 ${index + 1} 题到表单，请核对并处理待核项后保存。`);
  }

  async function loadExamText() {
    if (!paper) return;
    setAiError(""); setAiMessage("");
    try {
      const result = await window.paperweave.getExamFileText(paper.id);
      const pages = result.pages.filter((entry) => entry.text.trim());
      if (!result.hasText || pages.length === 0) {
        setAiError("本卷没有可提取的文字，可能是扫描件。请改用裁图输入。");
        return;
      }
      setAiText(pages.map((entry) => `【第 ${entry.page} 页】\n${entry.text}`).join("\n\n"));
      setAiPages(pages.map((entry) => entry.page).join(","));
      setAiMessage(`已读取本卷 ${pages.length} 页文字，可修改或勾选页码后确认发送。`);
    } catch (e) { setAiError(`读取本卷文字失败：${errorText(e)}`); }
  }

  async function createAiMaterial(suggestion: AiMaterialSuggestion, index: number) {
    if (!form) return;
    setBusy(true); setAiError(""); setAiMaterialMessage("");
    try {
      const content: Block[] = [{ type: "paragraph", runs: [{ type: "text", text: suggestion.content, style: "普通" }] }];
      const created = await window.paperweave.createMaterial({ title: suggestion.title, content, source: suggestion.source });
      setForm((current) => current && ({
        ...current,
        materials: [...current.materials, { materialId: created.materialId, versionId: created.id, title: created.title, status: created.status }],
        subQuestions: current.subQuestions.map((sub) => ({ ...sub, materialIds: [...new Set([...sub.materialIds, created.materialId])] })),
      }));
      setAiMaterials((current) => current.filter((_, position) => position !== index));
      setAiMaterialMessage(`材料「${suggestion.title}」已建立草稿并关联到本题，请在材料区审核。`);
    } catch (e) { setAiError(`建立材料草稿失败：${errorText(e)}`); }
    finally { setBusy(false); }
  }

  function changeAiMode(mode: "images" | "text") {
    if (aiSending) return;
    setAiMode(mode); setAiConfirming(false); setAiDraft(null); setAiAdopted([]); setAiError(""); setAiMessage("");
  }

  function removeAiImage(index: number) {
    setAiImages((current) => current.filter((_, position) => position !== index));
    setAiConfirming(false); setAiDraft(null); setAiAdopted([]);
  }

  return <main className="paper-app intake-app">
    <header className="paper-top">
      <div><h1>{exam?.exam.title ?? "录题工作台"}</h1><p>左看原卷 · 右录题目{editing ? ` · 正在编辑版本 ${editing.version}` : " · 新题"}</p></div>
      <div className="paper-actions"><button onClick={onBack}>返回考试原卷</button><button onClick={() => exam && beginNew(exam)} disabled={busy}>新建题目</button></div>
    </header>
    {message && <p role="status" className="paper-message">{message}</p>}
    {error && <p role="alert" className="error">{error} <button onClick={() => setError("")}>关闭</button></p>}
    {duplicate && <section role="alertdialog" aria-label="重复题提示" className="paper-panel intake-duplicate">
      <h2>发现同号题</h2>
      <p>本卷同一分部已有原题号「{duplicate.summary.source.originalNumber || "未填"}」的题目：{duplicate.summary.preview || "（无题干预览）"}</p>
      <p className="muted">原卷第 {duplicate.summary.source.pdfPage} 页 · 版本 {duplicate.summary.version} · {statusLabels[duplicate.summary.contentStatus]} · 答案{answerLabels[duplicate.summary.answerStatus]}</p>
      <div className="paper-actions">
        <button className="primary" onClick={editDuplicate} disabled={busy}>继续编辑已有题</button>
        <button onClick={reviseDuplicate} disabled={busy}>建立修订版</button>
        <button onClick={() => setDuplicate(null)} disabled={busy}>取消</button>
      </div>
    </section>}

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
          <section className="paper-panel" aria-label="AI 拆题">
            <header><h2>AI 拆题</h2><button onClick={() => setAiOpen((value) => !value)}>{aiOpen ? "收起" : "展开"}</button></header>
            {!aiOpen && <p className="muted">从原卷裁图或读取文字，生成结构化草稿，逐题核对后采纳。AI 结果不会自动入库。</p>}
            {aiOpen && <>
              <p className="muted">只上传你确认的文字或裁图；整份原卷、题库与其他资料留在本机。生成内容必须对照原卷逐题核对。</p>
              {aiConfig && <p className="muted">服务：{aiConfig.baseUrl} · 文字模型 {aiConfig.textModel} · 图像模型 {aiConfig.imageModel}{aiConfig.hasKey ? "" : " · 尚未配置密钥"}</p>}
              <div className="paper-actions" role="tablist" aria-label="AI 输入方式">
                <button role="tab" aria-selected={aiMode === "images"} className={aiMode === "images" ? "primary" : ""} onClick={() => changeAiMode("images")} disabled={aiSending}>裁图输入</button>
                <button role="tab" aria-selected={aiMode === "text"} className={aiMode === "text" ? "primary" : ""} onClick={() => changeAiMode("text")} disabled={aiSending}>文字输入</button>
              </div>
              {aiMode === "images" ? <>
                <p className="muted">最多 {AI_LIMITS.imageCount} 张，单张不超过 5 MiB，合计不超过 15 MiB；点「添加选区」后在左栏拖选，可跨页累积。</p>
                <button onClick={() => { setCropTarget({ field: "ai" }); setAiMessage("请在左栏原卷页面上拖选 AI 拆题区域。"); setAiError(""); }} disabled={aiSending || aiImages.length >= AI_LIMITS.imageCount}>添加选区</button>
                {aiImages.length > 0 && <ul className="paper-list">{aiImages.map((image, index) => <li key={index} className="paper-card">
                  <div><img src={image.dataUrl} alt={`AI 裁图 ${index + 1}`} className="ai-crop-thumb" /><p className="muted">第 {image.page} 页 · {Math.ceil(base64Bytes(image.dataUrl) / 1024)} KiB</p></div>
                  <button onClick={() => removeAiImage(index)} disabled={aiSending}>移除</button>
                </li>)}</ul>}
                <label>补充说明（可选）<textarea aria-label="AI 裁图说明" value={aiNote} onChange={(event) => setAiNote(event.target.value)} placeholder="例如：这三张是同一道跨页题" /></label>
              </> : <>
                <div className="paper-actions"><button onClick={() => void loadExamText()} disabled={!paper || aiSending}>读取本卷文字</button></div>
                <label>文字（可修改）<textarea aria-label="AI 文字" value={aiText} onChange={(event) => setAiText(event.target.value)} /><span className="muted">{[...aiText].length} / {AI_LIMITS.textChars} 字符（按码点）</span></label>
                <label>原卷页码（逗号分隔）<input aria-label="AI 页码" value={aiPages} onChange={(event) => setAiPages(event.target.value)} placeholder="例如 3,4" /></label>
              </>}
              <div className="paper-actions">
                <button className="primary" onClick={requestAiSend} disabled={aiSending}>确认发送</button>
                {aiSending && <button onClick={() => void cancelAi()}>取消</button>}
              </div>
              {aiConfirming && <section className="ai-confirm" aria-label="确认发送">
                <p>将向 {aiMode === "images" ? aiConfig?.imageModel ?? "图像模型" : aiConfig?.textModel ?? "文字模型"}（{aiConfig?.baseUrl ?? "服务地址待配置"}）发送
                  {aiMode === "images" ? ` ${aiImages.length} 张裁图，页码 ${[...new Set(aiImages.map((image) => image.page))].join("、")}` : `第 ${parsedAiPages().join("、")} 页文字，共 ${[...aiText].length} 个字符`}。</p>
                <p className="muted">确认只发送以上内容；原卷整份文件与题库不会上传。</p>
                <button className="primary" onClick={() => void sendAi()}>确认发送给模型</button>
                <button onClick={() => setAiConfirming(false)}>取消</button>
              </section>}
              {aiMessage && <p role="status">{aiMessage}</p>}
              {aiError && <p role="alert" className="error">{aiError}</p>}
              {aiDraft && <section aria-label="AI 草稿结果">
                <h3>AI 草稿（{aiDraft.questions.length} 题）</h3>
                {aiDraft.notes.length > 0 && <ul>{aiDraft.notes.map((note, index) => <li key={index} className="muted">{note}</li>)}</ul>}
                {aiDraft.questions.map((question, index) => <article key={index} className="paper-card ai-question">
                  <header><strong>AI 第 {index + 1} 题 · 原卷第 {question.page} 页{question.originalNumber ? ` · 题 ${question.originalNumber}` : ""}</strong><span className="paper-state">{aiAdopted.includes(index) ? "已采纳" : "待核对"}</span></header>
                  <p><strong>题干：</strong>{question.stem}</p>
                  {(question.parts ?? []).map((part, partIndex) => <div key={partIndex} className="ai-part">
                    <p><strong>{part.label || `(${partIndex + 1})`}</strong> {part.prompt}</p>
                    {part.options.length > 0 && <p>选项：{part.options.join("；")}</p>}
                    {part.answer && <p>答案：{part.answer}</p>}
                    {part.explanation && <p>解析：{part.explanation}</p>}
                    {part.score !== null && <p className="muted">原分值：{part.score}</p>}
                  </div>)}
                  {question.tags.length > 0 && <p className="muted">候选标签：{question.tags.join("、")}</p>}
                  {(question.materials ?? []).length > 0 && <p className="muted">建议材料：{(question.materials ?? []).map((material) => material.title).join("、")}</p>}
                  {question.uncertain.length > 0 && <p className="review-problems">待核：{question.uncertain.join("；")}</p>}
                  <div className="paper-actions">
                    <button className="primary" onClick={() => requestAdoptQuestion(index)} disabled={aiSending}>采纳到当前表单</button>
                    <button onClick={() => setAiAdopted((current) => current.includes(index) ? current : [...current, index])} disabled={aiSending || aiAdopted.includes(index)}>跳过</button>
                  </div>
                </article>)}
              </section>}
              {aiPendingAdopt && <section role="alertdialog" aria-label="覆盖当前表单" className="ai-confirm">
                <p>当前表单已有未保存内容。采纳 AI 第 {aiPendingAdopt.index + 1} 题会覆盖这些内容。</p>
                <button className="primary" onClick={() => adoptQuestion(aiPendingAdopt.index, aiPendingAdopt.result)}>覆盖并采纳</button>
                <button onClick={() => setAiPendingAdopt(null)}>取消</button>
              </section>}
              {aiMaterials.length > 0 && <section aria-label="AI 建议材料">
                <h3>AI 建议材料</h3>
                <p className="muted">材料不会自动创建；核对后点按钮建立草稿并关联到本题。</p>
                {aiMaterials.map((material, index) => <article key={index} className="paper-card">
                  <strong>{material.title}</strong>
                  {material.source && <p className="muted">出处：{material.source}</p>}
                  <p>{material.content}</p>
                  <button onClick={() => void createAiMaterial(material, index)} disabled={busy}>建立材料草稿并关联</button>
                </article>)}
              </section>}
              {aiMaterialMessage && <p role="status">{aiMaterialMessage}</p>}
            </>}
          </section>
          {aiUncertain.length > 0 && <section className="paper-panel" aria-label="AI 待核项">
            <h2>AI 待核项</h2>
            <ul className="review-problems">{aiUncertain.map((item) => <li key={item}>{item}</li>)}</ul>
            <label className="inline"><input type="checkbox" checked={aiUncertainAck} onChange={(event) => setAiUncertainAck(event.target.checked)} />我已核对 AI 待核项</label>
          </section>}
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
              <fieldset className="intake-slots" aria-label={`小问 ${index + 1} 作答位置`}>
                <legend>作答位置</legend>
                {sub.slots.length === 0 && <p className="muted">未设置作答位置；答案按整题记录。</p>}
                {sub.slots.map((slot, slotIndex) => <div className="intake-slot" key={slot.id}>
                  <div className="paper-inline">
                    <label>标签<input aria-label={`小问 ${index + 1} 空位 ${slotIndex + 1} 标签`} value={slot.label} onChange={(event) => updateSlot(sub.key, slot.id, { label: event.target.value })} /></label>
                    <label>类型<select aria-label={`小问 ${index + 1} 空位 ${slotIndex + 1} 类型`} value={slot.kind} onChange={(event) => updateSlot(sub.key, slot.id, { kind: event.target.value as IntakeSlot["kind"] })}>
                      <option value="text">文字</option>
                      <option value="choice">选择</option>
                      <option value="blank">填空</option>
                    </select></label>
                    <label className="inline"><input type="checkbox" aria-label={`小问 ${index + 1} 空位 ${slotIndex + 1} 必答`} checked={slot.required} onChange={(event) => updateSlot(sub.key, slot.id, { required: event.target.checked })} />必答</label>
                    <button aria-label={`小问 ${index + 1} 删除空位 ${slotIndex + 1}`} onClick={() => removeSlot(sub.key, slot.id)} disabled={busy}>删除空位</button>
                  </div>
                  {sub.slots.slice(slotIndex + 1).map((other) => <label key={other.id} className="inline">
                    <input
                      type="checkbox"
                      aria-label={`小问 ${index + 1} 空位 ${slotIndex + 1} 与空位 ${sub.slots.indexOf(other) + 1} 互换`}
                      checked={slot.interchangeableWith.includes(other.id)}
                      onChange={(event) => toggleInterchange(sub.key, slot.id, other.id, event.target.checked)}
                    />
                    空位 {slotIndex + 1} 与空位 {sub.slots.indexOf(other) + 1} 可互换
                  </label>)}
                  <BlockListEditor
                    label={`小问 ${index + 1} 空位 ${slotIndex + 1} 答案`}
                    blocks={sub.slotAnswers.find((entry) => entry.slotId === slot.id)?.blocks ?? []}
                    disabled={busy}
                    onChange={(blocks) => setSlotAnswer(sub.key, slot.id, blocks)}
                  />
                </div>)}
                <button onClick={() => addSlot(sub.key)} disabled={busy}>添加空位</button>
              </fieldset>
              <BlockListEditor label={`小问 ${index + 1} 答案`} blocks={sub.answer} disabled={busy} onChange={(blocks) => setSubBlocks(sub.key, "answer", blocks)} onCrop={() => requestCrop({ field: "answer", subKey: sub.key })} />
              <BlockListEditor label={`小问 ${index + 1} 解析`} blocks={sub.explanation} disabled={busy} onChange={(blocks) => setSubBlocks(sub.key, "explanation", blocks)} onCrop={() => requestCrop({ field: "explanation", subKey: sub.key })} />
              <fieldset className="intake-scoring" aria-label={`小问 ${index + 1} 评分点`}>
                <legend>评分点</legend>
                {sub.scoring.map((point, pointIndex) => <div className="paper-inline" key={pointIndex}>
                  <label>说明<input value={point.description} onChange={(event) => updateSub(sub.key, { scoring: sub.scoring.map((entry, i) => i === pointIndex ? { ...entry, description: event.target.value } : entry) })} /></label>
                  <label>分值<input type="number" min={0} max={1000} step={0.5} value={point.score} onChange={(event) => updateSub(sub.key, { scoring: sub.scoring.map((entry, i) => i === pointIndex ? { ...entry, score: event.target.value } : entry) })} /></label>
                  {sub.slots.map((slot, slotIndex) => <label key={slot.id} className="inline">
                    <input
                      type="checkbox"
                      aria-label={`小问 ${index + 1} 评分点 ${pointIndex + 1} 关联空位 ${slotIndex + 1}`}
                      checked={point.slotIds.includes(slot.id)}
                      onChange={(event) => updateSub(sub.key, { scoring: sub.scoring.map((entry, i) => i === pointIndex ? { ...entry, slotIds: event.target.checked ? [...entry.slotIds, slot.id] : entry.slotIds.filter((id) => id !== slot.id) } : entry) })}
                    />
                    {slot.label || `空位 ${slotIndex + 1}`}
                  </label>)}
                  <button aria-label={`删除评分点 ${pointIndex + 1}`} onClick={() => updateSub(sub.key, { scoring: sub.scoring.filter((_, i) => i !== pointIndex) })} disabled={busy}>删除</button>
                </div>)}
                <button onClick={() => updateSub(sub.key, { scoring: [...sub.scoring, { description: "", score: "", slotIds: [] }] })} disabled={busy}>添加评分点</button>
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
