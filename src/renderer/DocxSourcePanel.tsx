import { useEffect, useRef, useState } from "react";
import { messageOf } from "./messages";

interface Props {
  fileId: string;
  unit: number;
  disabled?: boolean;
  onUnitChange: (unit: number) => void;
  onError: (message: string) => void;
}

interface DocxUnit {
  unit: number;
  text: string;
}

/**
 * DOCX 原卷左栏文字视图：按文档段落序号呈现提取文字。
 * DOCX 没有 Word 分页概念，这里的编号是段落序号；题图只以占位标记保留。
 */
export default function DocxSourcePanel({ fileId, unit, disabled = false, onUnitChange, onError }: Props) {
  const [units, setUnits] = useState<DocxUnit[]>([]);
  const [hasText, setHasText] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const activeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setHasText(null);
    setUnits([]);
    onError("");
    window.paperweave.getExamFileText(fileId)
      .then((result) => {
        if (!live) return;
        const next = [...result.pages]
          .filter((entry) => Number.isInteger(entry.page) && entry.page >= 1)
          .sort((a, b) => a.page - b.page)
          .map((entry) => ({ unit: entry.page, text: entry.text }));
        setUnits(next);
        setHasText(result.hasText);
      })
      .catch((error: unknown) => {
        if (live) onError(`读取 DOCX 文字失败：${messageOf(error)}`);
      })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
    // onError 由父组件以稳定 setter 传入，不参与重载判定。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileId]);

  useEffect(() => {
    if (loading) return;
    activeRef.current?.scrollIntoView({ block: "center" });
  }, [unit, loading, units]);

  const currentUnit = Number.isInteger(unit) && unit >= 1 ? unit : 1;

  return <aside className="intake-left docx-source" aria-label="DOCX 原卷文字">
    <header><h2>DOCX 原卷 · 第 {currentUnit} 段</h2></header>
    <p className="muted">DOCX 以段落文字呈现；Word 版式与题图裁切暂未支持，题图以占位标记。</p>
    {loading
      ? <p className="muted">正在读取 DOCX 文字…</p>
      : hasText === false || units.length === 0
        ? <p role="status">DOCX 没有可提取文字，无法准备整卷任务。</p>
        : <ol className="docx-source-list">
          {units.map((entry) => {
            const active = entry.unit === currentUnit;
            return <li key={entry.unit}>
              <button
                ref={active ? activeRef : undefined}
                type="button"
                className={`docx-source-unit${active ? " active" : ""}`}
                aria-current={active ? "true" : undefined}
                disabled={disabled}
                onClick={() => onUnitChange(entry.unit)}
              >
                <span className="docx-source-label">第 {entry.unit} 段</span>
                <span className={`docx-source-text${entry.text.trim() ? "" : " muted"}`}>{entry.text.trim() ? entry.text : "（空段落）"}</span>
              </button>
            </li>;
          })}
        </ol>}
  </aside>;
}
