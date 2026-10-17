// 見返しの操作の行（Issue #825）の Story・Scene が共有する道具。テストではなく、題材の会議・Context・保留中の Command と Mount を解く step・描いた木を読む関数だけを置く。
import * as Animation from "@foldkit/ui/animation";
import * as Menu from "@foldkit/ui/menu";
import * as Popover from "@foldkit/ui/popover";
import * as Tooltip from "@foldkit/ui/tooltip";
import { Option, Schema } from "effect";
import type { MountDefinition } from "foldkit/mount";
import { Command as StoryCommand, type StorySimulation } from "foldkit/story";
import { Command, Mount, type SceneSimulation } from "foldkit/scene";
import { Message as MapSurfaceMessage } from "../src/app/mapSurface/message.ts";
import { RestartBlink } from "../src/app/mapSurface/command.ts";
import { ObserveMapSurface } from "../src/app/mapSurface/mount.ts";
import { PauseAudio, PlayAudio, ReleaseFocus, ReleaseFocusAfterMenuClose, SeekAudio, WriteAudioSettings } from "../src/app/review/command.ts";
import { makeContext, type Context } from "../src/app/review/context.ts";
import { init, makeUpdate, makeView, snapshotOf, type Model } from "../src/app/review/main.ts";
import { Message } from "../src/app/review/message.ts";
import { ObserveAudio, ObserveSeekPointer } from "../src/app/review/mount.ts";
import { Message as SessionLayoutMessage } from "../src/app/sessionLayout/message.ts";
import { SlideCaptions } from "../src/app/sessionLayout/mount.ts";
import { foldView } from "../src/folding.ts";
import { resolveNoticeMotion } from "./noticeMotion.ts";
import { attrOf, elementsOf, one, type VNode } from "./sceneTree.ts";

// ---- 題材の会議 ----
// 議題 A（0〜100 秒）→ 議題 B（100〜200 秒）。B の中の 160 秒に TODO が 1 つ。会議の長さは 200 秒（最後の発言の end）。
// 章は [A: 0〜100, B: 100〜200]、目印は [TODO: 160 秒]
const remark = (id: string, start: number, end: number, text: string) => ({ at: "x", type: "remark", remark: { id, track: "相手", start, end, text } });
const add = (ref: string, parent: string, kind: string, text: string, evidence: string[]) => ({ op: "add", ref, parent, kind, text, evidence });
const diff = (fresh: string[], ops: unknown[]) => ({ at: "x", type: "diff", input: { recent: [], fresh, nodeCount: 0 }, ops, dropped: [] });
export const events: unknown[] = [
  { at: "a", type: "start", title: "定例" },
  remark("r1", 0, 10, "採用の話をします。"),
  diff(["r1"], [add("a", "root", "議題", "A", ["r1"])]), // n1
  remark("r2", 10, 100, "予算に移ります。"),
  diff(["r2"], [add("b", "root", "議題", "B", ["r2"])]), // n2
  remark("r3", 100, 160, "資料を送ります。"),
  diff(["r3"], [add("t", "n2", "TODO", "資料を送る", ["r3"])]), // n3
  remark("tail", 160, 200, "以上です。"),
];
export const DURATION = 200;
export const AUDIO_URL = "blob:review-audio";

export const audioContext: Context = makeContext(events, { maybeAudioUrl: Option.some(AUDIO_URL) });
export const plainContext: Context = makeContext(events);
// 速さの並びが 1 つだけの録音なしの Context（速さのメニューを出さない）
export const singleRateContext: Context = { ...plainContext, playback: { ...plainContext.playback, rates: [30] } };

export const appOf = (context: Context) => ({ update: makeUpdate(context), view: makeView(context) });
export const audioApp = appOf(audioContext);
export const plainApp = appOf(plainContext);

// Context の最初の Model から、再生の状態の一部だけを替えた Model。止まった状態が既定
export const stateAt = (context: Context, time: number, patch: Partial<Model["playback"]> = {}): Model => {
  const start = init(context);
  return { ...start, playback: { ...start.playback, time, playing: false, ...patch } };
};

// 右の列を隠した状態の Model。右の列の出し入れは表示面の見る状態（viewing.sideHidden）が持つ（見返しの Model に別の欄は無い）
export const sideHiddenOf = (model: Model): Model => ({ ...model, mapSurface: { ...model.mapSurface, viewing: { ...model.mapSurface.viewing, sideHidden: true } } });

// その時刻のマップに出るノードの id（表示面の描き方と同じ純粋な関数 foldView）
export const expectedIds = (context: Context, time: number): string[] =>
  foldView(snapshotOf(context, stateAt(context, time)), new Set(), null, new Set(), new Set()).nodes.map((n) => n.id);

// ---- 描いた木を読む ----
export type Sim = SceneSimulation<Model, Message, undefined>;

export const hasClass = (vnode: VNode, name: string): boolean => (attrOf(vnode, "class") ?? "").split(" ").includes(name);
export const descendants = (vnode: VNode): VNode[] => elementsOf(vnode).flatMap((child) => [child, ...descendants(child)]);
export const tagOf = (vnode: VNode): string => (vnode.sel ?? "").split(/[#.]/)[0] ?? "";
export const labelled = (html: VNode, label: string): VNode => one(html, `[aria-label="${label}"]`);


// ---- 保留中の Command と Mount を解く step ----
// Scene は保留の Command を残したまま次の操作を流せず、終わりに Mount が残っていても落ちる。操作のたびに、出た Command と Mount を「何も起こさない結果」で解く
type Step = <Model, Message, OutMessage>(simulation: SceneSimulation<Model, Message, OutMessage>) => SceneSimulation<Model, Message, OutMessage>;
// Mount.resolve の第1引数は結果型を持たない AnyMount も受けるので、組の検査が効かない。resolveMount は定義だけから結果の型を決める
const resolveMount = <Name extends string, ResultMessage>(definition: MountDefinition<Name, ResultMessage>, result: NoInfer<ResultMessage>): Step => Mount.resolve(definition, result);
// 定義と結果の Message の組は、Command.resolveAll / resolveMount の型で検査される（組を取り違えると typecheck が落ちる）
const commandSteps: Record<string, (args: unknown) => Step> = {
  PlayAudio: () => Command.resolveAll([PlayAudio, Message.SucceededPlayAudio()]),
  PauseAudio: () => Command.resolveAll([PauseAudio, Message.CompletedPauseAudio()]),
  SeekAudio: () => Command.resolveAll([SeekAudio, Message.CompletedSeekAudio()]),
  WriteAudioSettings: () => Command.resolveAll([WriteAudioSettings, Message.CompletedWriteAudioSettings()]),
  ReleaseFocus: () => Command.resolveAll([ReleaseFocus, Message.CompletedReleaseFocus()]),
  ReleaseFocusAfterMenuClose: () => Command.resolveAll([ReleaseFocusAfterMenuClose, Message.CompletedReleaseFocusAfterMenuClose()]),
  // 反映をまたいだとき、点滅を最初から再生し直す（表示面の Command）
  RestartBlink: () => Command.resolveAll([RestartBlink, MapSurfaceMessage.CompletedRestartBlink()]),
  FocusItems: () => Command.resolveAll([Menu.FocusItems, Menu.Message.CompletedFocusItems()]),
  FocusButton: () => Command.resolveAll([Menu.FocusButton, Menu.Message.CompletedFocusButton()]),
  ScrollIntoView: () => Command.resolveAll([Menu.ScrollIntoView, Menu.Message.CompletedScrollIntoView()]),
  ClickItem: () => Command.resolveAll([Menu.ClickItem, Menu.Message.CompletedClickItem()]),
  // 見る状態の知らせ（sessionLayout の Toast、#826）の出入り。出すと、描いた後に動きを始める Command が 1 つずつ続く
  WaitForPaint: (args) => {
    const { generation } = Schema.decodeUnknownSync(Schema.Struct({ generation: Schema.Number }))(args);
    return Command.resolveAll([Animation.WaitForPaint, Animation.Message.CompletedWaitForPaint({ generation })]);
  },
  WaitForAnimationSettled: (args) => {
    const { generation } = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String, generation: Schema.Number }))(args);
    return Command.resolveAll([Animation.WaitForAnimationSettled, Animation.Message.EndedAnimation({ generation })]);
  },
  WaitBeforeShowing: (args) => {
    const { version } = Schema.decodeUnknownSync(Schema.Struct({ version: Schema.Number }))(args);
    return Command.resolveAll([Tooltip.WaitBeforeShowing, Tooltip.Message.CompletedWaitBeforeShowing({ version })]);
  },
};
const mountSteps: Record<string, Step> = {
  ObserveMapSurface: resolveMount(ObserveMapSurface, MapSurfaceMessage.MeasuredMapSurface({ width: 800, height: 600, nodeHeights: {} })),
  // 止まっている間の時刻の通知は無視される。再生中の Scene では使わない
  ObserveAudio: resolveMount(ObserveAudio, Message.UpdatedAudioTime({ time: 0 })),
  ObserveSeekPointer: resolveMount(ObserveSeekPointer, Message.LeftSeekPointer()),
  AnchorTooltip: resolveMount(Tooltip.AnchorTooltip, Tooltip.Message.CompletedAnchorTooltip()),
  AnchorMenu: resolveMount(Menu.AnchorMenu, Menu.Message.CompletedAnchorMenu()),
  PortalMenuBackdrop: resolveMount(Menu.PortalMenuBackdrop, Menu.Message.CompletedPortalMenuBackdrop()),
  // キーの一覧（#822）の Popover のパネル。開いている間だけ描かれる
  AnchorPopover: resolveMount(Popover.AnchorPopover, Popover.Message.CompletedAnchorPopover()),
  // 字幕の吹き出しを滑らせる Mount（見返しの字幕もライブと同じ吹き出し）。字幕が描かれている間だけある
  SlideCaptions: resolveMount(SlideCaptions, SessionLayoutMessage.CompletedSlideCaptions()),
};

// 字幕を隠す・空にするなどで .captions ごと消えた SlideCaptions の Mount を、消えたものとして受け取る（受け取らないと、次の操作の Message が落ちる）
const endedSlides = <Model, Message, OutMessage>(simulation: SceneSimulation<Model, Message, OutMessage>): SceneSimulation<Model, Message, OutMessage> => {
  try {
    return endedSlides(Mount.expectEnded(SlideCaptions)(simulation));
  } catch {
    return simulation; // 消えた Mount が無い
  }
};

export const settle = <Model, Message, OutMessage>(simulation: SceneSimulation<Model, Message, OutMessage>): SceneSimulation<Model, Message, OutMessage> => {
  const mount = simulation.mounts[0];
  if (mount !== undefined) {
    const step = mountSteps[mount.name];
    if (step === undefined) throw new Error(`settle: 解き方を決めていない Mount "${mount.name}"（保留: ${simulation.mounts.map((m) => m.name).join(", ")}）`);
    return settle(step(simulation));
  }
  const ended = endedSlides(simulation);
  if (ended !== simulation) return settle(ended);
  const command = simulation.commands[0];
  if (command !== undefined) {
    const step = commandSteps[command.name];
    if (step === undefined) throw new Error(`settle: 解き方を決めていない Command "${command.name}"（保留: ${simulation.commands.map((c) => c.name).join(", ")}）`);
    return settle(step(command.args)(simulation));
  }
  return simulation;
};

// 保留中の Command の名前（並びは保証されないので昇順にそろえる）
export const commandNames = (commands: ReadonlyArray<{ name: string }> | undefined): string[] => (commands ?? []).map((c) => c.name).sort();

// Menu が自分で返す Command（フォーカスの移動・スクロール・クリックの代行・型検索の遅延）。見返しの Command と分けて数える
const MENU_COMMANDS = new Set(["FocusItems", "FocusButton", "ScrollIntoView", "ClickItem", "DelayClearSearch"]);
export const ownCommandNames = (commands: ReadonlyArray<{ name: string }> | undefined): string[] => commandNames(commands).filter((name) => !MENU_COMMANDS.has(name));
export const argsOf = (commands: ReadonlyArray<{ name: string; args?: unknown }> | undefined, name: string): unknown[] => (commands ?? []).filter((c) => c.name === name).map((c) => c.args);

// ボタンのツールチップの数。録音つきはミュートのボタンが増える
export const TOOLTIPS_PLAIN = 6; // 戻る・再生・進む・字幕・速さ・右の列
export const TOOLTIPS_AUDIO = 7; // + ミュート
export const tooltipMounts = (count: number) => Array.from({ length: count }, () => Tooltip.AnchorTooltip);

// Story 用: 測定済みで反映をまたぐ時刻の移動の update は、点滅を最初から再生し直す Command（RestartBlink）を出す。その Command を解く step
export const restartedBlink = StoryCommand.resolve(RestartBlink, MapSurfaceMessage.CompletedRestartBlink());

// Story 用: 見る状態の知らせ（sessionLayout の Toast）の出入りの動き（WaitForPaint / WaitForAnimationSettled）を、保留がなくなるまで全部解く。
// mode が変わる操作の後に、続けて別の操作を流すときに挟む
export const settleNotice = <Model, Message>(simulation: StorySimulation<Model, Message>): StorySimulation<Model, Message> => {
  const pending = simulation.commands.find((c) => c.name === "WaitForPaint" || c.name === "WaitForAnimationSettled");
  if (pending === undefined) return simulation;
  return settleNotice(resolveNoticeMotion(simulation, pending));
};
