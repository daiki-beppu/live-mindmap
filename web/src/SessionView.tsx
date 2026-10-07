import { useState } from "react";
import type { Snapshot } from "../../server/src/core/index.ts";
import { Captions } from "./Captions.tsx";
import { ChangeList } from "./ChangeList.tsx";
import { EvidencePanel } from "./EvidencePanel.tsx";
import { evidenceOf } from "./evidence.ts";
import type { IntakeStatus } from "./intake.ts";
import { IntakeNotice } from "./IntakeNotice.tsx";
import type { Speaking } from "./liveFeed.ts";
import { MapView } from "./MapView.tsx";
import { useIntakeNotice } from "./useIntakeNotice.ts";

// 渡されたスナップショット・字幕の内容・取り込みの状態から、マップ・字幕・右の列を組み立てる（接続は持たない）。
// 取り込みの状態を渡さなければ、知らせは出ない。
export function SessionView({ snapshot, speaking, intake }: { snapshot: Snapshot; speaking: Speaking; intake?: IntakeStatus }) {
  // 選んだノードの ID だけを持つ。表示内容は描画のたびに最新のスナップショットから導く
  const [selectedId, setSelectedId] = useState<string | null>(null);
  return (
    <div className="layout">
      <div className="map">
        <MapView snapshot={snapshot} selectedId={selectedId} onSelect={setSelectedId} />
        <Captions speaking={speaking} />
        {intake !== undefined && <IntakeNoticeOf status={intake} />}
      </div>
      <div className="side">
        <EvidencePanel selectedId={selectedId} evidence={selectedId === null ? null : evidenceOf(snapshot, selectedId)} />
        <ChangeList changes={snapshot.changes} onSelect={setSelectedId} />
      </div>
    </div>
  );
}

// hook は条件付きで呼べないため、状態を渡されたときだけ描く子の部品に閉じ込める。
function IntakeNoticeOf({ status }: { status: IntakeStatus }) {
  return <IntakeNotice text={useIntakeNotice(status)} />;
}
