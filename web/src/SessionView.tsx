import { useHotkey } from "@tanstack/react-hotkeys";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
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
import { INITIAL_VIEWING, nextCameraOrder, reduceViewing, type CameraOrder, type ArrowDir, type ViewingEvent, type ViewingScope, type ViewingState, type ViewKey, type VisibleTree } from "./viewing.ts";
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

// ノードを選ぶ矢印。定数で、hook を呼ぶ数と順序は変わらない
const ARROW_HOTKEYS = [
  ["ArrowLeft", "left"],
  ["ArrowRight", "right"],
  ["ArrowUp", "up"],
  ["ArrowDown", "down"],
] as const satisfies readonly (readonly [string, ArrowDir])[];

// 見返しの外枠に渡す、見る状態（字幕・右の列の出し入れ）と、C・E と同じ出来事を送る関数
export type ReviewOverlay = { captionsHidden: boolean; sideHidden: boolean; onCaptions: () => void; onSide: () => void };

// 渡されたスナップショット・字幕の内容・取り込みの状態から、マップ・字幕・右の列を組み立てる（接続は持たない）。
// 取り込みの状態を渡さなければ、知らせは出ない。
// review を渡すと見返し。timeMoves は、時刻を動かすたびに増える数。frame は、画面全体（session）を操作の行などで包む関数。省略するとライブ。
export function SessionView({
  snapshot,
  speaking,
  intake,
  review,
}: {
  snapshot: Snapshot;
  speaking: Speaking;
  intake?: IntakeStatus;
  review?: { timeMoves: number; frame?: (session: ReactNode, overlay: ReviewOverlay) => ReactNode };
}) {
  const scope: ViewingScope = review ? "review" : "live";
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
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
  // 見返しの 10 秒の計り直しの基準。E・C（右の列・字幕の出し入れ）以外の出来事の後にだけ更新する
  const [cameraStamp, setCameraStamp] = useState<ViewingState>(INITIAL_VIEWING);
  const onTree = useCallback((tree: VisibleTree) => {
    lastTree.current = tree;
  }, []);
  const dispatch = useCallback((event: ViewingEvent, tree: VisibleTree) => {
    lastTree.current = tree;
    const out = reduceViewing(viewingRef.current, event, tree, scopeRef.current);
    viewingRef.current = out.state;
    setViewing(out.state);
    if (event.type !== "side" && event.type !== "captions" && event.type !== "select") setCameraStamp(out.state);
    const next = nextCameraOrder(cameraRef.current, out.camera, shownSeq.current);
    cameraRef.current = next;
    setCamera(next);
  }, []);
  const treeNow = () => lastTree.current ?? { ids: [], targets: {}, parents: {}, currentTopic: snapshot.currentTopic };
  // 選んだノードの ID だけを見る状態から取る。表示内容は描画のたびに最新のスナップショットから導く
  const selectedId = viewing.selection?.id ?? null;
  const select = (id: string) => dispatch({ type: "select", id }, treeNow());
  const treeNowRef = useRef(treeNow);
  treeNowRef.current = treeNow;
  // 見返しで止めている間だけ、最後の人の操作から 10 秒を計る。
  // E・C 以外の出来事の後の状態を cameraStamp に持ち、依存に入れる。E・C では変わらないので、計り直さない
  const isReview = review !== undefined;
  useEffect(() => {
    if (!isReview || cameraStamp.mode !== "manual") return;
    const timer = setTimeout(() => dispatch({ type: "idle" }, treeNowRef.current()), REVIEW_IDLE_MS);
    return () => clearTimeout(timer);
  }, [isReview, cameraStamp, dispatch]);
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
      lastTree.current ?? { ids: [], targets: {}, parents: {}, currentTopic: snapshot.currentTopic },
    ),
  );
  // VIEW_HOTKEYS は定数で、hook を呼ぶ数と順序は変わらない
  for (const [hotkey, key] of VIEW_HOTKEYS) {
    useHotkey(hotkey, (e) => {
      dispatch({ type: "key", key, meta: e.metaKey, ctrl: e.ctrlKey, alt: e.altKey }, treeNow());
    });
  }
  // Shift + 矢印は pan に使うので、Shift 付きでは選ばない
  for (const [hotkey, dir] of ARROW_HOTKEYS) {
    useHotkey(hotkey, (e) => {
      if (e.shiftKey) return;
      dispatch({ type: "arrow", dir, meta: e.metaKey, ctrl: e.ctrlKey, alt: e.altKey }, treeNow());
    });
  }
  useHotkey("?", (e) => {
    dispatch({ type: "keyList", meta: e.metaKey, ctrl: e.ctrlKey, alt: e.altKey }, treeNow());
  });
  useHotkey("E", (e) => {
    dispatch({ type: "side", meta: e.metaKey, ctrl: e.ctrlKey, alt: e.altKey }, treeNow());
  });
  useHotkey("C", (e) => {
    dispatch({ type: "captions", meta: e.metaKey, ctrl: e.ctrlKey, alt: e.altKey }, treeNow());
  });
  const overlay: ReviewOverlay = {
    captionsHidden: viewing.captionsHidden === true,
    sideHidden: viewing.sideHidden === true,
    onCaptions: () => dispatch({ type: "captions", meta: false, ctrl: false, alt: false }, treeNow()),
    onSide: () => dispatch({ type: "side", meta: false, ctrl: false, alt: false }, treeNow()),
  };
  const layout = (
    <div className="layout">
      <div className="map">
        <MapView snapshot={snapshot} selectedId={selectedId} onSelect={select} viewing={viewing} camera={camera} onViewingEvent={dispatch} onTree={onTree} />
        <ViewingNotice manual={viewing.mode === "manual"} overview={viewing.mode === "overview"} />
        {viewing.keyList && <KeyList review={isReview} />}
      </div>
      {/* 字幕と取り込みの一言は .map の外（.layout 直下）に置く。列を出し入れしても窓の横幅の中央から動かさない */}
      {!viewing.captionsHidden && <Captions speaking={speaking} />}
      {intake !== undefined && <IntakeNoticeOf status={intake} />}
      {!viewing.sideHidden && (
        <div className="side">
          <EvidencePanel selectedId={selectedId} evidence={selectedId === null ? null : evidenceOf(snapshot, selectedId)} />
          <ChangeList changes={snapshot.changes} onSelect={select} />
        </div>
      )}
    </div>
  );
  return review?.frame ? review.frame(layout, overlay) : layout;
}

// hook は条件付きで呼べないため、状態を渡されたときだけ描く子の部品に閉じ込める。
function IntakeNoticeOf({ status }: { status: IntakeStatus }) {
  return <IntakeNotice text={useIntakeNotice(status)} />;
}
