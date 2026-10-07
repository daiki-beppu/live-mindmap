import { useHotkey } from "@tanstack/react-hotkeys";
import { useCallback, useRef, useState } from "react";
import type { Snapshot } from "../../server/src/core/index.ts";
import { Captions } from "./Captions.tsx";
import { ChangeList } from "./ChangeList.tsx";
import { EvidencePanel } from "./EvidencePanel.tsx";
import { evidenceOf } from "./evidence.ts";
import type { IntakeStatus } from "./intake.ts";
import { IntakeNotice } from "./IntakeNotice.tsx";
import type { Speaking } from "./liveFeed.ts";
import { MapView } from "./MapView.tsx";
import { useImeKeyRedispatch } from "./useImeKeyRedispatch.ts";
import { useIntakeNotice } from "./useIntakeNotice.ts";
import { INITIAL_VIEWING, reduceViewing, type CameraCommand, type ViewingEvent, type ViewingState, type ViewKey, type VisibleTree } from "./viewing.ts";
import { ViewingNotice } from "./ViewingNotice.tsx";

// 倍率・位置を変えるキー。Shift なしの矢印はノードの選択に空けておく。
// JIS の ^ や US の + で拡大が発火するのはライブラリの挙動で、止めない
const VIEW_HOTKEYS = [
  ["=", "="],
  ["Shift+=", "="],
  ["-", "-"],
  ["0", "0"],
  ["F", "F"],
  ["Shift+ArrowLeft", "Shift+ArrowLeft"],
  ["Shift+ArrowRight", "Shift+ArrowRight"],
  ["Shift+ArrowUp", "Shift+ArrowUp"],
  ["Shift+ArrowDown", "Shift+ArrowDown"],
] as const satisfies readonly (readonly [string, ViewKey])[];

// 渡されたスナップショット・字幕の内容・取り込みの状態から、マップ・字幕・右の列を組み立てる（接続は持たない）。
// 取り込みの状態を渡さなければ、知らせは出ない。
export function SessionView({ snapshot, speaking, intake }: { snapshot: Snapshot; speaking: Speaking; intake?: IntakeStatus }) {
  // 選んだノードの ID だけを持つ。表示内容は描画のたびに最新のスナップショットから導く
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // 見る状態とカメラへの指示。ライブも見返しも、この1つのインスタンスが持つ
  const [viewing, setViewing] = useState<ViewingState>(INITIAL_VIEWING);
  const [camera, setCamera] = useState<{ command: CameraCommand; seq: number }>({ command: { type: "follow" }, seq: 0 });
  // マップから最後に届いた見えている木。Esc の判断に使う
  const lastTree = useRef<VisibleTree | null>(null);
  const viewingRef = useRef(viewing);
  const dispatch = useCallback((event: ViewingEvent, tree: VisibleTree) => {
    lastTree.current = tree;
    const out = reduceViewing(viewingRef.current, event, tree);
    viewingRef.current = out.state;
    setViewing(out.state);
    setCamera((c) => ({ command: out.camera, seq: c.seq + 1 }));
  }, []);
  useImeKeyRedispatch();
  useHotkey("Escape", (e) =>
    dispatch(
      { type: "escape", meta: e.metaKey, ctrl: e.ctrlKey, alt: e.altKey },
      lastTree.current ?? { ids: [], targets: {}, currentTopic: snapshot.currentTopic },
    ),
  );
  const keyTree = () => lastTree.current ?? { ids: [], targets: {}, currentTopic: snapshot.currentTopic };
  // VIEW_HOTKEYS は定数で、hook を呼ぶ数と順序は変わらない
  for (const [hotkey, key] of VIEW_HOTKEYS) {
    useHotkey(hotkey, (e) => {
      dispatch({ type: "key", key, meta: e.metaKey, ctrl: e.ctrlKey, alt: e.altKey }, keyTree());
    });
  }
  return (
    <div className="layout">
      <div className="map">
        <MapView snapshot={snapshot} selectedId={selectedId} onSelect={setSelectedId} viewing={viewing} camera={camera} onViewingEvent={dispatch} />
        <ViewingNotice manual={viewing.mode === "manual"} overview={viewing.mode === "overview"} />
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
