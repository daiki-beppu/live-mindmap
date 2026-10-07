import { useHotkey } from "@tanstack/react-hotkeys";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Snapshot } from "../../server/src/core/index.ts";
import { Captions } from "./Captions.tsx";
import { ChangeList } from "./ChangeList.tsx";
import { EvidencePanel } from "./EvidencePanel.tsx";
import { evidenceOf } from "./evidence.ts";
import type { IntakeStatus } from "./intake.ts";
import { IntakeNotice } from "./IntakeNotice.tsx";
import type { Speaking } from "./liveFeed.ts";
import { KeyList } from "./KeyList.tsx";
import { MapView } from "./MapView.tsx";
import { useImeKeyRedispatch } from "./useImeKeyRedispatch.ts";
import { useIntakeNotice } from "./useIntakeNotice.ts";
import { INITIAL_VIEWING, nextCameraOrder, reduceViewing, type CameraOrder, type ViewingEvent, type ViewingScope, type ViewingState, type ViewKey, type VisibleTree } from "./viewing.ts";
import { ViewingNotice } from "./ViewingNotice.tsx";

// 見返しで、人が動かした後、触らずにこの時間がたつと自動のカメラに戻る
const REVIEW_IDLE_MS = 10_000;

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
// review を渡すと見返し。timeMoves は、時刻を動かすたびに増える数。省略するとライブ。
export function SessionView({
  snapshot,
  speaking,
  intake,
  review,
}: {
  snapshot: Snapshot;
  speaking: Speaking;
  intake?: IntakeStatus;
  review?: { timeMoves: number };
}) {
  const scope: ViewingScope = review ? "review" : "live";
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  // 選んだノードの ID だけを持つ。表示内容は描画のたびに最新のスナップショットから導く
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // 見る状態とカメラへの指示。ライブも見返しも、この1つのインスタンスが持つ
  const [viewing, setViewing] = useState<ViewingState>(INITIAL_VIEWING);
  const [camera, setCamera] = useState<CameraOrder>({ command: { type: "follow" }, seq: 0 });
  // 今の指示と、描画済みの番号。同じ更新内で続く出来事が、まだ描画されていない refocus を上書きしないための判断に使う
  const cameraRef = useRef(camera);
  const shownSeq = useRef(camera.seq);
  shownSeq.current = camera.seq;
  // マップから最後に届いた見えている木。Esc の判断に使う
  const lastTree = useRef<VisibleTree | null>(null);
  const viewingRef = useRef(viewing);
  const dispatch = useCallback((event: ViewingEvent, tree: VisibleTree) => {
    lastTree.current = tree;
    const out = reduceViewing(viewingRef.current, event, tree, scopeRef.current);
    viewingRef.current = out.state;
    setViewing(out.state);
    const next = nextCameraOrder(cameraRef.current, out.camera, shownSeq.current);
    cameraRef.current = next;
    setCamera(next);
  }, []);
  const treeNow = () => lastTree.current ?? { ids: [], targets: {}, currentTopic: snapshot.currentTopic };
  const treeNowRef = useRef(treeNow);
  treeNowRef.current = treeNow;
  // 見返しで止めている間だけ、最後の人の操作から 10 秒を計る。
  // 人の操作は新しい manual のオブジェクトを返し、それ以外の出来事は同じオブジェクトを返すので、viewing を依存に入れると人の操作でだけ計り直しになる
  const isReview = review !== undefined;
  useEffect(() => {
    if (!isReview || viewing.mode !== "manual") return;
    const timer = setTimeout(() => dispatch({ type: "idle" }, treeNowRef.current()), REVIEW_IDLE_MS);
    return () => clearTimeout(timer);
  }, [isReview, viewing, dispatch]);
  // 時刻を動かしたら送る。最初の描画では送らない
  const timeMoves = review?.timeMoves;
  const prevTimeMoves = useRef(timeMoves);
  useEffect(() => {
    if (timeMoves !== undefined && prevTimeMoves.current !== timeMoves) dispatch({ type: "timeMoved" }, treeNowRef.current());
    prevTimeMoves.current = timeMoves;
  }, [timeMoves, dispatch]);
  useImeKeyRedispatch();
  useHotkey("Escape", (e) =>
    dispatch(
      { type: "escape", meta: e.metaKey, ctrl: e.ctrlKey, alt: e.altKey },
      lastTree.current ?? { ids: [], targets: {}, currentTopic: snapshot.currentTopic },
    ),
  );
  // VIEW_HOTKEYS は定数で、hook を呼ぶ数と順序は変わらない
  for (const [hotkey, key] of VIEW_HOTKEYS) {
    useHotkey(hotkey, (e) => {
      dispatch({ type: "key", key, meta: e.metaKey, ctrl: e.ctrlKey, alt: e.altKey }, treeNow());
    });
  }
  useHotkey("?", (e) => {
    dispatch({ type: "keyList", meta: e.metaKey, ctrl: e.ctrlKey, alt: e.altKey }, treeNow());
  });
  return (
    <div className="layout">
      <div className="map">
        <MapView snapshot={snapshot} selectedId={selectedId} onSelect={setSelectedId} viewing={viewing} camera={camera} onViewingEvent={dispatch} />
        <ViewingNotice manual={viewing.mode === "manual"} overview={viewing.mode === "overview"} />
        {viewing.keyList && <KeyList />}
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
