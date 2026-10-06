import { useState } from "react";
import { Captions } from "./Captions.tsx";
import { ChangeList } from "./ChangeList.tsx";
import { EvidencePanel } from "./EvidencePanel.tsx";
import { evidenceOf } from "./evidence.ts";
import { IntakeNotice } from "./IntakeNotice.tsx";
import { MapView } from "./MapView.tsx";
import { useIntakeNotice } from "./useIntakeNotice.ts";
import { useLiveFeed } from "./useLiveFeed.ts";

export function App() {
  const { snapshot, speaking, intake } = useLiveFeed();
  const intakeNoticeText = useIntakeNotice(intake);
  // 選んだノードの ID だけを持つ。表示内容は描画のたびに最新のスナップショットから導く
  const [selectedId, setSelectedId] = useState<string | null>(null);
  if (!snapshot) return <p className="waiting">サーバーを待っています</p>;
  return (
    <div className="layout">
      <div className="map">
        <MapView snapshot={snapshot} selectedId={selectedId} onSelect={setSelectedId} />
        <Captions speaking={speaking} />
        <IntakeNotice text={intakeNoticeText} />
      </div>
      <div className="side">
        <EvidencePanel selectedId={selectedId} evidence={selectedId === null ? null : evidenceOf(snapshot, selectedId)} />
        <ChangeList changes={snapshot.changes} onSelect={setSelectedId} />
      </div>
    </div>
  );
}
