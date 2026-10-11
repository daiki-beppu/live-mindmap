// セッション: 発言の流れを受け、差分更新を呼んでマップを組み立てる。
// WebSocket・CLI・Node の実行環境に依存しない（ADR 0003）。差分更新（DiffUpdater）とログの書き先（SessionLog）は Service で受ける。
import { Cause, Context, Effect, Exit, Fiber, FiberHandle, Predicate, Ref, Result, Schema, Stream, type Scope } from "effect";
import { diffMaps, type Change } from "./changes.ts";
import { DIFF_UPDATE_RETRY_MS, DiffUpdatePausedEvent, DiffUpdateRetryEvent, DiffUpdateResumedEvent, DiffUpdateStateEvent, type DiffUpdateLifecycle, type DiffUpdateState } from "./diffUpdate.ts";
import { toJsonExport, type JsonExport } from "./export.ts";
import { applyOps, cloneNode, Dropped, emptyMap, Op, pointStatus, type DiffOutput, type MapNode, type MeetingMap, type PointStatus } from "./map.ts";
import { lastChangedNode, nextCurrentTopic } from "./topic.ts";

export const Track = Schema.Literals(["自分", "相手"]);
export type Track = typeof Track["Type"];

// 発言（GLOSSARY.md）
export const Remark = Schema.Struct({
  id: Schema.String,
  track: Track,
  start: Schema.Finite, // 会議の中の秒
  end: Schema.Finite,
  text: Schema.mutableKey(Schema.String),
  duplicate: Schema.optionalKey(Schema.Boolean), // 重複の印。付いた発言は差分更新に使わない
});
export type Remark = typeof Remark["Type"];

// 共有画面の変化: start（映り始めた会議の秒）から、image の画面が映る。null は何も映らない。
// image の id は画像の識別、bytes は送る JPEG（core は Node に依存しないので Uint8Array）
export type ScreenChange = {
  readonly start: number;
  readonly image: { readonly id: string; readonly bytes: Uint8Array } | null;
};

// ルートの ID はいつも ROOT_ID
export type DiffInput = {
  map: MeetingMap;
  recent: Remark[]; // 直前に処理済みの発言（文脈用）
  fresh: Remark[]; // 新しい発言
  screens?: readonly ScreenChange[]; // 添える共有画面（時刻順）。添えるものが無い呼び出しではキーごと付けない
  previousScreens?: readonly ScreenChange[]; // この呼び出しより前に最後に添えた共有画面（古い順・最大 2 件）。query を開き直したときの最初のメッセージに送り直す。無ければキーごと付けない
};
// 差分更新の失敗の形。core は具体の失敗の型を知らず、タグと文面だけを見る（ログの error 欄に使う）
export type DiffUpdateError = { readonly _tag: string; readonly message: string };

// 差分更新 1 回の呼び出しで使ったトークン数。cacheWrite / cacheRead は prompt cache の書き込み・読み出し。
// 金額は持たない（単価は変わるので、費用は公式の単価を掛けて出す）
export const DiffUsage = Schema.Struct({
  input: Schema.Int,
  cacheWrite: Schema.Int,
  cacheRead: Schema.Int,
  output: Schema.Int,
  model: Schema.String,
});
export type DiffUsage = typeof DiffUsage["Type"];
// 差分更新の結果。トークン数を数えられない実装は usage を返さない。
export type DiffResult = DiffOutput & { readonly usage?: DiffUsage };

// 差分更新を出す役。セッションごとの Service（SessionSinks.open がセッションごとに Layer を作る）。
// core は Claude 側を import できないので static layer は持たない。Layer は src 側が作る
export class DiffUpdater extends Context.Service<DiffUpdater, {
  readonly update: (input: DiffInput) => Effect.Effect<DiffResult, DiffUpdateError>;
  readonly lifecycle?: Stream.Stream<DiffUpdateLifecycle>;
}>()("live-mindmap/core/DiffUpdater") {}

// ログの行の形。ログに書く側（cli・sessionSinks の配線）も読む側（restoreSession）も同じ Schema を使う。
// 配線側が `{ at, ...event }` で書くので、余分なキーは厳格にしない（保存済みのログを読めなくしない）
// セッションの始まり。ルートの本文（タイトル）を残す
export const StartEvent = Schema.Struct({
  type: Schema.Literal("start"), title: Schema.String,
  model: Schema.optionalKey(Schema.Struct({ name: Schema.String, route: Schema.String, local: Schema.Boolean })),
});
// noContent は、中身のない発言（hasContent が false）として差分更新・未反映の発言から外したことの印。ログにだけ付く
export const RemarkEvent = Schema.Struct({ type: Schema.Literal("remark"), remark: Remark, noContent: Schema.optionalKey(Schema.Literal(true)) });
// ログの中の共有画面の参照。image は screens/ のファイル名、null は何も映らない
const ScreenRef = Schema.Struct({ start: Schema.Finite, image: Schema.NullOr(Schema.String) });
export const ScreenEvent = Schema.Struct({ type: Schema.Literal("screen"), start: Schema.Finite, image: Schema.NullOr(Schema.String) });
// 共有画面を見ていない印。reason は 指定（--no-screen）か 許可なし（画面収録の許可が無い）。画像の送受信とは別の行で、差分更新・Claude へのメッセージには載らない
export const ScreenOffEvent = Schema.Struct({ type: Schema.Literal("screen-off"), start: Schema.Finite, reason: Schema.Literals(["指定", "許可なし"]) });
export const ScreenInputSkippedEvent = Schema.Struct({
  type: Schema.Literal("screen-input-skipped"),
  reason: Schema.Literal("差分更新には渡さない（モデルが画像を読まない）"),
});
export const DiffEvent = Schema.Struct({
  type: Schema.Literal("diff"),
  // input は入力の要約: 渡した発言の ID と、呼び出した時点のノード数（ルートを除く）。
  // screenCount は、添える画面を選んだ時点までに受け取った共有画面の数（screen の行の受け取り順で先頭から数える）。復元は、その数より前の画面だけを処理済みにする
  input: Schema.Struct({
    recent: Schema.mutable(Schema.Array(Schema.String)),
    fresh: Schema.mutable(Schema.Array(Schema.String)),
    nodeCount: Schema.Finite,
    screens: Schema.optionalKey(Schema.mutable(Schema.Array(ScreenRef))), // 添えた共有画面。添えた画面が無い呼び出しには付かない
    screenCount: Schema.optionalKey(Schema.Finite), // 選んだ時点までに受け取った共有画面の数。0 のときは付かない
  }),
  ops: Schema.mutable(Schema.Array(Op)),
  dropped: Schema.mutable(Schema.Array(Dropped)),
  error: Schema.optionalKey(Schema.String),
  processedRemarks: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
  usage: Schema.optionalKey(DiffUsage), // この呼び出しのトークン数。数えられない実装・失敗した呼び出しには付かない
});
export const LogEvent = Schema.Union([StartEvent, RemarkEvent, ScreenEvent, ScreenOffEvent, ScreenInputSkippedEvent, DiffEvent, DiffUpdatePausedEvent, DiffUpdateRetryEvent, DiffUpdateResumedEvent, DiffUpdateStateEvent]);
export type LogEvent = typeof LogEvent["Type"];

// ログを書く役。core から見て失敗しない（書けないときは書き手が defect にする）。
// export.json の書き直し・publish などの副作用は、この Service を提供する配線側が持つ
export class SessionLog extends Context.Service<SessionLog, {
  readonly write: (event: LogEvent) => Effect.Effect<void>;
  // 共有画面の画像（file はセッションのフォルダの screens/ に置く名前）。バイト列はそのまま書く。ファイルへ書くのは配線側（ADR 0003）
  readonly writeScreen: (file: string, bytes: Uint8Array) => Effect.Effect<void>;
  // writeScreen で書いた画像を読み戻す。差分更新に添える画像だけを、添えるときに読む（発言のない間は画像のバイト列をメモリに持たない）
  readonly readScreen: (file: string) => Effect.Effect<Uint8Array>;
}>()("live-mindmap/core/SessionLog") {}

// ログの行が読めない（見分けた type で項目が壊れている・start や発言が足りない）。index は events の 0 始まりの位置
export class InvalidLogEvent extends Schema.TaggedError<InvalidLogEvent>()("InvalidLogEvent", {
  index: Schema.Finite,
  reason: Schema.String,
}) {}

// 論点の状態は保存していないので、スナップショットを作るときに導いて載せる
export type SnapshotNode = MapNode & { pointStatus?: PointStatus };
// 変わったこと（反映の履歴）。round は成功した反映の通し番号、at は反映に渡した新しい発言の end の最大値（会議の中の秒）。
export type ChangeEntry = Change & { round: number; at: number };
// remarks は、いまのノードの根拠に挙がっている発言だけ（受け取った順・重複なし）。evidence の ID から引く。
// currentTopic は今の議題の ID（まだ無ければキーごと付けない）。now は会議の今の時刻（最後に受け取った発言の end。発言が無ければキーごと付けない）。
export type Snapshot = {
  nodes: SnapshotNode[];
  round: number;
  changes: ChangeEntry[];
  remarks: Remark[];
  currentTopic?: string;
  lastChanged?: string; // 今の round で最後に変わったノードの ID（変わったノードが無ければキーごと付けない）
  now?: number;
};

const BATCH = 2;
export const QUIET_MS = 1500; // 最後の発言からこの時間、次の発言が来なければ、1 つでも差分更新を呼ぶ
const RECENT = 3;

// 中身のない発言の判定に使うフィラー（長音 ー〜~ を除いた形）。確定した発言の語がこれだけなら中身なしとする
export const FILLERS: ReadonlySet<string> = new Set([
  "あ", "え", "う", "お", "ん", "うん", "ふん", "ええ", "はあ", "へえ", "ほう",
  "あの", "えっと", "えと", "その", "まあ", "はい",
]);

// 発言が差分更新に渡す中身を持つか。空白・句読点で語に分け、長音を除いた各語がすべてフィラーなら false。
// 文字数では判定しない（「賛成」は渡す）。前方一致でもない（「はい。では…」は渡す）
export function hasContent(text: string): boolean {
  const words = text.replace(/[ー〜~]/g, "").split(/[\s\p{P}\p{S}]+/u).filter((w) => w !== "");
  return words.some((w) => !FILLERS.has(w));
}


// ログから戻せる状態（実行中の Fiber などは含まない）
export type SessionState = {
  readonly map: MeetingMap;
  readonly pending: readonly Remark[]; // 差分更新にまだ渡していない発言
  readonly processed: readonly Remark[]; // 反映済み、または通常失敗で消費した、中身のある発言
  readonly remarks: readonly Remark[]; // 受け取ったすべての発言（重複の印つきも含む）
  readonly known: ReadonlySet<string>; // 反映済み、または通常失敗で消費した発言の ID
  readonly round: number; // 成功した反映の通し番号
  readonly changes: readonly ChangeEntry[]; // 反映ごとに積む、変わったことの履歴
  readonly currentTopic: string | undefined; // 今の議題の ID。変わったノードのある反映で更新する
  readonly lastChanged: string | undefined; // 直近の反映で最後に変わったノードの ID。変わったノードが無ければ undefined
};

// ログから戻す共有画面の状態。画像は参照（screens/ のファイル名）だけで、バイト列は restoreSession が読む手段で読む（core はファイルを読まない）
type ScreenRefs = { readonly start: number; readonly image: string | null };
export type RestoredScreens = {
  readonly unsent: readonly ScreenRefs[]; // まだ添えていない変化
  readonly last: readonly ScreenRefs[]; // 最後に添えた画面（新しい最大 2 件）
  readonly files: ReadonlySet<string>; // 使ったファイル名
  readonly received: number; // 受け取った共有画面の総数（screen の行の数）
};

type History = Pick<SessionState, "round" | "changes" | "currentTopic" | "lastChanged">;

// 成功した反映を 1 回記録して、新しい履歴を返す。変化がなくても round は進める（前回の赤い枠を消すため）。
// ライブ（callUpdater）と復元（restoreState）が同じ関数を通す。
// 反映の番号（増やす前の round + 1）と時刻（渡した新しい発言の end の最大値）。applyOps と recordRound に同じ値を渡す。
export const stampOf = (history: { round: number }, fresh: readonly Remark[]) => ({ round: history.round + 1, at: Math.max(...fresh.map((r) => r.end)) });

function recordRound(history: History, before: MeetingMap, applied: { map: MeetingMap; changeOrder: string[] }, stamp: { round: number; at: number }): History {
  const { round, at } = stamp;
  const added = diffMaps(before, applied.map).map((c): ChangeEntry => ({ ...c, round, at }));
  // 最後に変わったノードは一度だけ選び、今の議題と lastChanged の両方をそこから作る
  const lastChanged = lastChangedNode(applied.map, applied.changeOrder);
  return {
    round,
    changes: [...history.changes, ...added],
    lastChanged,
    currentTopic: nextCurrentTopic(applied.map, lastChanged, history.currentTopic),
  };
}

const typeOf = (event: unknown): unknown => (Predicate.isObject(event) && "type" in event ? event.type : undefined);

const decodeStart = Schema.decodeUnknownEffect(StartEvent);
const decodeRemark = Schema.decodeUnknownEffect(RemarkEvent);
const decodeDiff = Schema.decodeUnknownEffect(DiffEvent);
const decodeScreen = Schema.decodeUnknownEffect(ScreenEvent);

// ログのイベントを順に適用関数へ流して、状態を元に戻す。差分更新は呼ばない。
// 行ごとに type を見分けてから、その type の Schema で decode する。start・remark・screen・diff 以外（screen-off・screen-input-skipped・intake-*・知らない type）は読み飛ばす。
// まだ添えていない変化は、screen の行を受け取り順に積み、後ろの diff で、その diff の screenCount より前に受け取った画面のうち、
// 区切り（渡した新しい発言の end の最大値）以下に映り始めたものを外して求める（選んだ後に受け取った画面は、時刻が区切り以下でも残す）。
export const restoreState = Effect.fnUntraced(function* (events: Iterable<unknown>): Effect.fn.Return<SessionState & { readonly screens: RestoredScreens }, InvalidLogEvent> {
  let map: MeetingMap | undefined;
  const remarks: Remark[] = [];
  const processed: Remark[] = [];
  const known = new Set<string>();
  let history: History = { round: 0, changes: [], currentTopic: undefined, lastChanged: undefined };
  let unsent: (ScreenRefs & { readonly seq: number })[] = [];
  let received = 0;
  let attached: ScreenRefs[] = [];
  const files = new Set<string>();
  let index = -1;
  for (const event of events) {
    index++;
    const invalid = (reason: string) => new InvalidLogEvent({ index, reason });
    const type = typeOf(event);
    if (type === StartEvent.fields.type.literal) {
      const e = yield* decodeStart(event).pipe(Effect.mapError((error) => invalid(error.message)));
      map = emptyMap(e.title);
    } else if (type === RemarkEvent.fields.type.literal) {
      const e = yield* decodeRemark(event).pipe(Effect.mapError((error) => invalid(error.message)));
      remarks.push(e.remark);
    } else if (type === ScreenEvent.fields.type.literal) {
      const e = yield* decodeScreen(event).pipe(Effect.mapError((error) => invalid(error.message)));
      unsent.push({ start: e.start, image: e.image, seq: received++ });
      if (e.image !== null) files.add(e.image);
    } else if (type === DiffEvent.fields.type.literal) {
      const e = yield* decodeDiff(event).pipe(Effect.mapError((error) => invalid(error.message)));
      if (!map) return yield* invalid("ログの diff より前に start がありません");
      const fresh: Remark[] = [];
      for (const id of e.input.fresh) {
        const r = remarks.find((x) => x.id === id);
        if (!r) return yield* invalid(`ログに発言がありません: ${id}`);
        fresh.push(r);
      }
      const count = e.error !== undefined ? fresh.length : e.processedRemarks ?? fresh.length;
      if (count > fresh.length) return yield* invalid("diff の反映数が入力の発言数を超えています");
      const consumed = fresh.slice(0, count);
      for (const r of consumed) {
        known.add(r.id);
        if (hasContent(r.text)) processed.push(r);
      }
      const selectedBefore = e.input.screenCount ?? 0;
      if (selectedBefore > received) return yield* invalid(`diff の screenCount ${selectedBefore} が、ここまでの screen の行の数 ${received} より大きい`);
      if (fresh.length) {
        const cutoff = Math.max(...fresh.map((r) => r.end));
        unsent = unsent.filter((h) => h.seq >= selectedBefore || h.start > cutoff);
      }
      attached = [...attached, ...(e.input.screens ?? [])].slice(-LAST_SCREENS);
      const stamp = stampOf(history, consumed);
      const applied = applyOps(map, e.ops, known, stamp);
      if (e.error === undefined) history = recordRound(history, map, applied, stamp);
      map = applied.map;
    }
  }
  if (!map) return yield* new InvalidLogEvent({ index: 0, reason: "ログに start がありません" });
  const pending = remarks.filter((r) => !r.duplicate && !known.has(r.id) && hasContent(r.text));
  return { map, pending, processed, remarks, known, ...history, screens: { unsent: unsent.map(({ start, image }) => ({ start, image })), last: attached, files, received } };
});

// 状態からスナップショットを作る（純粋）
export function snapshotOf(state: SessionState): Snapshot {
  const { map } = state;
  const nodes = map.order.map((id): SnapshotNode => {
    const n = cloneNode(map.nodes[id]!);
    return n.kind === "論点" ? { ...n, pointStatus: pointStatus(map, id) } : n;
  });
  const cited = new Set(nodes.flatMap((n) => n.evidence));
  const last = state.remarks.at(-1);
  return {
    nodes,
    round: state.round,
    changes: state.changes.map((c) => ({ ...c })),
    remarks: state.remarks.filter((r) => cited.has(r.id)).map((r) => ({ ...r })),
    ...(state.currentTopic !== undefined ? { currentTopic: state.currentTopic } : {}),
    ...(state.lastChanged !== undefined ? { lastChanged: state.lastChanged } : {}),
    ...(last ? { now: last.end } : {}),
  };
}

export type Session = {
  readonly push: (remark: Remark) => Effect.Effect<void>;
  // 呼び出し中のものと、それに続けて起きた呼び出しがすべて終わるまで待つ
  readonly idle: Effect.Effect<void>;
  // 共有画面の変化を受ける。差分更新は呼ばない。画像は writeScreen に渡し、変化ごとに screen の行を書く。
  // 差分更新に添える画面は、次の呼び出しの中で選ぶ
  readonly pushScreen: (change: ScreenChange) => Effect.Effect<void>;
  // 共有画面を見ていない印を受ける。受け取った start・reason のまま screen-off の行を 1 行書くだけで、
  // 差分更新・添える画面・受け取った画面の数は変えない（Claude へのメッセージに載らない）
  readonly pushScreenOff: (off: Pick<typeof ScreenOffEvent["Type"], "start" | "reason">) => Effect.Effect<void>;
  // 終わりに、2 つに満たず待ちも切れていない発言も流す（最後の発言を取りこぼさない）
  readonly flush: Effect.Effect<void>;
  readonly snapshot: Effect.Effect<Snapshot>;
  readonly diffUpdate: Effect.Effect<DiffUpdateState>;
  // まだマップに反映していない発言（差分更新の結果待ち + 渡していないもの）。仮のノードの文字に使う。重複の印つき・中身のない発言は含まない
  readonly unreflectedRemarks: Effect.Effect<Remark[]>;
  // その時点のマップのエクスポート（JSON）
  readonly exportJson: Effect.Effect<JsonExport>;
};

// 差分更新の呼び出し中を表す。Fiber を作る前は予約の印だけを置く（fork から戻る前に終わった呼び出しを、終わった Fiber で上書きしないため）
type Reservation = { readonly kind: "reserved" };
type InFlight = Reservation | { readonly kind: "running"; readonly fiber: Fiber.Fiber<void> };

type Runtime = {
  readonly retryEnabled: boolean; // 終了のflushが始まったら、書き出し中も再試行を起動しない
  readonly diffUpdate: DiffUpdateState;
  readonly inFlight: InFlight | undefined;
  readonly quiet: boolean; // 最後の発言から QUIET_MS 経った。呼び出し中に経った場合も、終わった時点で 1 つで流す
  readonly reflecting: readonly Remark[]; // 差分更新の結果待ちの発言。結果を log する直前に外す
  readonly unsentScreens: readonly HeldScreen[]; // まだ差分更新に添えていない共有画面の変化（受け取った順）
  readonly screenFiles: ReadonlySet<string>; // 画像に付けたファイル名
  readonly lastScreens: readonly HeldScreen[]; // 最後に添えた共有画面（古い順・最大 LAST_SCREENS 件）。失敗した回に選んだ画面も数える。画像はファイル名だけで、送るときに読み戻す
  readonly receivedScreens: number; // 受け取った共有画面の総数。diff の行の screenCount に使う
};

// 差分更新に添えるまで持つのは、画像のバイト列ではなく、書いたファイル名（file）だけ
type HeldScreen = { readonly start: number; readonly image: { readonly id: string; readonly file: string } | null };

const LAST_SCREENS = 2; // query を開き直したときに送り直す、最後に添えた共有画面の件数
const SCREENS_MAX = 3; // 1 回の呼び出しに添える共有画面の上限（新しいものから）

// 映り始めた時刻から付ける画像のファイル名（整数部 4 桁・小数 1 桁。例 0754.2.jpg）。重なったら 2 件目から -n を足す
function screenFileName(start: number, used: ReadonlySet<string>): string {
  const base = start.toFixed(1).padStart(6, "0");
  let name = `${base}.jpg`;
  for (let n = 2; used.has(name); n++) name = `${base}-${n}.jpg`;
  return name;
}

// 失敗した差分更新の error 欄。タグ付きの失敗は "<_tag>: <message>"、defect は "defect: <内容>"
const classifyFailure = (cause: Cause.Cause<DiffUpdateError>) => {
  const failure = Cause.findError(cause);
  return {
    ok: false as const,
    error: Result.isSuccess(failure) ? `${failure.success._tag}: ${failure.success.message}` : `defect: ${String(Cause.squash(cause))}`,
    paused: Result.isSuccess(failure) && failure.success._tag === "DiffUpdatePaused",
    stopped: Result.isSuccess(failure) && failure.success._tag === "DiffUpdateStopped",
  };
};

type InitialScreens = { readonly unsent: readonly HeldScreen[]; readonly last: readonly HeldScreen[]; readonly files: ReadonlySet<string>; readonly received: number };
const noScreens: InitialScreens = { unsent: [], last: [], files: new Set(), received: 0 };

function openSession(initial: SessionState, screens: InitialScreens, images: boolean): Effect.Effect<Session, never, Scope.Scope | DiffUpdater | SessionLog> {
  return Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const updater = yield* DiffUpdater;
    const log = yield* SessionLog;
    const ref = yield* Ref.make<SessionState & Runtime>({ ...initial, retryEnabled: true, diffUpdate: { status: "running" }, inFlight: undefined, quiet: false, reflecting: [], unsentScreens: screens.unsent, screenFiles: screens.files, lastScreens: screens.last, receivedScreens: screens.received });
    // QUIET_MS の待ち。Scope を閉じると中断される
    const quietWaiter = yield* FiberHandle.make<void, never>();

    const setLifecycleState = Effect.fnUntraced(function* (state: DiffUpdateState) {
      const changed = yield* Ref.modify(ref, (s): [boolean, SessionState & Runtime] =>
        s.diffUpdate.status === "stopped" || s.diffUpdate.status === state.status
          ? [false, s] : [true, { ...s, diffUpdate: state }]);
      if (changed) yield* log.write({ type: "diff-update-state", state });
    });
    if (updater.lifecycle) yield* Effect.forkIn(Stream.runForEach(updater.lifecycle, (notification) =>
      setLifecycleState("status" in notification ? notification : { status: "stopped" }).pipe(Effect.uninterruptible),
    ), scope, { startImmediately: true });

    // 呼び出し中でなく、発言が min 以上たまっていれば、たまった分をまとめて差分更新に渡す。
    // 呼び出しの後に 1 つしか残っていなくても、QUIET_MS 経つまでは 2 つ目を待つ（試作 v3 で確かめた入力の形に揃える）。
    // 取り出しから fork までの間に中断されて発言を取りこぼさないよう、中断させない
    function startDiffIfReady(min: number, retry = false): Effect.Effect<void> {
      return Effect.uninterruptible(
        Effect.gen(function* () {
          const reservation: Reservation = { kind: "reserved" };
          const fresh = yield* Ref.modify(ref, (s): [readonly Remark[] | undefined, SessionState & Runtime] =>
            s.inFlight || s.pending.length < min || (retry ? !s.retryEnabled || s.diffUpdate.status !== "paused" : s.diffUpdate.status === "paused" || s.diffUpdate.status === "stopped") ? [undefined, s] : [s.pending, { ...s, pending: [], inFlight: reservation }],
          );
          if (!fresh) return;
          const fiber = yield* Effect.forkIn(Effect.interruptible(runCall(fresh)), scope, { startImmediately: true });
          // fork から戻る前に呼び出しが終わっていたら（印が自分のものでなければ）置き換えない
          yield* Ref.update(ref, (s) => (s.inFlight === reservation ? { ...s, inFlight: { kind: "running" as const, fiber } } : s));
        }),
      );
    }

    // 呼び出しが終わったら印を外し、続きがあれば次を呼ぶ。中断で終わったときは続けない
    function runCall(fresh: readonly Remark[]): Effect.Effect<void> {
      return callUpdater(fresh).pipe(
        Effect.onExit((exit) =>
          Effect.gen(function* () {
            const quiet = yield* Ref.modify(ref, (s): [boolean, SessionState & Runtime] => [s.quiet, { ...s, inFlight: undefined }]);
            if (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)) return;
            const state = yield* Ref.get(ref);
            if (state.diffUpdate.status === "paused") {
              if (state.retryEnabled) yield* Effect.forkIn(Effect.sleep(DIFF_UPDATE_RETRY_MS).pipe(Effect.andThen(startDiffIfReady(1, true))), scope);
              return;
            }
            yield* startDiffIfReady(quiet || (Exit.isSuccess(exit) && exit.value) ? 1 : BATCH);
          }),
        ),
        Effect.asVoid,
      );
    }

    // update だけを中断可能にする。状態の反映から SessionLog.write までは中断させない
    function callUpdater(fresh: readonly Remark[]): Effect.Effect<boolean> {
      return Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const state = (yield* Ref.get(ref)).diffUpdate;
          if (state.status === "paused") yield* log.write({ type: "diff-update-retry", reason: state.reason });
          const { map, recent, input, attached, previous } = yield* Ref.modify(ref, (s) => {
            const recent = s.processed.slice(-RECENT);
            // 添える共有画面: 新しい発言の end の最大値以下に映り始めた、まだ添えていない変化を時刻順に並べ、新しい SCREENS_MAX 件。
            // 候補はすべて処理済みにする（添えなかった古い変化を後から送ると、映り続ける画面と食い違う）。後に映り始めた変化は次へ回す
            const cutoff = Math.max(...fresh.map((u) => u.end));
            const candidates = s.unsentScreens.filter((h) => h.start <= cutoff).sort((a, b) => a.start - b.start);
            const attached = images ? candidates.slice(-SCREENS_MAX) : [];
            const input = {
              recent: recent.map((u) => u.id),
              fresh: fresh.map((u) => u.id),
              nodeCount: s.map.order.length - 1,
              ...(attached.length ? { screens: attached.map((h) => ({ start: h.start, image: h.image?.file ?? null })) } : {}),
              ...(s.receivedScreens > 0 ? { screenCount: s.receivedScreens } : {}),
            };
            return [
              { map: s.map, recent, input, attached, previous: images ? s.lastScreens : [] },
              {
                ...s,
                reflecting: fresh,
                unsentScreens: s.unsentScreens.filter((h) => h.start > cutoff),
                lastScreens: [...s.lastScreens, ...attached].slice(-LAST_SCREENS),
              },
            ];
          });
          // 添える画像と送り直す画像だけを、ここで読み戻す（画像のバイト列はメモリに持たない）
          const readBack = (h: HeldScreen): Effect.Effect<ScreenChange> => {
            const held = h.image;
            return held ? Effect.map(log.readScreen(held.file), (bytes) => ({ start: h.start, image: { id: held.id, bytes } })) : Effect.succeed({ start: h.start, image: null });
          };
          // 送り直す画面は、読めなかったものを外して送る。送り直しは文脈の補いなので、読めない画像で呼び出しを失敗させない
          // （添えた回に読めず失敗した画面も「最後に添えた」に数えるため、失敗させると以後の呼び出しがすべて失敗する）
          const readPrevious = Effect.map(
            Effect.forEach(previous, (h) =>
              readBack(h).pipe(Effect.catchCause((cause) => (Cause.hasInterruptsOnly(cause) ? Effect.interrupt : Effect.void))),
            ),
            (list) => list.filter((c): c is ScreenChange => c !== undefined),
          );
          // 失敗は、添える画像の読み戻しと update の、中断以外を defect も含めて受け止める。中断のときは受け止めずに伝える
          const outcome = yield* Effect.all([Effect.forEach(attached, readBack), readPrevious]).pipe(
            Effect.flatMap(([screens, previousScreens]) =>
              restore(updater.update({ map, recent: [...recent], fresh: [...fresh], ...(screens.length ? { screens } : {}), ...(previousScreens.length ? { previousScreens } : {}) })),
            ),
            Effect.flatMap(({ ops, usage, processedRemarks }) => {
              const count = processedRemarks ?? fresh.length;
              return !Number.isInteger(count) || count <= 0 || count > fresh.length
                ? Effect.fail({ _tag: "InvalidProcessedRemarks", message: "反映数が入力の発言数に対して不正です" })
                : Effect.succeed({ ok: true as const, ops, usage, processedRemarks, count });
            }),
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause) ? Effect.interrupt : Effect.succeed(classifyFailure(cause)),
            ),
          );
          if (!outcome.ok) {
            if (outcome.stopped) {
              yield* Ref.update(ref, (s) => ({ ...s, reflecting: [], pending: [...fresh, ...s.pending] }));
              yield* setLifecycleState({ status: "stopped" });
              return false;
            }
            if (outcome.paused) {
              yield* Ref.update(ref, (s) => ({ ...s, reflecting: [], pending: [...fresh, ...s.pending], diffUpdate: { status: "paused" as const, reason: "ChatGPT の利用上限" as const } }));
              yield* log.write({ type: "diff-update-paused", reason: "ChatGPT の利用上限" });
              return false;
            }
            // 失敗した回の発言は処理済みとして扱い、マップは変えずに次へ進む
            yield* Ref.update(ref, (s) => ({ ...s, diffUpdate: s.diffUpdate.status === "paused" ? { status: "running" as const } : s.diffUpdate, reflecting: [], known: new Set([...s.known, ...fresh.map((r) => r.id)]), processed: [...s.processed, ...fresh] }));
            yield* log.write({ type: "diff", input, ops: [], dropped: [], error: outcome.error });
            return false;
          }
          // ログへ書く（SessionLog.write）より先に状態へ反映する。write の中で読むスナップショットに今回分が載る
          const dropped = yield* Ref.modify(ref, (s) => {
            const consumed = fresh.slice(0, outcome.count);
            const known = new Set([...s.known, ...consumed.map((r) => r.id)]);
            const stamp = stampOf(s, consumed);
            const applied = applyOps(s.map, outcome.ops, known, stamp);
            return [applied.dropped, {
              ...s, ...recordRound(s, s.map, applied, stamp), diffUpdate: s.diffUpdate.status === "paused" ? { status: "running" as const } : s.diffUpdate, map: applied.map, reflecting: [],
              known, processed: [...s.processed, ...consumed], pending: [...fresh.slice(outcome.count), ...s.pending],
            }];
          });
          yield* log.write({ type: "diff", input, ops: [...outcome.ops], dropped,
            ...(outcome.processedRemarks !== undefined ? { processedRemarks: outcome.processedRemarks } : {}),
            ...(outcome.usage ? { usage: outcome.usage } : {}) });
          if (state.status === "paused") yield* log.write({ type: "diff-update-resumed" });
          return outcome.count < fresh.length;
        }),
      );
    }

    const cancelWaiter = FiberHandle.clear(quietWaiter);

    // 最後の発言から QUIET_MS 新しい発言が来なければ、たまった分で差分更新を呼ぶ。新しい発言が来たら中断して取り消す。
    // 待ちが切れた後の処理は中断させない（取り出した発言を取りこぼさない）
    const waitForQuiet = Effect.asVoid(
      FiberHandle.run(
        quietWaiter,
        Effect.sleep(QUIET_MS).pipe(
          Effect.andThen(Effect.uninterruptible(Effect.andThen(Ref.update(ref, (s) => ({ ...s, quiet: true })), startDiffIfReady(1)))),
        ),
      ),
    );

    const idle: Effect.Effect<void> = Effect.gen(function* () {
      for (;;) {
        const { inFlight } = yield* Ref.get(ref);
        if (!inFlight) return;
        // 予約の印だけの間は、Fiber が置かれる（または終わる）まで順番を譲る
        if (inFlight.kind === "reserved") yield* Effect.yieldNow;
        else yield* Fiber.join(inFlight.fiber);
      }
    });

    return {
      push: (r) =>
        Effect.gen(function* () {
          yield* Ref.update(ref, (s) => ({ ...s, remarks: [...s.remarks, r] }));
          if (!r.duplicate && !hasContent(r.text)) {
            // 中身のない発言: ログには残すが、差分更新・未反映の発言・待ち時間には関わらせない
            yield* log.write({ type: "remark", remark: r, noContent: true });
            return;
          }
          yield* log.write({ type: "remark", remark: r });
          if (r.duplicate) return;
          yield* cancelWaiter;
          yield* Ref.update(ref, (s) => ({ ...s, pending: [...s.pending, r], quiet: false }));
          yield* startDiffIfReady(BATCH);
          if ((yield* Ref.get(ref)).pending.length > 0) yield* waitForQuiet;
        }),
      idle,
      pushScreen: (change) =>
        Effect.gen(function* () {
          // 名前の割り当て → 画像を書く → 差分更新に添える候補へ追加（名前だけ） → ログ。候補に載る画像は、必ず書き終えている
          const file = yield* Ref.modify(ref, (s): [string | null, SessionState & Runtime] => {
            const file = change.image ? screenFileName(change.start, s.screenFiles) : null;
            return [file, { ...s, screenFiles: file ? new Set([...s.screenFiles, file]) : s.screenFiles }];
          });
          if (change.image && file) yield* log.writeScreen(file, change.image.bytes);
          const held: HeldScreen = { start: change.start, image: change.image && file ? { id: change.image.id, file } : null };
          // 受け取った数（diff の行の screenCount）は、候補に載せるのと同時に数える。数えたのに候補に無い画面を、復元が処理済みにしないため
          yield* Ref.update(ref, (s) => ({ ...s, receivedScreens: s.receivedScreens + 1, unsentScreens: [...s.unsentScreens, held] }));
          yield* log.write({ type: "screen", start: change.start, image: file });
        }),
      pushScreenOff: ({ start, reason }) => log.write({ type: "screen-off", start, reason }),
      flush: Effect.gen(function* () {
        // Scopeは書き出し後に閉じる。再試行の予約を先に止め、予約済みの更新はidleで待ち切る。
        yield* Ref.update(ref, (s) => ({ ...s, retryEnabled: false }));
        for (;;) {
          yield* idle;
          const state = yield* Ref.get(ref);
          if (state.pending.length === 0 || state.diffUpdate.status === "paused" || state.diffUpdate.status === "stopped") return;
          yield* startDiffIfReady(1);
        }
      }),
      snapshot: Effect.map(Ref.get(ref), snapshotOf),
      diffUpdate: Effect.map(Ref.get(ref), (s) => s.diffUpdate),
      unreflectedRemarks: Effect.map(Ref.get(ref), (s) => [...s.reflecting, ...s.pending].map((r) => ({ ...r }))),
      exportJson: Effect.map(Ref.get(ref), (s) => toJsonExport(snapshotOf(s), [...s.remarks])),
    } satisfies Session;
  });
}

// 新しいセッションを開く。最初に start をログへ書く。差分更新の呼び出しと待ちはこの Scope の Fiber で、Scope を閉じると中断される
export const makeSession = Effect.fnUntraced(function* ({ title, images = true }: { readonly title: string; readonly images?: boolean }): Effect.fn.Return<Session, never, Scope.Scope | DiffUpdater | SessionLog> {
  const log = yield* SessionLog;
  yield* log.write({ type: "start", title });
  if (!images) yield* log.write({
    type: ScreenInputSkippedEvent.fields.type.literal,
    reason: ScreenInputSkippedEvent.fields.reason.literal,
  });
  return yield* openSession({
    map: emptyMap(title),
    pending: [],
    processed: [],
    remarks: [],
    known: new Set(),
    round: 0,
    changes: [],
    currentTopic: undefined,
    lastChanged: undefined,
  }, noScreens, images);
});

// ログのイベントから、セッションを元の状態に戻す。差分更新は呼ばず、イベントも log し直さない。
// 共有画面は、まだ添えていない変化と最後に添えた 2 件を、screens/ のファイル名だけで戻す（復元した画像の id はファイル名）。
// 画像のバイト列は、ライブと同じく、続きの呼び出しで添える・送り直すときに SessionLog.readScreen で読み戻す（core はファイルを読まない）
export const restoreSession = Effect.fnUntraced(function* (events: Iterable<unknown>): Effect.fn.Return<Session, InvalidLogEvent, Scope.Scope | DiffUpdater | SessionLog> {
  const { screens, ...state } = yield* restoreState(events);
  const hold = (ref: ScreenRefs): HeldScreen => ({ start: ref.start, image: ref.image === null ? null : { id: ref.image, file: ref.image } });
  return yield* openSession(state, { unsent: screens.unsent.map(hold), last: screens.last.map(hold), files: screens.files, received: screens.received }, true);
});
