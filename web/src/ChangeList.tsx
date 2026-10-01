import type { ChangeEntry } from "../../server/src/core/index.ts";
import { formatClock } from "./changes.ts";

// 渡された記録を新しい順に描くだけ（表示専用）。
export function ChangeList({ changes }: { changes: ChangeEntry[] }) {
  return (
    <aside className="changes" aria-labelledby="changes-heading">
      <h2 id="changes-heading">変わったこと</h2>
      <ul>
        {[...changes].reverse().map((c) => (
          <li key={`${c.round}-${c.node}-${c.change}`} className="changes__item">
            <time className="changes__time">{formatClock(c.at)}</time>
            <span className="changes__type">{c.change}</span>
            <span className="changes__kind">{c.kind}</span>
            <span className="changes__text">{c.text}</span>
          </li>
        ))}
      </ul>
    </aside>
  );
}
