import { useCallback, useState } from "react";
import { CAPTURE_OVERFLOW_ATTRIBUTE, CAPTURE_READY_ATTRIBUTE } from "../../server/src/core/capture.ts";
import type { Snapshot } from "../../server/src/core/index.ts";
import { MapView } from "./MapView.tsx";
import { NO_SPEAKING } from "./useLiveFeed.ts";

const NOT_SELECTABLE = () => {};

// map.png の撮影用の表示。サーバーが渡したスナップショットのマップだけを描く。
// 仮のノード（speaking なし）・右の列・変わったノードの強調は出さない。
// 全体を収め終えたら ready、収められなかったら overflow の属性で、サーバーへ結果を知らせる。
export function CaptureView({ snapshot }: { snapshot: Snapshot }) {
  const [fitsAll, setFitsAll] = useState<boolean | null>(null);
  const onFitted = useCallback((fits: boolean) => setFitsAll(fits), []);
  const attribute = fitsAll === null ? null : fitsAll ? CAPTURE_READY_ATTRIBUTE : CAPTURE_OVERFLOW_ATTRIBUTE;
  return (
    <div className="capture" {...(attribute ? { [attribute]: "" } : {})}>
      <MapView snapshot={snapshot} speaking={NO_SPEAKING} selectedId={null} onSelect={NOT_SELECTABLE} still onFitted={onFitted} />
    </div>
  );
}
