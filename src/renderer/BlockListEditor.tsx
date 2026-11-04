import { useEffect, useState } from "react";
import type { IntakeBlock, IntakeReferenceOption } from "../shared/intake";

const referenceLabels = { subQuestion: "小问", material: "材料", figure: "图" } as const;
const referenceKey = (option: IntakeReferenceOption): string => `${option.kind}:${option.targetId}`;
const blockKindLabel = (block: IntakeBlock): string =>
  block.kind === "text" ? "文字" : block.kind === "formula" ? "公式" : block.kind === "image" ? "图片" : block.kind === "table" ? "表格" : "引用";

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
  if (failed) return <span role="alert">图片无法读取，请重新裁取。</span>;
  return url ? <img src={url} alt={alt || "裁图"} /> : <span className="muted">正在读取图片…</span>;
}

interface Props {
  label: string;
  blocks: IntakeBlock[];
  disabled?: boolean;
  onCrop?: () => void;
  referenceOptions?: IntakeReferenceOption[];
  onChange: (blocks: IntakeBlock[]) => void;
}

/** 题目内容块编辑器：文字（含 $公式$）、独立公式、裁图、表格与结构化引用，保留顺序。 */
export default function BlockListEditor({ label, blocks, disabled = false, onCrop, referenceOptions = [], onChange }: Props) {
  const [referenceChoice, setReferenceChoice] = useState("");
  const chosen = referenceOptions.find((option) => referenceKey(option) === referenceChoice) ?? referenceOptions[0];
  const targetOf = (block: Extract<IntakeBlock, { kind: "reference" }>) =>
    referenceOptions.find((option) => option.kind === block.refKind && option.targetId === block.targetId);
  const update = (index: number, block: IntakeBlock) => onChange(blocks.map((entry, i) => i === index ? block : entry));
  const move = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= blocks.length) return;
    const next = [...blocks];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  };

  return <fieldset className="intake-blocks" aria-label={label}>
    <legend>{label}</legend>
    {blocks.length === 0 && <p className="muted">（空）</p>}
    {blocks.map((block, index) => <div className="intake-block" key={index}>
      <header className="paper-inline">
        <span className="paper-state">{blockKindLabel(block)}</span>
        <button onClick={() => move(index, -1)} disabled={disabled || index === 0}>上移</button>
        <button onClick={() => move(index, 1)} disabled={disabled || index === blocks.length - 1}>下移</button>
        <button onClick={() => onChange(blocks.filter((_, i) => i !== index))} disabled={disabled}>删除</button>
      </header>
      {block.kind === "text" && <textarea aria-label={`${label} 文字 ${index + 1}`} value={block.text} disabled={disabled} onChange={(event) => update(index, { kind: "text", text: event.target.value })} placeholder="文字；行内公式写 $x^2$，独立公式单独一行写 $$…$$" />}
      {block.kind === "formula" && <label>LaTeX<input aria-label={`${label} 公式 ${index + 1}`} value={block.latex} disabled={disabled} onChange={(event) => update(index, { kind: "formula", latex: event.target.value })} /></label>}
      {block.kind === "reference" && <div className="intake-reference">
        <p><span className="paper-state">{referenceLabels[block.refKind]}</span> {targetOf(block)?.label ?? `目标失效（${block.targetId}）`}</p>
        <label>回退文字<input aria-label={`${label} 引用回退 ${index + 1}`} value={block.fallback} disabled={disabled} onChange={(event) => update(index, { ...block, fallback: event.target.value })} /></label>
        {targetOf(block) === undefined && <p role="alert">引用目标已失效，请删除或重新插入。</p>}
      </div>}
      {block.kind === "image" && <div className="intake-figure">
        <AttachmentImage id={block.id} alt={block.alt} />
        <label>图片说明<input aria-label={`${label} 图片说明 ${index + 1}`} value={block.alt} disabled={disabled} onChange={(event) => update(index, { kind: "image", id: block.id, alt: event.target.value, ...(block.figureId === undefined ? {} : { figureId: block.figureId }) })} /></label>
        <label>图标识<input aria-label={`${label} 图标识 ${index + 1}`} value={block.figureId ?? ""} disabled={disabled} placeholder="可选；供引用使用" onChange={(event) => update(index, { kind: "image", id: block.id, alt: block.alt, ...(event.target.value.trim() ? { figureId: event.target.value } : {}) })} /></label>
      </div>}
      {block.kind === "table" && <div className="intake-table">
        <table><tbody>{block.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, columnIndex) => <td key={columnIndex}><input aria-label={`${label} 表格 ${index + 1} 第 ${rowIndex + 1} 行第 ${columnIndex + 1} 列`} value={cell} disabled={disabled} onChange={(event) => update(index, { kind: "table", rows: block.rows.map((entry, y) => y === rowIndex ? entry.map((value, x) => x === columnIndex ? event.target.value : value) : entry) })} /></td>)}<td><button onClick={() => update(index, { kind: "table", rows: block.rows.filter((_, y) => y !== rowIndex) })} disabled={disabled || block.rows.length === 1}>删除行</button></td></tr>)}</tbody></table>
        <div className="toolbar">
          <button onClick={() => update(index, { kind: "table", rows: [...block.rows, block.rows[0].map(() => "")] })} disabled={disabled || block.rows.length >= 30}>添加行</button>
          <button onClick={() => update(index, { kind: "table", rows: block.rows.map((row) => [...row, ""]) })} disabled={disabled || block.rows[0].length >= 10}>添加列</button>
        </div>
      </div>}
    </div>)}
    <div className="toolbar">
      <button onClick={() => onChange([...blocks, { kind: "text", text: "" }])} disabled={disabled}>添加文字</button>
      <button onClick={() => onChange([...blocks, { kind: "formula", latex: "" }])} disabled={disabled}>添加公式</button>
      {onCrop && <button onClick={onCrop} disabled={disabled}>插入裁图</button>}
      <button onClick={() => onChange([...blocks, { kind: "table", rows: [["", ""], ["", ""]] }])} disabled={disabled}>添加表格</button>
      {referenceOptions.length > 0 && <>
        <select aria-label={`${label} 引用目标`} value={chosen === undefined ? "" : referenceKey(chosen)} disabled={disabled} onChange={(event) => setReferenceChoice(event.target.value)}>
          {referenceOptions.map((option) => <option key={referenceKey(option)} value={referenceKey(option)}>{referenceLabels[option.kind]}：{option.label}</option>)}
        </select>
        <button disabled={disabled || chosen === undefined} onClick={() => {
          if (chosen === undefined) return;
          onChange([...blocks, { kind: "reference", refKind: chosen.kind, targetId: chosen.targetId, fallback: chosen.label }]);
        }}>插入引用</button>
      </>}
    </div>
  </fieldset>;
}
