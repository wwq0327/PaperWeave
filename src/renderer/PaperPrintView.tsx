import { useEffect, useMemo, useRef, useState } from "react";
import katex from "katex";
import type { VolumePaper } from "../shared/paper-layout";
import type { QuestionBlock } from "../shared/question";

type RenderRun = { type: "text"; text: string; style: string } | { type: "formula"; latex: string } | { type: "reference"; fallback: string };
type RenderBlock =
  | { type: "paragraph"; runs: RenderRun[] }
  | { type: "formula"; latex: string }
  | { type: "image"; id: string; alt: string; figureId?: string }
  | { type: "table"; rows: string[][] };

function Formula({ latex, display = false }: { latex: string; display?: boolean }) {
  if (!latex) return <span data-invalid-formula>（空公式）</span>;
  try {
    return <span dangerouslySetInnerHTML={{ __html: katex.renderToString(latex, { displayMode: display, throwOnError: true, trust: false, strict: "error" }) }} />;
  } catch {
    return <span role="alert" data-invalid-formula>公式无法渲染</span>;
  }
}

function StyledText({ text, style }: { text: string; style: string }) {
  if (style === "粗体") return <strong>{text}</strong>;
  if (style === "斜体") return <em>{text}</em>;
  if (style === "下划线") return <u>{text}</u>;
  if (style === "上标") return <sup>{text}</sup>;
  if (style === "下标") return <sub>{text}</sub>;
  return <>{text}</>;
}

function Blocks({ blocks, images, figureLabel }: { blocks: QuestionBlock[]; images: Record<string, string>; figureLabel: (figureId: string | undefined) => string | undefined }) {
  return <>
    {(blocks as RenderBlock[]).map((block, index) => {
      if (block.type === "paragraph") return <p key={index} className="paper-text">{block.runs.map((run, i) =>
        run.type === "text" ? <StyledText key={i} text={run.text} style={run.style} /> :
        run.type === "formula" ? <Formula key={i} latex={run.latex} /> : <span key={i}>{run.fallback}</span>)}</p>;
      if (block.type === "formula") return <div key={index} className="paper-formula"><Formula latex={block.latex} display /></div>;
      if (block.type === "image") {
        const label = figureLabel(block.figureId);
        return <figure key={index} className="paper-figure">{images[block.id] ? <img src={images[block.id]} alt={block.alt || "题图"} /> : <span role="alert">图片未加载</span>}{label && <figcaption>{label}</figcaption>}</figure>;
      }
      return <div key={index} className="table-scroll"><table><tbody>{block.rows.map((row, y) => <tr key={y}>{row.map((cell, x) => <td key={x}>{cell}</td>)}</tr>)}</tbody></table></div>;
    })}
  </>;
}

function collectImageIds(paper: VolumePaper): string[] {
  const ids = new Set<string>();
  const visit = (blocks: QuestionBlock[]) => {
    for (const block of blocks) if (block.type === "image") ids.add(block.id);
  };
  for (const item of paper.sections.flatMap((section) => section.items)) {
    visit(item.stem);
    for (const sub of item.subQuestions) {
      visit(sub.prompt);
      for (const option of sub.options) visit(option.content);
      if (sub.answers) for (const answer of sub.answers) visit(answer.blocks);
      if (sub.explanation) visit(sub.explanation);
    }
  }
  for (const material of paper.materials) if (material.content) visit(material.content as QuestionBlock[]);
  return [...ids];
}

export default function PaperPrintView({ paper, onReady, onCancel }: { paper: VolumePaper; onReady: () => void; onCancel: () => void }) {
  const imageIds = useMemo(() => collectImageIds(paper), [paper]);
  const [images, setImages] = useState<Record<string, string>>({});
  const [failed, setFailed] = useState<string[]>([]);
  const fired = useRef(false);

  useEffect(() => {
    let live = true;
    setImages({});
    setFailed([]);
    fired.current = false;
    Promise.all(imageIds.map(async (id) => {
      try {
        return [id, await window.paperweave.getImage(id)] as const;
      } catch {
        return [id, ""] as const;
      }
    })).then((entries) => {
      if (!live) return;
      setImages(Object.fromEntries(entries.filter(([, url]) => url)));
      setFailed(entries.filter(([, url]) => !url).map(([id]) => id));
    }).catch(() => { if (live) setFailed([...imageIds]); });
    return () => { live = false; };
  }, [imageIds]);

  const ready = imageIds.every((id) => images[id]) && failed.length === 0;
  useEffect(() => {
    if (!ready || fired.current) return;
    fired.current = true;
    void (async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      await document.fonts.ready;
      for (const image of document.querySelectorAll<HTMLImageElement>(".paper-sheet img")) await image.decode().catch(() => undefined);
      onReady();
    })();
  }, [ready, onReady]);

  const figureLabels = new Map(paper.figures.map((figure) => [`${figure.itemId}\u0000${figure.figureId}`, figure.label]));
  const materials = new Map(paper.materials.map((material) => [material.label, material]));
  const printed = new Set<string>();

  return <main className="preview paper-print">
    <div className="paper-status no-print">
      {failed.length > 0 ? <p role="alert">图片无法读取，不能生成 PDF。可取消后检查附件。</p> : <p>{ready ? "正在生成 PDF…" : "正在准备图片与字体…"}</p>}
      <button onClick={onCancel}>取消定稿</button>
    </div>
    <article className="paper-sheet" aria-label={`${paper.paper.title}${paper.paper.subject}`}>
      <header className="paper-head">
        <h1>{paper.paper.title}</h1>
        <p>{paper.paper.stage} · {paper.paper.subject} · {paper.paper.grade}　总分 {paper.totalScore} 分</p>
      </header>
      {paper.sections.map((section) => <section key={`${section.number}-${section.title}`} className="paper-section">
        <h2>{section.number}、{section.title}</h2>
        {section.items.map((item) => {
          const figureLabel = (figureId: string | undefined) => figureId ? figureLabels.get(`${item.id}\u0000${figureId}`) : undefined;
          const itemMaterials = item.materialLabels.flatMap((label) => {
            if (printed.has(label)) return [];
            printed.add(label);
            const material = materials.get(label);
            return material ? [{ label, material }] : [];
          });
          return <article key={item.id} className="paper-item" aria-label={`第 ${item.number} 题`}>
            {itemMaterials.map(({ label, material }) => <section key={label} className="paper-material" aria-label={label}>
              <h3>{label}{material.title ? `　${material.title}` : ""}</h3>
              {material.content ? <Blocks blocks={material.content as QuestionBlock[]} images={images} figureLabel={() => undefined} /> : <p role="alert">材料缺失</p>}
            </section>)}
            <header className="paper-item-head"><strong>第 {item.number} 题（{item.score} 分）</strong></header>
            <Blocks blocks={item.stem} images={images} figureLabel={figureLabel} />
            {item.subQuestions.map((sub) => <div key={sub.id} className="paper-sub">
              <p className="paper-sub-label">{sub.label}</p>
              <Blocks blocks={sub.prompt} images={images} figureLabel={figureLabel} />
              {sub.options.length > 0 && <ol className="paper-options">{sub.options.map((option) => <li key={option.label}><span>{option.label}. </span><Blocks blocks={option.content} images={images} figureLabel={figureLabel} /></li>)}</ol>}
              {item.blankSpace !== "none" && <div className={`paper-blank paper-blank-${item.blankSpace}`} aria-label="答题留白" />}
              {sub.answers && sub.answers.length > 0 && <section className="paper-answer" aria-label={`${sub.label} 参考答案`}>
                <h4>参考答案</h4>
                {sub.answers.map((answer, index) => <Blocks key={index} blocks={answer.blocks} images={images} figureLabel={figureLabel} />)}
              </section>}
              {sub.explanation && sub.explanation.length > 0 && <section className="paper-explanation" aria-label={`${sub.label} 解析`}>
                <h4>解析</h4>
                <Blocks blocks={sub.explanation} images={images} figureLabel={figureLabel} />
              </section>}
              {sub.scoring && sub.scoring.length > 0 && <section className="paper-scoring" aria-label={`${sub.label} 评分点`}>
                <h4>评分点</h4>
                <ul>{sub.scoring.map((point) => <li key={point.id}>{point.description}（{point.score} 分）</li>)}</ul>
              </section>}
            </div>)}
            {item.scoringState === "answerOnly" && <p className="paper-answer-only">本卷评分待补，仅提供参考答案。</p>}
          </article>;
        })}
      </section>)}
    </article>
  </main>;
}
