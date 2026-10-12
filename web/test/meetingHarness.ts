// 会議中の Foldkit プログラム（Issue #829）の Story・Scene が共有する道具。テストではなく、題材のスナップショット・frame を流す Message・保留の Command と Mount を解く step・描いた木を読む関数だけを置く。
//
// この道具が固定する、会議中のプログラム（web/src/app/meeting/main.ts・message.ts）の外から見える形:
// - main.ts: `Model`（Schema）・`init(isMac: boolean)`・`update`・`view`（`(model, h) => Html`。根は `.layout`。スナップショットが無い間は `p.waiting`）
// - message.ts: `Message`。受信は `GotLiveFeedMessage({ message })`（message は app/liveFeed/message.ts の Message）、表示面は `GotMapSurfaceMessage({ message })`、
//   セッションの画面の部品は `GotSessionLayoutMessage({ message })`、キーの一覧は `GotKeyListMessage({ message })`、キーは `PressedKey({ key, metaKey, ctrlKey, altKey })`
// Model の中身の欄の分け方は固定しない。振る舞いは描いた木・出る Command・同じ入力を流した表示面（MapSurface）との一致で見る
import * as Animation from "@foldkit/ui/animation";
import * as Popover from "@foldkit/ui/popover";
import * as Toast from "@foldkit/ui/toast";
import { Duration, Option } from "effect";
import { expect } from "vitest";
import { Command as StoryCommand, type StorySimulation } from "foldkit/story";
import { attr, Command, find, findAll, given, Mount, scene, Subscription, textContent, type SceneSimulation, type SceneStep } from "foldkit/scene";
import type { Snapshot } from "../../server/src/core/index.ts";
import type { LiveFrame } from "../src/app/liveFeed/message.ts";
import { Message as LiveFeedMessage } from "../src/app/liveFeed/message.ts";
import { RestartBlink } from "../src/app/mapSurface/command.ts";
import * as MapSurface from "../src/app/mapSurface/main.ts";
import { Message as MapSurfaceMessage } from "../src/app/mapSurface/message.ts";
import { ObserveMapSurface } from "../src/app/mapSurface/mount.ts";
import type { KeyId } from "../src/app/keys/table.ts";
import { init, update, view } from "../src/app/meeting/main.ts";
import { Message } from "../src/app/meeting/message.ts";
import { semanticClassesOf } from "./semanticClasses.ts";

export const app = { update, view };
export { init, update, view, Message };
export type Model = ReturnType<typeof init>;
export type MeetingMessage = typeof Message.Type;

// ---- 題材のスナップショット ----
const node = (id: string, parent: string | null, kind: Snapshot["nodes"][number]["kind"], text: string, evidence: string[] = []) => ({ id, parent, kind, text, evidence });
const remark = (id: string, start: number, end: number, text: string) => ({ id, track: "相手" as const, start, end, text });

// 反映 1: 会議 → 議題 A（今の議題）
export const FIRST: Snapshot = {
  nodes: [node("root", null, "会議", "定例"), node("A", "root", "議題", "採用", ["r1"])],
  round: 1,
  changes: [{ round: 1, at: 12, change: "追加", node: "A", kind: "議題", text: "採用" }],
  remarks: [remark("r1", 10, 12, "採用の話をします")],
  currentTopic: "A",
  now: 12,
};
// 反映 2: A の下に論点 A1、会議の下に議題 B。今の議題は B
export const SECOND: Snapshot = {
  nodes: [
    node("root", null, "会議", "定例"),
    node("A", "root", "議題", "採用", ["r1"]),
    { ...node("A1", "A", "論点", "面接は何回か", ["r2"]), pointStatus: "未決" as const },
    node("B", "root", "議題", "予算", ["r3"]),
  ],
  round: 2,
  changes: [
    { round: 1, at: 12, change: "追加", node: "A", kind: "議題", text: "採用" },
    { round: 2, at: 30, change: "追加", node: "A1", kind: "論点", text: "面接は何回か" },
    { round: 2, at: 30, change: "追加", node: "B", kind: "議題", text: "予算" },
  ],
  remarks: [remark("r1", 10, 12, "採用の話をします"), remark("r2", 20, 25, "面接は何回にしますか"), remark("r3", 26, 30, "予算の話に移ります")],
  currentTopic: "B",
  now: 30,
};
// 反映 3: SECOND と同じ形で round だけ進む（変わったこと無し。点滅の対象が無い）
export const THIRD_QUIET: Snapshot = { ...SECOND, round: 3, changes: SECOND.changes.filter((c) => c.round < 3) };

export const SIZE = { width: 800, height: 600 };
// 題材に出る全ノードの高さ。後から増えるノード（A1・B）の高さも最初の測定で渡す（実ブラウザでは ResizeObserver が増えたノードの高さを届ける）
export const HEIGHTS: Record<string, number> = { root: 40, A: 40, A1: 40, B: 40 };

export const MANUAL = "動かしています・議題が変わるか Esc で今の議題へ・? でキー一覧";
export const OVERVIEW = "全体を見ています・F か Esc で戻る・? でキー一覧";
export const INTERRUPTED = "音声の取り込みが途切れました。再開しています";
export const STOPPED = "音声の取り込みが止まっています";
export const RESUMED = "再開しました";
export const SCREEN = "共有画面は使っていません（画面収録の許可がありません）";
export const TAP = "相手の音声が届いていません（出力の機器を切り替えた後に起きることがあります）";
export const PAUSED = { status: "paused", reason: "ChatGPT の利用上限" } as const;
export const PAUSED_TEXT = "マップの更新が止まっています（ChatGPT の利用上限）";

// ---- 受信（WebSocket。描いた木の外）を流す Message ----
export const frameMessage = (frame: LiveFrame) => Message.GotLiveFeedMessage({ message: LiveFeedMessage.ReceivedLiveFrame({ frame }) });
export const connectedMessage = () => Message.GotLiveFeedMessage({ message: LiveFeedMessage.ConnectedLiveFeed() });
export const disconnectedMessage = () => Message.GotLiveFeedMessage({ message: LiveFeedMessage.DisconnectedLiveFeed() });
export const surfaceMessage = (message: MapSurfaceMessage) => Message.GotMapSurfaceMessage({ message });
export const keyMessage = (key: KeyId, mods: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean }> = {}) =>
  Message.PressedKey({ key, metaKey: false, ctrlKey: false, altKey: false, ...mods });

// 描いた木の外から届く Message（WebSocket の frame・文書のキー・表示面の Mount）を流す step。
// Scene は、保留の Command と Mount を残したまま次の Message を流せず、終わりに残っていても落ちる。meetingScene は、流す step のたびに
// 「保留の時間切れ（再開しました）を何も起こさない結果で閉じる → 流す → 出入りの動き・点滅・Mount を解く」までを足す。
// 流した直後の保留の Command を見たいとき（RestartBlink・時間切れ）は、raw で包んで流し、見てから settle を挟む
export const frame = (f: LiveFrame) => Subscription.emit(frameMessage(f));
export const connected = () => Subscription.emit(connectedMessage());
export const disconnected = () => Subscription.emit(disconnectedMessage());
export const press = (key: KeyId, mods: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean }> = {}) => Subscription.emit(keyMessage(key, mods));
export const surface = (message: MapSurfaceMessage) => Subscription.emit(surfaceMessage(message));
export const speak = (text: string, track: "相手" | "自分" = "相手") => frame({ type: "speaking", track, text });
export const intake = (status: "running" | "interrupted" | "stopped" | "none") => frame({ type: "intake", status });

type EmitStep = ReturnType<typeof frame>;
type AnyEmit = ReturnType<typeof press> | ReturnType<typeof surface> | EmitStep;
type Raw = { readonly _tag: "Raw"; readonly step: AnyEmit };
export const raw = (step: AnyEmit): Raw => ({ _tag: "Raw", step });
export const frameRaw = (f: LiveFrame): Raw => raw(frame(f));
type MeetingStep = SceneStep<Model, MeetingMessage, undefined> | Raw;
const expand = (step: MeetingStep): SceneStep<Model, MeetingMessage, undefined>[] =>
  "_tag" in step && step._tag === "Raw" ? [quiet, (step as Raw).step] : "_tag" in step && step._tag === "SubscriptionMessageStep" ? [quiet, step as EmitStep, settle] : [step as SceneStep<Model, MeetingMessage, undefined>];

export const meetingScene = (model: Model, ...steps: ReadonlyArray<MeetingStep>): void => scene(app, given(model), ...steps.flatMap(expand), settle, quiet);

// ---- 同じ入力を流す表示面（比べる相手）----
// 会議中の表示面は、live の MapSurface に同じ Message を流したのと同じ結果になる。比べる相手は MapSurface の公開の入口だけを使って作る
export const referenceOf = (snapshot: Snapshot, isMac = false): MapSurface.Model =>
  MapSurface.update(MapSurface.init(snapshot, "live", isMac), MapSurfaceMessage.MeasuredMapSurface({ ...SIZE, nodeHeights: HEIGHTS })).model;

type Mods = { metaKey: boolean; ctrlKey: boolean; altKey: boolean };
const NONE: Mods = { metaKey: false, ctrlKey: false, altKey: false };
const VIEW_KEYS = ["F", "=", "-", "0", "Z", "Shift+ArrowLeft", "Shift+ArrowRight", "Shift+ArrowUp", "Shift+ArrowDown"] as const;
const ARROWS = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" } as const;
// キー 1 つが表示面に与える結果（表示面に関わるキーだけ。E は右の列の出し入れも表示面の見る状態が持つ）
export const referencePress = (model: MapSurface.Model, key: KeyId, mods: Mods = NONE): MapSurface.Model => {
  if ((VIEW_KEYS as readonly string[]).includes(key)) return MapSurface.pressViewKey(model, { key: key as (typeof VIEW_KEYS)[number], ...mods }).model;
  if (key in ARROWS) return MapSurface.pressArrowKey(model, { dir: ARROWS[key as keyof typeof ARROWS], ...mods }).model;
  if (key === "Escape") return MapSurface.pressEscapeKey(model, mods).model;
  if (key === "Enter") return MapSurface.pressEnterKey(model, mods).model;
  if (key === "E") return MapSurface.pressSideKey(model, mods).model;
  throw new Error(`referencePress: 表示面に渡すキーではない ${key}`);
};
export const referenceUpdate = (model: MapSurface.Model, message: MapSurfaceMessage): MapSurface.Model => MapSurface.update(model, message).model;

// ---- 描いた木を読む ----
export type VNode = Parameters<typeof textContent>[0];
export type Sim = SceneSimulation<Model, Message, undefined>;

export const attrOf = (vnode: VNode, name: string): string | undefined => Option.getOrUndefined(attr(vnode, name));
export const hasClass = (vnode: VNode, name: string): boolean => (attrOf(vnode, "class") ?? "").split(" ").includes(name);
export const elementsOf = (vnode: VNode): VNode[] => (vnode.children ?? []).filter((c): c is VNode => typeof c !== "string" && c.sel !== undefined);
export const one = (html: VNode, css: string): VNode => Option.getOrThrow(find(html, css));
export const texts = (html: VNode, css: string): string[] => findAll(html, css).map(textContent);
export const styleOf = (vnode: VNode): Record<string, string> => ((vnode.data as { style?: Record<string, string> } | undefined)?.style ?? {}) as Record<string, string>;
const numbers = (s: string): number[] => (s.match(/-?\d+(?:\.\d+)?(?:e-?\d+)?/g) ?? []).map(Number);

// .layout の直下の子の class（先頭の 1 つ）。画面の並びを見る
export const layoutOutline = (html: VNode): string[] => elementsOf(one(html, ".layout")).map((child) => semanticClassesOf(attrOf(child, "class") ?? "")[0] ?? "");
export const renderedIds = (html: VNode): string[] => findAll(html, "[data-node-id]").map((v) => attrOf(v, "data-node-id")!);
// 選ばれているノードの id（aria-pressed="true" のボタンを持つノード）
export const selectedIds = (html: VNode): string[] =>
  findAll(html, "[data-node-id]")
    .filter((wrapper) => findAll(wrapper, 'button[aria-pressed="true"]').length > 0)
    .map((v) => attrOf(v, "data-node-id")!);
// .map-viewport の transform（translate(x px, y px) scale(zoom)）
export const viewportOf = (html: VNode): { x: number; y: number; zoom: number } => {
  const [x, y, zoom] = numbers(styleOf(one(html, ".map-viewport"))["transform"] ?? "");
  return { x: x!, y: y!, zoom: zoom! };
};
// ノードのラッパーの transform（translate(x px, y px)）
export const nodePositionsOf = (html: VNode): Record<string, { x: number; y: number }> =>
  Object.fromEntries(
    findAll(html, "[data-node-id]").map((wrapper) => {
      const [x, y] = numbers(styleOf(wrapper)["transform"] ?? "");
      return [attrOf(wrapper, "data-node-id")!, { x: x!, y: y! }];
    }),
  );

// 描いた木の形（要素・class・属性・style・文字）。イベントのハンドラ（関数）は比べない。同じ画面かどうかを、木のまま比べる代わりに使う
export const shapeOf = (vnode: VNode | string): unknown =>
  typeof vnode === "string"
    ? vnode
    : {
        sel: vnode.sel,
        text: vnode.text,
        data: { attrs: vnode.data?.attrs, props: vnode.data?.props, style: vnode.data?.style, class: vnode.data?.class },
        children: (vnode.children ?? []).map((child) => shapeOf(child as VNode | string)),
      };

// 表示面（MapSurface）の Model が描く木と、会議中の画面が描く木が、ビューポート・選択・ノードの位置で一致する
export const matchesReference = (html: VNode, reference: MapSurface.Model) => {
  const viewport = viewportOf(html);
  expectClose(viewport.x, reference.viewport.x);
  expectClose(viewport.y, reference.viewport.y);
  expectClose(viewport.zoom, reference.viewport.zoom);
  const positions = nodePositionsOf(html);
  const expected = MapSurface.displayedPositions(reference);
  for (const [id, position] of Object.entries(positions)) {
    expectClose(position.x, expected[id]!.x);
    expectClose(position.y, expected[id]!.y);
  }
  // 選んだノードが今のマップに無いとき（変わったことの項目が指す消えたノード）は、どのノードも選ばれた見た目にならない
  const selection = reference.viewing.selection?.id;
  return { selected: selectedIds(html), expectedSelected: selection !== undefined && selection in expected ? [selection] : [] };
};
const expectClose = (actual: number, expected: number) => expect(actual).toBeCloseTo(expected, 6);

// ---- 保留中の Command と Mount を解く step ----
// 出す・消すときの Toast の動き（WaitForPaint / WaitForAnimationSettled）・点滅の再生し直し（RestartBlink）・表示面とキーの一覧の Mount・キーの一覧のフォーカス（FocusButton / FocusPanel）は、このテストの関心ではないので全部解く。
// 「再開しました」の時間切れ（WaitBeforeDismissal）は解かない（解く・解かないがテストの主題。expire で解く）
type Step = <M, Msg, Out>(simulation: SceneSimulation<M, Msg, Out>) => SceneSimulation<M, Msg, Out>;
const mountStep = (name: string): Step | undefined =>
  name === "ObserveMapSurface"
    ? Mount.resolve(ObserveMapSurface, MapSurfaceMessage.MeasuredMapSurface({ ...SIZE, nodeHeights: HEIGHTS }))
    : name === "AnchorPopover"
      ? Mount.resolve(Popover.AnchorPopover, Popover.Message.CompletedAnchorPopover())
      : undefined;
const commandStep = (name: string, args: unknown): Step | undefined => {
  if (name === "RestartBlink") return Command.resolveAll([RestartBlink, MapSurfaceMessage.CompletedRestartBlink()]);
  // キーの一覧（Popover）を閉じたときにフォーカスを戻す・開いたときにパネルへフォーカスを移す
  if (name === "FocusButton") return Command.resolveAll([Popover.FocusButton, Popover.Message.CompletedFocusButton()]);
  if (name === "FocusPanel") return Command.resolveAll([Popover.FocusPanel, Popover.Message.CompletedFocusPanel()]);
  if (name === "WaitForPaint") {
    const { generation } = args as { generation: number };
    return Command.resolveAll([Animation.WaitForPaint, Animation.Message.CompletedWaitForPaint({ generation })]);
  }
  if (name === "WaitForAnimationSettled") {
    const { generation } = args as { generation: number };
    return Command.resolveAll([Animation.WaitForAnimationSettled, Animation.Message.EndedAnimation({ generation })]);
  }
  return undefined;
};

export const settle = <M, Msg, Out>(simulation: SceneSimulation<M, Msg, Out>): SceneSimulation<M, Msg, Out> => {
  for (const mount of simulation.mounts) {
    const step = mountStep(mount.name);
    if (step !== undefined) return settle(step(simulation));
  }
  return settleCommands(simulation);
};
// Mount は解かず、保留の Command だけを全部解く（測り直した後の幅を、最初の測定の幅で上書きさせないため）
export const settleCommands = <M, Msg, Out>(simulation: SceneSimulation<M, Msg, Out>): SceneSimulation<M, Msg, Out> => {
  for (const command of simulation.commands) {
    const step = commandStep(command.name, command.args);
    if (step !== undefined) return settleCommands(step(simulation));
  }
  return simulation;
};

// 保留の Command の名前（並びは保証されないので昇順にそろえる）
export const commandNames = (simulation: { commands: ReadonlyArray<{ name: string }> }): string[] => simulation.commands.map((c) => c.name).sort();
export const timers = (simulation: { commands: ReadonlyArray<{ name: string; args?: unknown }> }) => simulation.commands.filter((c) => c.name === "WaitBeforeDismissal");
// 保留の時間切れ（先頭）を、いま来たものとして解く
export const expire = (simulation: Sim): Sim => {
  const { entryId, version, duration } = timers(simulation)[0]!.args as { entryId: string; version: number; duration: Duration.Duration };
  return Command.resolve(Toast.WaitBeforeDismissal({ entryId, version, duration }), Toast.Message.CompletedWaitBeforeDismissal({ entryId, version }))(simulation);
};
// 保留の時間切れを「何も起こさない結果」（版が違う完了）で全部閉じる。実行時は走ったままのタイマーが後で古い版として届くだけなので、次の流れを妨げない
export const quiet = <M, Msg, Out>(simulation: SceneSimulation<M, Msg, Out>): SceneSimulation<M, Msg, Out> => {
  const pending = timers(simulation)[0];
  if (pending === undefined) return simulation;
  const { entryId, version, duration } = pending.args as { entryId: string; version: number; duration: Duration.Duration };
  return quiet(Command.resolve(Toast.WaitBeforeDismissal({ entryId, version, duration }), Toast.Message.CompletedWaitBeforeDismissal({ entryId, version: version + 1000 }))(simulation));
};

// Story 用: 出す・消すときの Toast の動きと、点滅の再生し直しを、保留がなくなるまで全部解く
export const settleStory = <M, Msg>(simulation: StorySimulation<M, Msg>): StorySimulation<M, Msg> => {
  const pending = simulation.commands.find((c) => c.name === "WaitForPaint" || c.name === "WaitForAnimationSettled" || c.name === "RestartBlink");
  if (pending === undefined) return simulation;
  if (pending.name === "RestartBlink") return settleStory(StoryCommand.resolve(RestartBlink, MapSurfaceMessage.CompletedRestartBlink())(simulation));
  const generation = pending.args?.generation as number;
  return settleStory(
    pending.name === "WaitForPaint"
      ? StoryCommand.resolve(Animation.WaitForPaint({ generation }), Animation.Message.CompletedWaitForPaint({ generation }))(simulation)
      : StoryCommand.resolve(Animation.WaitForAnimationSettled({ id: pending.args?.id as string, generation }), Animation.Message.EndedAnimation({ generation }))(simulation),
  );
};
