import { useState } from "react";
import type { BackupSummary } from "../shared/backup";

function bytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MiB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(2)} GiB`;
}

function Summary({ value }: { value: BackupSummary }) {
  return <dl className="backup-summary">
    <dt>备份名称</dt><dd>{value.name}</dd>
    <dt>创建时间</dt><dd>{new Date(value.createdAt).toLocaleString("zh-CN")}</dd>
    <dt>数据版本</dt><dd>{value.dataVersion}</dd>
    <dt>应用版本</dt><dd>{value.appVersion}</dd>
    <dt>文件数</dt><dd>{value.fileCount}</dd>
    <dt>总大小</dt><dd>{bytes(value.totalBytes)}</dd>
  </dl>;
}

export default function BackupWorkbench({ onBack }: { onBack: () => void }) {
  const [destination, setDestination] = useState<string | null>(null);
  const [backup, setBackup] = useState<BackupSummary | null>(null);
  const [source, setSource] = useState<BackupSummary | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function chooseDestination() {
    setError(""); setMessage(""); setBackup(null);
    try {
      const picked = await window.paperweave.chooseBackupDestination();
      if (!picked) return;
      setDestination(picked.folder);
      setMessage("已选择备份位置，请确认后开始备份。");
    } catch (e) { setError(`无法选择备份位置：${String(e)}`); }
  }

  async function create() {
    setBusy(true); setError(""); setMessage("");
    try {
      const summary = await window.paperweave.createBackup();
      setBackup(summary);
      setDestination(null);
      setMessage("备份完成，清单与文件校验值已写入。");
    } catch (e) { setError(`备份失败：${String(e)}。当前题库未被改动。`); }
    finally { setBusy(false); }
  }

  async function chooseSource() {
    setError(""); setMessage(""); setSource(null); setConfirming(false);
    try {
      const picked = await window.paperweave.chooseBackupSource();
      if (!picked) return;
      setSource(picked);
      setMessage("备份校验通过，请核对摘要后确认恢复。");
    } catch (e) { setError(`无法读取备份：${String(e)}`); }
  }

  async function restore() {
    setBusy(true); setError(""); setMessage(""); setConfirming(false);
    try {
      await window.paperweave.restoreBackup();
      setMessage("恢复准备完成，应用正在重启并在启动时切换题库。");
    } catch (e) {
      setError(`恢复失败：${String(e)}。当前题库未被替换。`);
      setBusy(false);
    }
  }

  return <main className="paper-app backup-app">
    <header className="paper-top">
      <div><h1>备份与恢复</h1><p>备份包含数据库快照、考试原卷、题目配图与组卷定稿 PDF；不包含模型密钥。</p></div>
      <div className="paper-actions"><button onClick={onBack} disabled={busy}>返回</button></div>
    </header>
    {message && <p role="status" className="paper-message">{message}</p>}
    {error && <p role="alert" className="error">{error} <button onClick={() => setError("")} disabled={busy}>关闭</button></p>}
    {busy && <p className="paper-message" role="status">备份或恢复进行中，暂不可编辑；其他页面的保存与提交会被拒绝。</p>}

    <div className="backup-grid">
      <section className="paper-panel" aria-label="创建备份">
        <h2>创建备份</h2>
        <p className="muted">备份期间暂停写入。目标文件夹已有同名备份时不会覆盖。</p>
        <div className="paper-actions">
          <button onClick={() => void chooseDestination()} disabled={busy}>选择备份位置</button>
          <button className="primary" onClick={() => void create()} disabled={busy || destination === null}>确认备份</button>
        </div>
        {destination && <p>已选择位置：{destination}</p>}
        {backup && <section aria-label="备份结果"><h3>最近一次备份</h3><Summary value={backup} /></section>}
      </section>

      <section className="paper-panel" aria-label="从备份恢复">
        <h2>从备份恢复</h2>
        <p className="muted">恢复会替换当前题库并在切换后重启应用；校验或切换失败时保留原题库。</p>
        <button onClick={() => void chooseSource()} disabled={busy}>选择备份目录</button>
        {source && <section aria-label="待恢复备份">
          <h3>待恢复备份</h3>
          <Summary value={source} />
          <button className="primary" onClick={() => setConfirming(true)} disabled={busy}>恢复并重启</button>
        </section>}
        {confirming && <section role="alertdialog" aria-label="确认恢复备份" className="backup-confirm">
          <p>恢复会关闭当前题库，把它替换为所选备份，然后重启应用。当前题库在重开验证成功前保留在临时目录中。</p>
          <div className="paper-actions">
            <button className="primary" onClick={() => void restore()} disabled={busy}>确认恢复并重启</button>
            <button onClick={() => setConfirming(false)} disabled={busy}>取消</button>
          </div>
        </section>}
      </section>
    </div>
  </main>;
}
