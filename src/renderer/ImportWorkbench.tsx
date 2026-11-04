import { useEffect, useState } from "react";
import type { ImportApplyResult, ImportBatchView, ImportDecision, ImportRow, ImportScanView, ImportStatus } from "../shared/import";

const statusLabels: Record<ImportStatus, string> = {
  importable: "可导入",
  duplicate: "完全重复",
  changed: "来源变化",
  target_modified: "目标已人工修改",
  blocked: "阻断",
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function ImportWorkbench({ onBack }: { onBack: () => void }) {
  const [scan, setScan] = useState<ImportScanView | null>(null);
  const [choices, setChoices] = useState<Record<string, ImportDecision>>({});
  const [history, setHistory] = useState<ImportBatchView[]>([]);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function loadHistory() {
    try { setHistory(await window.paperweave.listImportBatches()); }
    catch (e) { setError(`读取批次记录失败：${errorText(e)}`); }
  }

  useEffect(() => { void loadHistory(); }, []);

  async function scanTiku() {
    setBusy(true); setError(""); setMessage("");
    try {
      const result = await window.paperweave.scanImports("tiku");
      if (result.status === "canceled") return;
      setScan(result.scan);
      const initial: Record<string, ImportDecision> = {};
      for (const row of result.scan.rows) {
        if (row.status === "importable") initial[row.sourceKey] = "import";
        if (row.status === "changed") initial[row.sourceKey] = "skip";
      }
      setChoices(initial);
      setMessage(`扫描完成：共 ${result.scan.rows.length} 条。确认后执行导入。`);
    } catch (e) {
      setError(`扫描失败：${errorText(e)}`);
    } finally { setBusy(false); }
  }

  async function apply() {
    if (!scan) return;
    const rows = Object.entries(choices).map(([sourceKey, action]) => ({ sourceKey, action }));
    if (rows.length === 0) { setError("请选择至少一条要导入或保留的来源。"); return; }
    setBusy(true); setError(""); setMessage("");
    try {
      const result: ImportApplyResult = await window.paperweave.applyImports({ scanId: scan.scanId, rows });
      setMessage(`导入完成：新增 ${result.imported}，修订 ${result.revised}，保留 ${result.skipped}。`);
      setScan(null);
      setChoices({});
      await loadHistory();
    } catch (e) {
      setError(`导入失败：${errorText(e)}。本批未写入任何题目。`);
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
      <h2>Tiku 题库</h2>
      <p className="muted">选择 Tiku 根目录（包含 wiki/by-type 与 wiki/passages）。扫描只读，不修改旧库。</p>
      <div className="paper-actions">
        <button className="primary" onClick={() => void scanTiku()} disabled={busy}>{busy ? "处理中…" : "扫描 Tiku 根目录"}</button>
        {scan && <button onClick={() => void apply()} disabled={busy}>执行导入</button>}
        {scan && <button onClick={() => { setScan(null); setChoices({}); setMessage(""); }} disabled={busy}>取消本次扫描</button>}
      </div>
      {scan && <p className="muted">可导入 {scan.summary.importable} · 完全重复 {scan.summary.duplicate} · 来源变化 {scan.summary.changed} · 已人工修改 {scan.summary.target_modified} · 阻断 {scan.summary.blocked}</p>}
    </section>

    {scan && <section className="paper-panel" aria-label="迁入预览">
      <h2>迁入预览（{scan.rows.length}）</h2>
      {scan.rows.length === 0 ? <p className="muted">没有找到题目。</p> : <ul className="paper-list">
        {scan.rows.map((row) => <li key={row.sourceKey} className="paper-card import-row">
          <div className="import-row-main">
            <strong>{row.title || row.sourceKey}</strong>
            <p className="muted">{statusLabels[row.status]} · {row.section} · 原卷第 {row.pdfPage} 页 · 题 {row.originalNumber || "待补"} · {row.sourceKey}</p>
            {row.preview && <p className="muted">新来源：{row.preview}</p>}
            {row.status === "changed" && row.target && <p className="muted">当前题库：{row.target.preview || "（无预览）"}（版本 {row.target.version}）</p>}
            {row.reasons.length > 0 && <p className="muted">提示：{row.reasons.join("；")}</p>}
          </div>
          <div className="paper-actions">
            {row.status === "importable" && <label className="inline"><input type="checkbox" checked={choices[row.sourceKey] === "import"} onChange={(event) => setImportChecked(row, event.target.checked)} />导入</label>}
            {row.status === "changed" && <>
              <label className="inline"><input type="radio" name={`action-${row.sourceKey}`} checked={choices[row.sourceKey] === "revise"} onChange={() => setChoice(row, "revise")} />建立修订版</label>
              <label className="inline"><input type="radio" name={`action-${row.sourceKey}`} checked={choices[row.sourceKey] === "skip"} onChange={() => setChoice(row, "skip")} />保留当前</label>
            </>}
            {row.status === "target_modified" && <span className="muted">目标题已被人工修改，本次保留当前。</span>}
          </div>
        </li>)}
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
