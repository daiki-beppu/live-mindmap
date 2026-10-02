import { captionsOf } from "./captions.ts";
import type { Speaking } from "./useLiveFeed.ts";

// いま話している文字（反映前の発言と途中結果）を、マップの下端に字幕として重ねる。マップのデータには入れない。
// 文ごとに行を分け、新しい文は次の行に出す。古い文は行ごと消える。
export function Captions({ speaking }: { speaking: Speaking }) {
  const captions = captionsOf(speaking);
  if (captions.length === 0) return null;
  return (
    <div className="captions" aria-live="polite">
      {captions.map((c) => (
        <div key={c.track} className="captions__block">
          <span className="captions__track">{c.track}</span>
          <div className="captions__lines">
            {c.lines.map((line, i) => (
              <p key={i} className="captions__line">
                {line}
              </p>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
