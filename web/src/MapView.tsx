import {
  getNodesBounds,
  PanOnScrollMode,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useStore,
  useStoreApi,
  useViewport,
  type Edge,
  type Node,
  type NodeChange,
  type NodeDimensionChange,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import type { Snapshot } from "../../server/src/core/index.ts";
import {
  cameraFocus,
  clampUserZoom,
  edgeDots,
  focusViewport,
  nodeFocusViewport,
  nodeRect,
  overviewViewport,
  anchoredViewport,
  panViewport,
  revealViewport,
  screenPoint,
  scrollAlongAxis,
  scrollAxis,
  shiftIntoView,
  shouldMoveCamera,
  subtreeViewport,
  CLICK_ZOOM_FACTOR,
  OVERVIEW_MIN_ZOOM,
  USER_MAX_ZOOM,
  USER_MIN_ZOOM,
  zoomAroundCenter,
  zoomAtPoint,
  type ScrollAxisLock,
  type Viewport,
} from "./camera.ts";
import { foldView, keepTargetOf } from "./folding.ts";
import { KIND_COLOR, markOf } from "./kinds.ts";
import { layout, NODE_WIDTH, type Position } from "./layout.ts";
import { relocations, type PreviousView } from "./relocation.ts";
import { MapNode, type MapNodeData } from "./MapNode.tsx";
import { useAnimatedPositions } from "./useAnimatedPositions.ts";
import { foldToggle, humanSetsOf, type CameraCommand, type ViewingEvent, type ViewingState, type VisibleTree } from "./viewing.ts";

const nodeTypes = { map: MapNode };

const NO_CHANGES: ReadonlySet<string> = new Set();
const noop = () => {};

// 画面の外で変わったノードを、その方向の縁に点で出す。ビューポートの変化のたびに描き直す（購読はここに閉じる）
function EdgeDots({
  ids,
  target,
  dims,
  onPress,
}: {
  ids: string[];
  target: Record<string, Position>;
  dims: Dims;
  onPress: (id: string) => void;
}) {
  const viewport = useViewport();
  const width = useStore((s) => s.width);
  const height = useStore((s) => s.height);
  return (
    <div className="edge-dots">
      {edgeDots(ids, target, dims, viewport, { width, height }).map((d) => (
        <button
          key={d.id}
          type="button"
          className="edge-dot nopan nowheel"
          style={{ left: d.x, top: d.y }}
          aria-label={`画面の外で変わったノードへ寄る（${d.ids.length} 件）`}
          onClick={() => onPress(d.id)}
        />
      ))}
    </div>
  );
}

type Dims = Record<string, { width: number; height: number }>;

// キーの集合と各キーの x・y が一致すれば同じ位置とみなす
function samePositions(a: Record<string, Position>, b: Record<string, Position>): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((k) => {
    const p = a[k];
    const q = b[k];
    return p !== undefined && q !== undefined && p.x === q.x && p.y === q.y;
  });
}

type SelectProps = { selectedId: string | null; onSelect: (nodeId: string) => void };

// still は map.png の撮影用: 変わったノードの強調と位置の補間をなくし、大きなマップも全体を収める。
// onFitted は still のとき、全ノードが測られ、全体を収めようとした後に呼ぶ。引数は、全ノードが画面に収まったか（撮る合図の判断材料）。
type StillProps = { still?: boolean; onFitted?: (fitsAll: boolean) => void };

// 見る状態（人が動かすと自動のカメラが止まる）。still では使わず、省略すると自動として振る舞い、出来事を出さない
type ViewingProps = {
  viewing?: ViewingState;
  camera?: { command: CameraCommand; seq: number };
  onViewingEvent?: (event: ViewingEvent, tree: VisibleTree) => void;
  // 見えている木が変わるたびに最新を知らせる（実寸の確定で目標の位置が変わっても、矢印が最新の位置で測れるように）
  onTree?: (tree: VisibleTree) => void;
};

// 撮影では、既定の最小倍率（0.5）より小さくして、大きなマップも収める。この下限でも収まらない場合は onFitted(false) で知らせる
const STILL_MIN_ZOOM = 0.02;

function MapCanvas({
  snapshot,
  selectedId,
  onSelect,
  still = false,
  onFitted,
  viewing,
  camera,
  onViewingEvent,
  onTree,
}: { snapshot: Snapshot } & SelectProps & StillProps & ViewingProps) {
  // React Flow が測った実寸。スナップショットが変わっても捨てない（測り直しは onNodesChange で上書きされる）。
  const [dims, setDims] = useState<Dims>({});
  const { fitView, getViewport, setViewport } = useReactFlow();
  const storeApi = useStoreApi();
  // 最後に今の議題へ寄せた反映の round。変更の無い反映では寄せ直さない
  const placedRound = useRef<number | null>(null);
  // 全体を見る前の倍率・位置。全体を見ている間だけ持つ
  const beforeOverview = useRef<Viewport | null>(null);

  const onNodesChange = (changes: NodeChange[]) => {
    const measured = changes.filter((c): c is NodeDimensionChange => c.type === "dimensions" && !!c.dimensions);
    if (measured.length === 0) return;
    setDims((prev) => {
      let next: Dims | undefined;
      for (const c of measured) {
        const d = c.dimensions!;
        const old = prev[c.id];
        if (old && old.width === d.width && old.height === d.height) continue;
        next ??= { ...prev };
        next[c.id] = d;
      }
      return next ?? prev;
    });
  };

  // 見せ方。撮影（still）は畳まず、全ノードを描く
  // 人が開いた・畳んだ集合を入れる（still では viewing を使わない）
  const { opened: humanOpened, folded: humanFolded, unbundled: humanUnbundled } = humanSetsOf(viewing ?? { mode: "auto" });
  const view = useMemo(() => (still ? null : foldView(snapshot, humanOpened, selectedId, humanFolded, humanUnbundled)), [snapshot, still, selectedId, humanOpened, humanFolded, humanUnbundled]);
  const shownNodes = view?.nodes ?? snapshot.nodes;

  // 目標の位置。表示する位置は、ここへ向けて補間する
  const target = useMemo(() => {
    const heights = Object.fromEntries(Object.entries(dims).map(([id, d]) => [id, d.height]));
    return layout(shownNodes, heights);
  }, [shownNodes, dims]);
  const animated = useAnimatedPositions(shownNodes, target);
  const positions = still ? target : animated;
  // 補間位置は描画のたびに新しい参照になる。値が変わったときだけ参照を替え、自動のカメラの再実行条件に使う
  const framePositions = useRef(positions);
  if (!samePositions(framePositions.current, positions)) framePositions.current = positions;

  // 点滅させるノード（見せるノードで今回変わったものと、中が変わった畳んだノード・まとめのノード）。点滅と縁の点の両方がこの集合から出る（次の反映で入れ替わる）
  const changed = view?.blink ?? NO_CHANGES;

  // 見えている木。出来事と一緒に reducer へ渡す。foldState は見せる議題・論点（まとめのノードを除く）の畳まれ方
  const tree = useMemo(
    (): VisibleTree => ({
      ids: shownNodes.map((n) => n.id),
      targets: target,
      parents: Object.fromEntries(shownNodes.map((n) => [n.id, n.parent])),
      foldState: view
        ? Object.fromEntries(shownNodes.filter((n) => (n.kind === "議題" || n.kind === "論点") && !view.summaries.has(n.id)).map((n) => [n.id, n.id in view.folds ? "folded" : "open"]))
        : {},
      runs: view?.runs ?? {},
      currentTopic: snapshot.currentTopic,
    }),
    [shownNodes, view, snapshot.currentTopic, target],
  );
  const treeRef = useRef(tree);
  treeRef.current = tree;

  const nodes = useMemo((): Node[] => {
    const formal = shownNodes.map((n): Node<MapNodeData, "map"> => ({
      id: n.id,
      type: "map",
      position: positions[n.id] ?? { x: 0, y: 0 },
      width: NODE_WIDTH,
      measured: dims[n.id],
      data: {
        text: n.text,
        color: KIND_COLOR[n.kind],
        mark: markOf(n),
        rejected: n.kind === "案" && n.planStatus === "却下",
        fold: view?.folds[n.id] ?? null,
        changedRound: !still && changed.has(n.id) ? snapshot.round : null,
        selected: n.id === selectedId,
        onSelect: view?.summaries.has(n.id) ? noop : onSelect,
        humanOpened: humanOpened.has(n.id),
        // 開閉できるノード（今の議題とその祖先を除く。まとめのノードは解く）にだけ、丸を押したときの開閉を渡す
        onFoldDot: foldToggle(tree, n.id) === null ? null : (nodeId: string) => onViewingEvent?.({ type: "foldDot", id: nodeId }, tree),
      },
    }));
    return formal;
  }, [shownNodes, view, snapshot.round, changed, positions, dims, selectedId, onSelect, still, humanOpened, tree, onViewingEvent]);
  // 撮影の収まり判定が、再実行の依存に入れずに最新の nodes を読むための ref
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;

  const edges = useMemo((): Edge[] => {
    return shownNodes.flatMap((n) =>
      n.parent ? [{ id: `${n.parent}->${n.id}`, source: n.parent, target: n.id, style: { stroke: KIND_COLOR[n.kind], strokeWidth: 2 } }] : [],
    );
  }, [shownNodes]);

  useEffect(() => {
    onTree?.(tree);
  }, [tree, onTree]);
  const onViewingEventRef = useRef(onViewingEvent);
  onViewingEventRef.current = onViewingEvent;

  // 前の commit の見えている木とスナップショット。反映で選んだノードが消えたとき、移り先を前の木から求める
  const previous = useRef<PreviousView | null>(null);
  // 反映（round の変化）を見る状態へ知らせる。最初の描画も反映として数える
  useEffect(() => {
    const replaced = previous.current ? relocations(previous.current, { tree: treeRef.current, snapshot }) : {};
    onViewingEventRef.current?.({ type: "reflect", replaced }, treeRef.current);
  }, [snapshot.round]);
  // 反映の effect の後ろで更新する（反映の effect が前の commit の値を読めるように、宣言順を保つ）
  useEffect(() => {
    previous.current = { tree, snapshot, selectedId };
  }, [tree, snapshot, selectedId]);

  // 戻ったときは、同じ round でも今の議題へ寄せ直す
  const lastSeq = useRef(camera?.seq);
  if (camera && camera.seq !== lastSeq.current) {
    lastSeq.current = camera.seq;
    if (camera.command.type === "refocus") placedRound.current = null;
  }
  // 寄せ直し・収め直しのきっかけ番号。列で切れる分だけずらす指示（shiftIntoView）では進めない（E で寄せ直しも収め直しも走らせない）
  const refitSeq = useRef(camera?.seq);
  if (camera && camera.command.type !== "shiftIntoView" && camera.command.type !== "keepNode") refitSeq.current = camera.seq;
  // 自動のカメラを止めている間（人が動かしている・全体を見ている）
  const paused = !still && viewing !== undefined && viewing.mode !== "auto";
  const overview = !still && viewing?.mode === "overview";

  // 全体を見る前の倍率・位置を、全体を見に行く前に覚える。戻る（restore）以外で全体を見る状態を抜けたら捨てる
  const wasOverview = useRef(false);
  useEffect(() => {
    if (overview && !wasOverview.current) beforeOverview.current = getViewport();
    if (!overview && wasOverview.current && camera?.command.type !== "restore") beforeOverview.current = null;
    wasOverview.current = overview;
  }, [overview, camera, getViewport]);

  // 寄せ先（今の議題の外接箱と、収まらないときの中心）。見せないノードは、それを隠している畳んだノード・まとめのノードに置き換えて測る
  // （位置の無い ID は原点で測られる）。補間中の位置ではなく目標の位置で測る。自動のカメラと、列で切れる分のずらしの両方が使う
  const focusBoxes = (focus: { ids: string[]; center: string }) => {
    const shownId = (id: string) => view?.shownAs[id] ?? id;
    return {
      rects: [...new Set(focus.ids.map(shownId))].map((id) => nodeRect(id, target, dims)),
      center: nodeRect(shownId(focus.center), target, dims),
    };
  };

  // 人の開閉の後、そのノードの画面上の位置を保つ基準（keepNode の指示で立てる）。次の指示か人の操作で捨てる
  const keepAnchor = useRef<{ id: string; point: { x: number; y: number } } | null>(null);

  // 列で切れる分のずらしの保留。shiftIntoView の指示で立て、React Flow の width が .map の幅に追いついた後に適用して消す
  const pendingShift = useRef(false);

  // キーの指示。setViewport の動き（event が null）は userMoved にならない
  useEffect(() => {
    const command = camera?.command;
    if (!command) return;
    const { width, height } = storeApi.getState();
    const size = { width, height };
    const current = getViewport();
    pendingShift.current = command.type === "shiftIntoView";
    keepAnchor.current = null;
    switch (command.type) {
      case "zoomBy":
        void setViewport(zoomAroundCenter(current, clampUserZoom(current.zoom * command.factor), size), { duration: 0 });
        break;
      case "zoomTo":
        void setViewport(zoomAroundCenter(current, clampUserZoom(command.zoom), size), { duration: 0 });
        break;
      case "pan":
        // 全体を見ていて 0.5 未満の倍率から人の状態に移るときは、人の範囲に収めてから動かす
        void setViewport(panViewport(zoomAroundCenter(current, clampUserZoom(current.zoom), size), command, size), { duration: 0 });
        break;
      case "focusNode":
        void setViewport(nodeFocusViewport(nodeRect(command.id, target, dims), current.zoom, size), { duration: 0 });
        break;
      case "revealNode":
        // 全体を見ていて 0.5 未満の倍率から人の状態に移るときは、人の範囲に収めてから、はみ出した分だけ動かす
        void setViewport(revealViewport(zoomAroundCenter(current, clampUserZoom(current.zoom), size), nodeRect(command.id, target, dims), size), { duration: 0 });
        break;
      case "fitSubtree":
        void setViewport(subtreeViewport(command.id, treeRef.current, target, dims, size), { duration: 0 });
        break;
      case "keepNode": {
        // 基準の画面座標は、開閉の前の表示位置から作る（畳んで「議題 N 件」に集約されたノードは、今の positions に無い）。
        // 以後は、いま見えている側（集約先のまとめのノード）を基準の位置に合わせ続ける
        const at = lastPositions.current[command.id] ?? positions[command.id];
        // 解いた「議題 N 件」（run:X）はもう見せるノードに無いので、最初の議題 X に合わせる
        const shownId = keepTargetOf(view, command.id);
        if (at) keepAnchor.current = { id: shownId, point: screenPoint(current, at) };
        break;
      }
      case "restore": {
        const before = beforeOverview.current;
        beforeOverview.current = null;
        if (before) void setViewport(before, { duration: 0 });
        break;
      }
    }
    // 指示は seq が変わったときだけ実行する
  }, [camera?.seq]);

  // 前の commit の表示位置。指示の effect より後に更新するので、指示の effect からは開閉の前の位置が読める
  const lastPositions = useRef(positions);
  useEffect(() => {
    lastPositions.current = positions;
  });

  // 位置を保つ基準があるあいだ、補間位置（実寸の確定後の再配置を含む）が変わるたびに、そのノードが基準の画面座標に映るよう合わせ直す
  const keepPosition = keepAnchor.current ? framePositions.current[keepAnchor.current.id] : undefined;
  useEffect(() => {
    const anchor = keepAnchor.current;
    const at = anchor ? framePositions.current[anchor.id] : undefined;
    if (!anchor || !at) return;
    void setViewport(anchoredViewport(getViewport(), at, anchor.point), { duration: 0 });
  }, [keepPosition?.x, keepPosition?.y, camera?.seq, getViewport, setViewport]);

  // 全体を見ている間は、目標の位置で測った全体の箱に一度で収める。ノードの増加・実寸の確定・指示のたびに収め直す。位置を保つ基準があるあいだは収め直さない
  useEffect(() => {
    if (!overview || keepAnchor.current) return;
    const frame = requestAnimationFrame(() => {
      const { width, height } = storeApi.getState();
      const v = overviewViewport(tree.ids, target, dims, { width, height });
      if (v) void setViewport(v, { duration: 0 });
    });
    return () => cancelAnimationFrame(frame);
  }, [overview, tree, target, dims, refitSeq.current, storeApi, setViewport]);

  // 人が動かしたとき（event がある）だけ知らせる。setViewport や fitView の動き（event が null）は数えない
  const onUserMove = (event: unknown) => {
    if (!event) return;
    keepAnchor.current = null;
    onViewingEvent?.({ type: "userMoved" }, tree);
    // 全体を見ている間の 0.5 未満の倍率から人の操作に移るときは、人の範囲に収める（minZoom の切り替えは今の倍率を変えない）
    const current = getViewport();
    const zoom = clampUserZoom(current.zoom);
    if (zoom !== current.zoom) {
      const { width, height } = storeApi.getState();
      void setViewport(zoomAroundCenter(current, zoom, { width, height }), { duration: 0 });
    }
  };

  // 反映のたびに（目標の位置・寸法が変わるたびに）、撮影では全体を、ふだんは今の議題を画面に収める。今の議題が無いときも全体を収める。
  // 補間の描画用 nodes の参照更新では再実行しない（E で列を出し入れしただけでは寄せ直さない）。
  // 今の議題が無い間だけ、補間後の最終配置へ収めるため補間位置の値の変化で再実行する
  const followsFrames = !still && cameraFocus(snapshot) === null;
  const followedPositions = followsFrames ? framePositions.current : null;
  useEffect(() => {
    if (paused) return;
    const focus = still ? null : cameraFocus(snapshot);
    if (focus) {
      // 補間中の位置ではなく目標の位置で測る
      if (!shouldMoveCamera(snapshot, placedRound.current)) return;
      const frame = requestAnimationFrame(() => {
        const { width, height } = storeApi.getState();
        const boxes = focusBoxes(focus);
        placedRound.current = snapshot.round;
        void setViewport(focusViewport(boxes.rects, boxes.center, { width, height }), { duration: 0 });
      });
      return () => cancelAnimationFrame(frame);
    }
    placedRound.current = null;
    // 撮影では、すべての正式なノードが測られた後の配置を収めようとしてから、収まったかを知らせる
    const measured = snapshot.nodes.every((n) => dims[n.id]);
    let cancelled = false;
    const frame = requestAnimationFrame(() => {
      void fitView({ duration: 0, padding: 0.1, ...(still ? { minZoom: STILL_MIN_ZOOM } : {}) }).then(() => {
        if (!still || !measured || cancelled) return;
        // fitView は下限の倍率で止まっても成功を返すので、実際に全体が画面に収まったかを自分で確かめる
        const b = getNodesBounds(nodesRef.current);
        const { x, y, zoom } = getViewport();
        const { width, height } = storeApi.getState();
        onFitted?.(
          b.x * zoom + x >= 0 && b.y * zoom + y >= 0 && (b.x + b.width) * zoom + x <= width && (b.y + b.height) * zoom + y <= height,
        );
      });
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    };
  }, [followedPositions, fitView, getViewport, setViewport, storeApi, still, snapshot, view, target, dims, onFitted, paused, refitSeq.current]);

  // ⌘/Ctrl＋クリック: 押した点を中心に 1.5 倍に拡大（Option を加えると縮小）。ノードの上でも根拠を出さない。
  // setViewport の動き（event が null）は userMoved にならないので、人の操作として自分で知らせる
  const onClickCapture = (e: MouseEvent<HTMLDivElement>) => {
    if (!(e.metaKey || e.ctrlKey)) return;
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    const point = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    keepAnchor.current = null;
    onViewingEvent?.({ type: "userMoved" }, tree);
    void setViewport(zoomAtPoint(getViewport(), point, e.altKey ? 1 / CLICK_ZOOM_FACTOR : CLICK_ZOOM_FACTOR), { duration: 0 });
  };

  // ⌘/Ctrl＋Shift＋スクロール: 縦か横の一方の軸だけに移動する（拡大・縮小しない）。
  // preventDefault を効かせるため、passive でない native の listener を capture で付け、React Flow へ渡さない
  const wrapperRef = useRef<HTMLDivElement>(null);
  const axisLock = useRef<ScrollAxisLock | null>(null);
  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (still || !wrapper) return;
    const onWheel = (e: WheelEvent) => {
      if (!((e.metaKey || e.ctrlKey) && e.shiftKey)) return;
      e.preventDefault();
      e.stopPropagation();
      const delta = { x: e.deltaX, y: e.deltaY };
      const lock = scrollAxis(axisLock.current, e.timeStamp, delta);
      axisLock.current = lock;
      keepAnchor.current = null;
      onViewingEventRef.current?.({ type: "userMoved" }, treeRef.current);
      void setViewport(scrollAlongAxis(getViewport(), lock.axis, delta), { duration: 0 });
    };
    wrapper.addEventListener("wheel", onWheel, { capture: true, passive: false });
    return () => wrapper.removeEventListener("wheel", onWheel, { capture: true });
  }, [still, getViewport, setViewport]);

  // 列の出し入れで .map の幅が変わった後、今の議題が端で切れるときだけ、切れた分を横にずらす（倍率は変えない）。
  // store の width が DOM の幅に追いついてから測る（ResizeObserver が指示の effect の前後どちらで走っても成立する）
  const storeWidth = useStore((s) => s.width);
  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!pendingShift.current || !wrapper || storeWidth !== wrapper.offsetWidth) return;
    pendingShift.current = false;
    // 列を隠したとき（マップが広がったとき）は、見る位置を変えない。ずらすのは列を出したときだけ
    if (viewing?.sideHidden) return;
    const focus = still ? null : cameraFocus(snapshot);
    if (!focus) return;
    const { height } = storeApi.getState();
    void setViewport(shiftIntoView(getViewport(), focusBoxes(focus).rects, { width: storeWidth, height }), { duration: 0 });
  }, [storeWidth, camera?.seq]);

  return (
    <div ref={wrapperRef} style={{ width: "100%", height: "100%" }} onClickCapture={still ? undefined : onClickCapture}>
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodesChange={onNodesChange}
      nodesDraggable={false}
      nodesConnectable={false}
      nodesFocusable={false}
      elementsSelectable={false}
      deleteKeyCode={null}
      selectionKeyCode={null}
      multiSelectionKeyCode={null}
      panActivationKeyCode={null}
      zoomOnScroll={false}
      zoomOnDoubleClick={false}
      {...(still
        ? { panOnDrag: false, zoomOnPinch: false, minZoom: STILL_MIN_ZOOM }
        : {
            panOnDrag: true,
            panOnScroll: true,
            panOnScrollMode: PanOnScrollMode.Free,
            zoomOnPinch: true,
            minZoom: overview ? OVERVIEW_MIN_ZOOM : USER_MIN_ZOOM,
            maxZoom: USER_MAX_ZOOM,
            onMoveStart: onUserMove,
            onMove: onUserMove,
          })}
      proOptions={{ hideAttribution: true }}
    >
      {paused && <EdgeDots ids={tree.ids.filter((id) => changed.has(id))} target={target} dims={dims} onPress={(id) => onViewingEvent?.({ type: "edgeDot", id }, tree)} />}
    </ReactFlow>
    </div>
  );
}

export function MapView({ snapshot, selectedId, onSelect, still, onFitted, viewing, camera, onViewingEvent, onTree }: { snapshot: Snapshot } & SelectProps & StillProps & ViewingProps) {
  return (
    <ReactFlowProvider>
      <MapCanvas snapshot={snapshot} selectedId={selectedId} onSelect={onSelect} still={still} onFitted={onFitted} viewing={viewing} camera={camera} onViewingEvent={onViewingEvent} onTree={onTree} />
    </ReactFlowProvider>
  );
}
