import { useEffect, useState } from "react";
import {
  emptyImportSummary,
  importProblemKind,
  type ImportApplyResult,
  type ImportBatchView,
  type ImportCorrectionAction,
  type ImportDecision,
  type ImportRow,
  type ImportScanView,
  type ImportStatus,
} from "../shared/import";
import type { ImportDiffChange } from "../shared/import-diff";

const statusLabels: Record<ImportStatus, string> = {
  importable: "可导入",
  duplicate: "完全重复",
  changed: "来源变化",
  target_modified: "目标已人工修改",
  blocked: "阻断",
};

const diffLabels: Record<ImportDiffChange, string> = {
  added: "新增",
  removed: "删除",
  modified: "修改",
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 阻断项已单独列出，提示行只保留页码、分值等非阻断说明。 */
function notesOf(row: ImportRow): string[] {
  const problems = new Set(row.problems ?? []);
  return row.reasons.filter((reason) => !problems.has(reason));
}

function replaceRow(scan: ImportScanView, row: ImportRow): ImportScanView {
  const rows = scan.rows.map((entry) => entry.sourceKey === row.sourceKey ? row : entry);
  const summary = emptyImportSummary();
  for (const entry of rows) summary[entry.status] += 1;
  return { ...scan, rows, summary };
}

export default function ImportWorkbench({ onBack }: { onBack: () => void }) {
  const [scan, setScan] = useState<ImportScanView | null>(null);
  const [choices, setChoices] = useState<Record<string, ImportDecision>>({});
  const [proofread, setProofread] = useState<Record<string, boolean>>({});
  const [numberInputs, setNumberInputs] = useState<Record<string, string>>({});
  const [moveTargets, setMoveTargets] = useState<Record<string, number>>({});
  const [history, setHistory] = useState<ImportBatchView[]>([]);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function loadHistory() {
    try { setHistory(await window.paperweave.listImportBatches()); }
    catch (e) { setError(`读取批次记录失败：${errorText(e)}`); }
  }

  useEffect(() => { void loadHistory(); }, []);

  async function scanLibrary(kind: "tiku" | "mathvault") {
    setBusy(true); setError(""); setMessage("");
    try {
      const result = await window.paperweave.scanImports(kind);
      if (result.status === "canceled") return;
      setScan(result.scan);
      const initial: Record<string, ImportDecision> = {};
      for (const row of result.scan.rows) {
        if (row.status === "importable") initial[row.sourceKey] = "import";
        if (row.status === "changed" || row.status === "target_modified") initial[row.sourceKey] = "skip";
      }
      setChoices(initial);
      setProofread({});
      setMessage(`扫描完成：共 ${result.scan.rows.length} 条。确认后执行导入。`);
    } catch (e) {
      setError(`扫描失败：${errorText(e)}`);
    } finally { setBusy(false); }
  }

  async function apply() {
    if (!scan) return;
    const rows = Object.entries(choices).map(([sourceKey, action]) => ({
      sourceKey,
      action,
      ...(scan.rows.find((row) => row.sourceKey === sourceKey)?.needsProofread ? { acknowledgeProofread: proofread[sourceKey] === true } : {}),
    }));
    if (rows.length === 0) { setError("请选择至少一条要导入或保留的来源。"); return; }
    setBusy(true); setError(""); setMessage("");
    try {
      const result: ImportApplyResult = await window.paperweave.applyImports({ scanId: scan.scanId, rows });
      setMessage(`导入完成：新增 ${result.imported}，修订 ${result.revised}，保留 ${result.skipped}。`);
      setScan(null);
      setChoices({});
      setProofread({});
      await loadHistory();
    } catch (e) {
      setError(`导入失败：${errorText(e)}。本批未写入任何题目。`);
    } finally { setBusy(false); }
  }

  async function correct(row: ImportRow, action: ImportCorrectionAction, problem: string, extra: { value?: string; target?: number } = {}) {
    if (!scan) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const result = await window.paperweave.correctImport({ scanId: scan.scanId, sourceKey: row.sourceKey, action, problem, ...extra });
      if (result.status === "canceled") return;
      setScan((current) => current ? replaceRow(current, result.row) : current);
      setChoices((current) => {
        const next = { ...current };
        delete next[row.sourceKey];
        if (result.row.status === "importable") next[row.sourceKey] = "import";
        if (result.row.status === "changed") next[row.sourceKey] = "skip";
        return next;
      });
      if (action === "setOriginalNumber") setNumberInputs((current) => ({ ...current, [`${row.sourceKey}\n${problem}`]: "" }));
      setMessage(result.row.status === "blocked"
        ? `已处理「${problem}」，仍有阻断项需要继续处理。`
        : `已处理「${problem}」，该条已重新校验为${statusLabels[result.row.status]}。`);
    } catch (e) {
      setError(`修正失败：${errorText(e)}`);
    } finally { setBusy(false); }
  }

  function setChoice(row: ImportRow, action: ImportDecision) {
    setChoices((current) => ({ ...current, [row.sourceKey]: action }));
  }

  function setImportChecked(row: ImportRow, checked: boolean) {
    setChoices((current) => {
      const next = { ...current };
      if (checked) next[row.sourceKey] = "import";
      else delete next[row.sourceKey];
      return next;
    });
  }

  return <main className="paper-app import-app">
    <header className="paper-top">
      <div><h1>旧库迁入</h1><p>先扫描预览，确认后再写入；迁入题一律待核。</p></div>
      <div className="paper-actions"><button onClick={onBack}>返回录题草稿</button></div>
    </header>
    {message && <p role="status" className="paper-message">{message}</p>}
    {error && <p role="alert" className="error">{error} <button onClick={() => setError("")}>关闭</button></p>}

    <section className="paper-panel" aria-label="扫描旧库">
      <h2>旧库来源</h2>
      <p className="muted">选择 Tiku 或 mathVault 根目录（包含 wiki）。扫描只读，不修改旧库。</p>
      <div className="paper-actions">
        <button className="primary" onClick={() => void scanLibrary("tiku")} disabled={busy}>{busy ? "处理中…" : "扫描 Tiku 根目录"}</button>
        <button onClick={() => void scanLibrary("mathvault")} disabled={busy}>{busy ? "处理中…" : "扫描 mathVault 根目录"}</button>
        {scan && <button onClick={() => void apply()} disabled={busy}>执行导入</button>}
        {scan && <button onClick={() => { setScan(null); setChoices({}); setProofread({}); setMessage(""); }} disabled={busy}>取消本次扫描</button>}
      </div>
      {scan && <p className="muted">可导入 {scan.summary.importable} · 完全重复 {scan.summary.duplicate} · 来源变化 {scan.summary.changed} · 已人工修改 {scan.summary.target_modified} · 阻断 {scan.summary.blocked}</p>}
    </section>

    {scan && <section className="paper-panel" aria-label="迁入预览">
      <h2>迁入预览（{scan.rows.length}）</h2>
      {scan.rows.length === 0 ? <p className="muted">没有找到题目。</p> : <ul className="paper-list">
        {scan.rows.map((row) => {
          const notes = notesOf(row);
          return <li key={row.sourceKey} className="paper-card import-row">
            <div className="import-row-main">
              <strong>{row.title || row.sourceKey}</strong>
              <p className="muted">{statusLabels[row.status]} · {row.section} · 原卷第 {row.pdfPage} 页 · 题 {row.originalNumber || "待补"} · {row.sourceKey}</p>
              {row.preview && <p className="muted">新来源：{row.preview}</p>}
              {row.status === "changed" && row.target && <p className="muted">当前题库：{row.target.preview || "（无预览）"}（版本 {row.target.version}）</p>}
              {(row.status === "changed" || row.status === "target_modified") && row.diff && (row.diff.length > 0
                ? <div className="import-diff">
                  <p className="muted">字段差异：</p>
                  <ul>{row.diff.map((item) => <li key={item.field} className="muted">
                    <strong>{item.field}（{diffLabels[item.change]}）</strong>：{item.before} → {item.after}
                  </li>)}</ul>
                </div>
                : <p className="muted">字段差异：未检测到文字内容变化（可能仅为源文件空白或格式变化）。</p>)}
              {row.problems && row.problems.length > 0 && <ul className="import-problems">
                {row.problems.map((problem) => {
                  const kind = importProblemKind(problem);
                  const key = `${row.sourceKey}\n${problem}`;
                  return <li key={problem} className="paper-inline">
                    <span>{problem}</span>
                    {kind === "image" && <button onClick={() => void correct(row, "attachImage", problem)} disabled={busy}>
                      {/图片为空|图片格式不支持|远程图片/.test(problem) ? "选择图片替换" : "选择图片补入"}
                    </button>}
                    {kind === "image" && <button onClick={() => void correct(row, "dropProblem", problem)} disabled={busy}>不带此图导入</button>}
                    {kind === "material" && <button onClick={() => void correct(row, "dropProblem", problem)} disabled={busy}>不带此材料导入</button>}
                    {kind === "originalNumber" && <>
                      <input aria-label={`补填原题号（${row.sourceKey}）`} value={numberInputs[key] ?? ""} onChange={(event) => setNumberInputs((current) => ({ ...current, [key]: event.target.value }))} placeholder="原题号" />
                      <button onClick={() => void correct(row, "setOriginalNumber", problem, { value: numberInputs[key] ?? "" })} disabled={busy}>保存原题号</button>
                    </>}
                    {kind === "subLabel" && <>
                      <select aria-label={`并入小问（${problem}）`} value={moveTargets[key] ?? 1} onChange={(event) => setMoveTargets((current) => ({ ...current, [key]: Number(event.target.value) }))}>
                        {Array.from({ length: row.subQuestionCount ?? 1 }, (_, index) => <option key={index + 1} value={index + 1}>第 {index + 1} 小问</option>)}
                      </select>
                      <button onClick={() => void correct(row, "moveSubLabel", problem, { target: moveTargets[key] ?? 1 })} disabled={busy}>调整到该小问</button>
                      <button onClick={() => void correct(row, "dropProblem", problem)} disabled={busy}>删除该条目</button>
                    </>}
                    {kind === "other" && <span className="muted">不能在应用内修正，请修改源文件后重新扫描。</span>}
                  </li>;
                })}
              </ul>}
              {row.status === "blocked" && ((row.problems?.length ?? 0) === 0 || (row.problems ?? []).some((problem) => importProblemKind(problem) === "other")) && <div className="import-unfixable">
                <p className="muted">源文件：{row.sourcePath ?? row.sourceKey}{(row.problems?.length ?? 0) === 0 ? `；${row.reasons.join("；")}` : ""}</p>
                <button onClick={() => void scanLibrary(scan.kind)} disabled={busy}>修改源文件后重新扫描</button>
              </div>}
              {notes.length > 0 && <p className="muted">提示：{notes.join("；")}</p>}
            </div>
            <div className="paper-actions">
              {row.status === "importable" && <label className="inline"><input type="checkbox" checked={choices[row.sourceKey] === "import"} onChange={(event) => setImportChecked(row, event.target.checked)} />导入</label>}
              {row.needsProofread && <label className="inline"><input type="checkbox" checked={proofread[row.sourceKey] === true} onChange={(event) => setProofread((current) => ({ ...current, [row.sourceKey]: event.target.checked }))} />我已核对校勘说明</label>}
              {row.status === "changed" && <>
                <label className="inline"><input type="radio" name={`action-${row.sourceKey}`} checked={choices[row.sourceKey] === "revise"} onChange={() => setChoice(row, "revise")} />建立修订版</label>
                <label className="inline"><input type="radio" name={`action-${row.sourceKey}`} checked={choices[row.sourceKey] === "skip"} onChange={() => setChoice(row, "skip")} />保留当前</label>
              </>}
              {row.status === "target_modified" && <>
                <label className="inline"><input type="radio" name={`action-${row.sourceKey}`} checked={choices[row.sourceKey] === "skip"} onChange={() => setChoice(row, "skip")} />保留当前</label>
                <span className="muted">目标题已被人工修改，不自动覆盖。</span>
              </>}
            </div>
          </li>;
        })}
      </ul>}
    </section>}

    <section className="paper-panel" aria-label="迁入批次">
      <h2>最近批次</h2>
      {history.length === 0 ? <p className="muted">还没有导入批次。</p> : <ul className="paper-list">
        {history.map((batch) => <li key={batch.id} className="paper-card">
          <div><strong>{batch.kind === "tiku" ? "Tiku" : "mathVault"} · {batch.rootName}</strong><p className="muted">{new Date(batch.createdAt).toLocaleString("zh-CN")}</p></div>
          <p className="muted">新增 {batch.summary.imported ?? 0} · 修订 {batch.summary.revised ?? 0} · 保留 {batch.summary.skipped ?? 0} · 新材料 {batch.summary.materials ?? 0}</p>
        </li>)}
      </ul>}
    </section>
  </main>;
}
