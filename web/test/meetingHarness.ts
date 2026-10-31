import * as Animation from "@foldkit/ui/animation";
import * as Popover from "@foldkit/ui/popover";
import * as Toast from "@foldkit/ui/toast";
import { Duration } from "effect";
import { expect } from "vitest";
import { Command as StoryCommand, type StorySimulation } from "foldkit/story";
import { Command, findAll, given, Mount, scene, Subscription, textContent, type SceneSimulation, type SceneStep } from "foldkit/scene";
import type { Snapshot } from "../../server/src/core/index.ts";
import type { LiveFrame } from "../src/app/liveFeed/message.ts";
import { Message as LiveFeedMessage } from "../src/app/liveFeed/message.ts";
import { RestartBlink } from "../src/app/mapSurface/command.ts";
import * as MapSurface from "../src/app/mapSurface/main.ts";
import { Message as MapSurfaceMessage } from "../src/app/mapSurface/message.ts";
import { ObserveMapSurface } from "../src/app/mapSurface/mount.ts";
import { FocusSpeakerNameInput, RequestSpeakerName } from "../src/app/sessionLayout/command.ts";
import { Message as SessionLayoutMessage } from "../src/app/sessionLayout/message.ts";
import { SlideCaptions } from "../src/app/sessionLayout/mount.ts";
import type { KeyId } from "../src/app/keys/table.ts";
import { RequestSelfPause } from "../src/app/meeting/command.ts";
import { init, update, view } from "../src/app/meeting/main.ts";
import { Message } from "../src/app/meeting/message.ts";
import { spokenFrame } from "./fixtures/captions.ts";
import { semanticClassesOf } from "./semanticClasses.ts";
import { resolveNoticeMotion } from "./noticeMotion.ts";
import { attrOf, elementsOf, one, styleOf, type VNode } from "./sceneTree.ts";

export const app = { update, view };
export { init, update, Message };
export type Model = ReturnType<typeof init>;
export type MeetingMessage = typeof Message.Type;

const node = (id: string, parent: string | null, kind: Exclude<Snapshot["nodes"][number]["kind"], "補足">, text: string, evidence: string[] = []) => ({ id, parent, kind, text, evidence });
const remark = (id: string, start: number, end: number, text: string) => ({ id, track: "相手" as const, start, end, text });

export const FIRST: Snapshot = {
  nodes: [node("root", null, "会議", "定例"), node("A", "root", "議題", "採用", ["r1"])],
  round: 1,
  changes: [{ round: 1, at: 12, change: "追加", node: "A", kind: "議題", text: "採用" }],
  remarks: [remark("r1", 10, 12, "採用の話をします")],
  currentTopic: "A",
  now: 12,
};
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
export const THIRD_QUIET: Snapshot = { ...SECOND, round: 3, changes: SECOND.changes.filter((c) => c.round < 3) };

export const SIZE = { width: 800, height: 600 };
export const HEIGHTS: Record<string, number> = { root: 40, A: 40, A1: 40, B: 40 };

export const MANUAL = "動かしています・議題が変わるか Esc で今の議題へ・? でキー一覧";
export const DIFF = "変わったところを見ています・Esc で戻る・? でキー一覧";
export const OVERVIEW = "全体を見ています・F で変わったところへ・Esc で戻る・? でキー一覧";
export const INTERRUPTED = "音声の取り込みが途切れました。再開しています";
export const STOPPED = "音声の取り込みが止まっています";
export const RESUMED = "再開しました";
export const SCREEN = "共有画面は使っていません（画面収録の許可がありません）";
export const TAP = "相手の音声が届いていません（出力の機器を切り替えた後に起きることがあります）";
export const PAUSED = { status: "paused", reason: "ChatGPT の利用上限" } as const;
export const SELF_PAUSE_TEXT = "自分を休止中（M で再開）";
export const SELF_PAUSE_AUTO_TEXT = "自分を休止中（会議アプリがマイクを使っていない）";
export const PAUSED_TEXT = "マップの更新が止まっています（ChatGPT の利用上限）";

export const frameMessage = (frame: LiveFrame, receivedAt = 0) => Message.GotLiveFeedMessage({ message: LiveFeedMessage.ReceivedLiveFrame({ frame, receivedAt }) });
export const snapshotMessage = (snapshot: Snapshot, receivedAt = 0) => frameMessage({ type: "snapshot", snapshot }, receivedAt);
export const connectedMessage = () => Message.GotLiveFeedMessage({ message: LiveFeedMessage.ConnectedLiveFeed() });
export const disconnectedMessage = () => Message.GotLiveFeedMessage({ message: LiveFeedMessage.DisconnectedLiveFeed() });
export const surfaceMessage = (message: MapSurfaceMessage) => Message.GotMapSurfaceMessage({ message });
export const keyMessage = (key: KeyId, mods: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean }> = {}) =>
  Message.PressedKey({ key, metaKey: false, ctrlKey: false, altKey: false, ...mods });

export const frame = (f: LiveFrame) => Subscription.emit(frameMessage(f));
export const snapshotFrame = (snapshot: Snapshot) => Subscription.emit(snapshotMessage(snapshot));
export const connected = () => Subscription.emit(connectedMessage());
export const disconnected = () => Subscription.emit(disconnectedMessage());
export const press = (key: KeyId, mods: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean }> = {}) => Subscription.emit(keyMessage(key, mods));
export const surface = (message: MapSurfaceMessage) => Subscription.emit(surfaceMessage(message));
export const speak = (text: string, track: "相手" | "自分" = "相手") => frame(spokenFrame(text, track));
export const selfPause = (paused: boolean, reason: "手動" | "自動" = "手動") => frame(paused ? { type: "self-pause", paused: true, reason } : { type: "self-pause", paused: false });
export const intake = (status: "running" | "interrupted" | "stopped" | "none") => frame({ type: "intake", status });

type EmitStep = ReturnType<typeof frame>;
type AnyEmit = ReturnType<typeof press> | ReturnType<typeof surface> | EmitStep;
type Raw = { readonly _tag: "Raw"; readonly step: AnyEmit };
export const raw = (step: AnyEmit): Raw => ({ _tag: "Raw", step });
export const frameRaw = (f: LiveFrame): Raw => raw(frame(f));
export const snapshotFrameRaw = (snapshot: Snapshot): Raw => raw(snapshotFrame(snapshot));
type MeetingStep = SceneStep<Model, MeetingMessage, undefined> | Raw;
const expand = (step: MeetingStep): SceneStep<Model, MeetingMessage, undefined>[] =>
  "_tag" in step && step._tag === "Raw" ? [quiet, (step as Raw).step] : "_tag" in step && step._tag === "SubscriptionMessageStep" ? [quiet, step as EmitStep, settle] : [step as SceneStep<Model, MeetingMessage, undefined>];

export const meetingScene = (model: Model, ...steps: ReadonlyArray<MeetingStep>): void => scene(app, given(model), ...steps.flatMap(expand), settle, quiet);

export const referenceOf = (snapshot: Snapshot, isMac = false): MapSurface.Model =>
  MapSurface.update(MapSurface.init(snapshot, "live", isMac), MapSurfaceMessage.MeasuredMapSurface({ ...SIZE, nodeHeights: HEIGHTS })).model;

type Mods = { metaKey: boolean; ctrlKey: boolean; altKey: boolean };
const NONE: Mods = { metaKey: false, ctrlKey: false, altKey: false };
const VIEW_KEYS = ["F", "=", "-", "0", "Z", "Shift+ArrowLeft", "Shift+ArrowRight", "Shift+ArrowUp", "Shift+ArrowDown"] as const;
const ARROWS = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" } as const;
export const referencePress = (model: MapSurface.Model, key: KeyId, mods: Mods = NONE): MapSurface.Model => {
  if ((VIEW_KEYS as readonly string[]).includes(key)) return MapSurface.pressViewKey(model, { key: key as (typeof VIEW_KEYS)[number], ...mods }).model;
  if (key in ARROWS) return MapSurface.pressArrowKey(model, { dir: ARROWS[key as keyof typeof ARROWS], ...mods }).model;
  if (key === "Escape") return MapSurface.pressEscapeKey(model, mods).model;
  if (key === "Enter") return MapSurface.pressEnterKey(model, mods).model;
  if (key === "E") return MapSurface.pressSideKey(model, mods).model;
  throw new Error(`referencePress: 表示面に渡すキーではない ${key}`);
};
export const referenceUpdate = (model: MapSurface.Model, message: MapSurfaceMessage): MapSurface.Model => MapSurface.update(model, message).model;

export type Sim = SceneSimulation<Model, Message, undefined>;

export const texts = (html: VNode, css: string): string[] => findAll(html, css).map(textContent);
const numbers = (s: string): number[] => (s.match(/-?\d+(?:\.\d+)?(?:e-?\d+)?/g) ?? []).map(Number);

export const layoutOutline = (html: VNode): string[] => elementsOf(one(html, ".layout")).map((child) => semanticClassesOf(attrOf(child, "class") ?? "")[0] ?? "");
export const selectedIds = (html: VNode): string[] =>
  findAll(html, "[data-node-id]")
    .filter((wrapper) => findAll(wrapper, 'button[aria-pressed="true"]').length > 0)
    .map((v) => attrOf(v, "data-node-id")!);
export const viewportOf = (html: VNode): { x: number; y: number; zoom: number } => {
  const [x, y, zoom] = numbers(styleOf(one(html, ".map-viewport"))["transform"] ?? "");
  return { x: x!, y: y!, zoom: zoom! };
};
export const nodePositionsOf = (html: VNode): Record<string, { x: number; y: number }> =>
  Object.fromEntries(
    findAll(html, "[data-node-id]").map((wrapper) => {
      const [x, y] = numbers(styleOf(wrapper)["transform"] ?? "");
      return [attrOf(wrapper, "data-node-id")!, { x: x!, y: y! }];
    }),
  );

export const shapeOf = (vnode: VNode | string): unknown =>
  typeof vnode === "string"
    ? vnode
    : {
        sel: vnode.sel,
        text: vnode.text,
        data: { attrs: vnode.data?.attrs, props: vnode.data?.props, style: vnode.data?.style, class: vnode.data?.class },
        children: (vnode.children ?? []).map((child) => shapeOf(child as VNode | string)),
      };

export const matchesReference = (html: VNode, reference: MapSurface.Model) => {
  const viewport = viewportOf(html);
  expectClose(viewport.x, reference.camera.viewport.x);
  expectClose(viewport.y, reference.camera.viewport.y);
  expectClose(viewport.zoom, reference.camera.viewport.zoom);
  const positions = nodePositionsOf(html);
  const expected = MapSurface.displayedPositions(reference);
  for (const [id, position] of Object.entries(positions)) {
    expectClose(position.x, expected[id]!.x);
    expectClose(position.y, expected[id]!.y);
  }
  const selection = reference.viewing.selection?.id;
  return { selected: selectedIds(html), expectedSelected: selection !== undefined && selection in expected ? [selection] : [] };
};
const expectClose = (actual: number, expected: number) => expect(actual).toBeCloseTo(expected, 6);

type Step = <M, Msg, Out>(simulation: SceneSimulation<M, Msg, Out>) => SceneSimulation<M, Msg, Out>;
const mountStep = (name: string): Step | undefined =>
  name === "ObserveMapSurface"
    ? Mount.resolve(ObserveMapSurface, MapSurfaceMessage.MeasuredMapSurface({ ...SIZE, nodeHeights: HEIGHTS }))
    : name === "AnchorPopover"
      ? Mount.resolve(Popover.AnchorPopover, Popover.Message.CompletedAnchorPopover())
      : name === "SlideCaptions"
        ? Mount.resolve(SlideCaptions, SessionLayoutMessage.CompletedSlideCaptions())
        : undefined;
const commandStep = (name: string, args: unknown): Step | undefined => {
  if (name === "RequestSelfPause") return Command.resolveAll([RequestSelfPause, Message.CompletedRequestSelfPause()]);
  if (name === "RequestSpeakerName") return Command.resolveAll([RequestSpeakerName, SessionLayoutMessage.CompletedRequestSpeakerName()]);
  if (name === "FocusSpeakerNameInput") return Command.resolveAll([FocusSpeakerNameInput, SessionLayoutMessage.CompletedFocusSpeakerNameInput()]);
  if (name === "RestartBlink") return Command.resolveAll([RestartBlink, MapSurfaceMessage.CompletedRestartBlink()]);
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

const endedSlides = <M, Msg, Out>(simulation: SceneSimulation<M, Msg, Out>): SceneSimulation<M, Msg, Out> => {
  try {
    return endedSlides(Mount.expectEnded(SlideCaptions)(simulation));
  } catch {
    return simulation;
  }
};

export const settle = <M, Msg, Out>(simulation: SceneSimulation<M, Msg, Out>): SceneSimulation<M, Msg, Out> => {
  for (const mount of simulation.mounts) {
    const step = mountStep(mount.name);
    if (step !== undefined) return settle(step(simulation));
  }
  return settleCommands(endedSlides(simulation));
};
export const settleCommands = <M, Msg, Out>(simulation: SceneSimulation<M, Msg, Out>): SceneSimulation<M, Msg, Out> => {
  if (simulation.mounts.some((mount) => mount.name === "SlideCaptions")) return settleCommands(Mount.resolve(SlideCaptions, SessionLayoutMessage.CompletedSlideCaptions())(simulation));
  for (const command of simulation.commands) {
    const step = commandStep(command.name, command.args);
    if (step !== undefined) return settleCommands(step(simulation));
  }
  return simulation;
};

export const commandNames = (simulation: { commands: ReadonlyArray<{ name: string }> }): string[] => simulation.commands.map((c) => c.name).sort();
export const selfPauseRequests = (simulation: { commands: ReadonlyArray<{ name: string; args?: unknown }> }): boolean[] =>
  simulation.commands.filter((c) => c.name === "RequestSelfPause").map((c) => (c.args as { paused: boolean }).paused);
export const speakerNameRequests = (simulation: { commands: ReadonlyArray<{ name: string; args?: unknown }> }): Array<{ label: string; name: string }> =>
  simulation.commands.filter((c) => c.name === "RequestSpeakerName").map((c) => c.args as { label: string; name: string });
export const timers = (simulation: { commands: ReadonlyArray<{ name: string; args?: unknown }> }) => simulation.commands.filter((c) => c.name === "WaitBeforeDismissal");
export const expire = (simulation: Sim): Sim => {
  const { entryId, version, duration } = timers(simulation)[0]!.args as { entryId: string; version: number; duration: Duration.Duration };
  return Command.resolve(Toast.WaitBeforeDismissal({ entryId, version, duration }), Toast.Message.CompletedWaitBeforeDismissal({ entryId, version }))(simulation);
};
export const quiet = <M, Msg, Out>(simulation: SceneSimulation<M, Msg, Out>): SceneSimulation<M, Msg, Out> => {
  const pending = timers(endedSlides(simulation))[0];
  if (pending === undefined) return endedSlides(simulation);
  const { entryId, version, duration } = pending.args as { entryId: string; version: number; duration: Duration.Duration };
  return quiet(Command.resolve(Toast.WaitBeforeDismissal({ entryId, version, duration }), Toast.Message.CompletedWaitBeforeDismissal({ entryId, version: version + 1000 }))(endedSlides(simulation)));
};

export const settleStory = <M, Msg>(simulation: StorySimulation<M, Msg>): StorySimulation<M, Msg> => {
  const pending = simulation.commands.find((c) => c.name === "WaitForPaint" || c.name === "WaitForAnimationSettled" || c.name === "RestartBlink");
  if (pending === undefined) return simulation;
  if (pending.name === "RestartBlink") return settleStory(StoryCommand.resolve(RestartBlink, MapSurfaceMessage.CompletedRestartBlink())(simulation));
  return settleStory(resolveNoticeMotion(simulation, pending));
};
