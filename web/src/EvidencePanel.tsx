import { formatClock } from "./changes.ts";
import type { Evidence } from "./evidence.ts";

// 渡された内容を描くだけ（表示専用）。状態を持つのは論点と案だけ。
export function EvidencePanel({ selectedId, evidence }: { selectedId: string | null; evidence: Evidence | null }) {
  return (
    <section className="evidence" aria-labelledby="evidence-heading">
      <h2 id="evidence-heading">根拠</h2>
      {selectedId === null ? (
        <p className="evidence__empty">ノードを選ぶと、根拠の発言が出ます</p>
      ) : evidence === null ? (
        <p className="evidence__empty">選んだノードは今のマップにありません</p>
      ) : (
        <Body evidence={evidence} />
      )}
    </section>
  );
}

function Body({ evidence: { node, remarks } }: { evidence: Evidence }) {
  const status = node.kind === "論点" ? node.pointStatus : node.kind === "案" ? node.planStatus : undefined;
  return (
    <>
      <p className="evidence__meta">
        <span className="evidence__kind">{node.kind}</span>
        {status && <span className="evidence__status">{status}</span>}
      </p>
      <p className="evidence__text">{node.text}</p>
      {remarks.length === 0 ? (
        <p className="evidence__empty">根拠の発言はありません</p>
      ) : (
        <ul>
          {remarks.map((r) => (
            <li key={r.id} className="evidence__remark">
              <span className="evidence__time">
                {formatClock(r.start)}〜{formatClock(r.end)}
              </span>
              <span className="evidence__track">{r.track}</span>
              <span className="evidence__remark-text">{r.text}</span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
