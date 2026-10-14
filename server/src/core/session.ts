// セッション: 発言の流れを受け、差分更新を呼んでマップを組み立てる。
// WebSocket・CLI・Node の実行環境に依存しない（ADR 0003）。差分更新（DiffUpdater）とログの書き先（SessionLog）は Service で受ける。
import { Cause, Context, DateTime, Effect, Exit, Fiber, Predicate, Ref, Result, Schema, Stream, type Scope } from "effect";
import { diffMaps } from "./changes.ts";
import { DIFF_UPDATE_RETRY_MS, DiffUpdatePausedEvent, DiffUpdateRetryEvent, DiffUpdateResumedEvent, DiffUpdateStateEvent, type DiffUpdateLifecycle, type DiffUpdateState } from "./diffUpdate.ts";
import type { KatakanaAnswer } from "./latinWords.ts";
import { toJsonExport, type JsonExport } from "./export.ts";
import { applyOps, cloneNode, Dropped, emptyMap, Op, pointStatus, type DiffOutput, type MeetingMap } from "./map.ts";
import { lastChangedNode, nextCurrentTopic } from "./topic.ts";
import { Remark } from "./remark.ts";
import type { ChangeEntry, Snapshot, SnapshotNode } from "./snapshot.ts";
import { Word } from "./words.ts";

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
  previousResponse?: PreviousResponse; // 直前に適用した応答の、仮 ID の対応と捨てた操作。直前の差分更新が失敗した回と、どちらも空の回にはキーごと付けない
};
// 直前に適用した応答。refs は適用できた add の仮 ID → n の ID、dropped はその応答で捨てた操作と理由
export type PreviousResponse = {
  readonly refs: Readonly<Record<string, string>>;
  readonly dropped: readonly Dropped[];
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
// 判定の記録。回した先のモデル・判定にかかった ms・「含む」の確からしさ、判定できなかったときはその理由（確からしさは付かない）
const JudgeRecord = Schema.Struct({
  model: Schema.String,
  ms: Schema.Finite,
  confidence: Schema.optionalKey(Schema.Finite),
  failure: Schema.optionalKey(Schema.String),
});
type JudgeRecord = typeof JudgeRecord["Type"];
// 差分更新の結果。トークン数を数えられない実装は usage を返さない。判定を使わない実装は judge を返さない。
export type DiffResult = DiffOutput & { readonly usage?: DiffUsage; readonly judge?: JudgeRecord };
// update の失敗。判定を呼んだ回の失敗は judge を運ぶ
export type DiffUpdateFailure = DiffUpdateError & { readonly judge?: JudgeRecord };

// 差分更新を出す役。セッションごとの Service（SessionSinks.open がセッションごとに Layer を作る）。
// core は Claude 側を import できないので static layer は持たない。Layer は src 側が作る
// 英字の語のカタカナの読みを聞く口（Issue #642）。差分の会話（update）とは別の 1 回きりの呼び出しで、語は 1 度にまとめて渡す
export type KatakanaAsk = (words: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<KatakanaAnswer>, DiffUpdateError>;

export class DiffUpdater extends Context.Service<DiffUpdater, {
  readonly update: (input: DiffInput) => Effect.Effect<DiffResult, DiffUpdateFailure>;
  // 無い updater では、英字の語は読みを返さない語として扱う
  readonly katakana?: KatakanaAsk;
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
export const RemarkEvent = Schema.Struct({ type: Schema.Literal("remark"), remark: Remark, noContent: Schema.optionalKey(Schema.Literal(true)),
  // 直す前の本文と語（Issue #639）。words を受け取った発言の行にだけ付く。raw は関所を通った後の補正する前の本文で、
  // 補正した発言では remark.text（直した本文）と異なる。words は raw の位置のまま（直した本文には合わせない）
  raw: Schema.optionalKey(Schema.String), words: Schema.optionalKey(Schema.Array(Word)) });
// ログの中の共有画面の参照。image は screens/ のファイル名、null は何も映らない
const ScreenRef = Schema.Struct({ start: Schema.Finite, image: Schema.NullOr(Schema.String) });
// lines は受け取った OCR の行（Issue #643）。受け取らなかった画面と古いログには付かない
export const ScreenEvent = Schema.Struct({ type: Schema.Literal("screen"), start: Schema.Finite, image: Schema.NullOr(Schema.String), lines: Schema.optionalKey(Schema.Array(Schema.String)) });
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
  judge: Schema.optionalKey(JudgeRecord), // 振り分けの判定の記録。判定を使わない実装・判定を呼ばなかった回には付かない
  // update を呼ぶ直前と、応答（または失敗）を受けた直後の実時刻（at と同じ書き方）。update に入らなかった回（添える画像の読み戻しの失敗）には付かない
  call: Schema.optionalKey(Schema.Struct({ startedAt: Schema.String, endedAt: Schema.String })),
});

// log.jsonl の時刻の書き方。Clock ではなく実時刻（TestClock の下でも実際の時刻）。Effect を実行した時点で決める
export const logTimestamp = (): string => DateTime.formatIso(DateTime.nowUnsafe());
// 語彙に入った語（Issue #640）。romaji は読み（作れなかった語は null）、source は出どころ
export const VocabEvent = Schema.Struct({
  type: Schema.Literal("vocab"),
  words: Schema.Array(Schema.Struct({ surface: Schema.String, romaji: Schema.NullOr(Schema.String), source: Schema.Literals(["user", "screen", "carried"]) })),
});
// このセッションの番号（Issue #645）。溜まりが開始時に数えた値で、終了時と cli restore が溜まりを更新するときの語の「最後に話されたセッション」になる。
// 溜まりを使わなかったセッション（play・古いログ・溜まりが読めなかった回）には付かない
export const VocabPoolEvent = Schema.Struct({ type: Schema.Literal("vocab-pool"), session: Schema.Int });
export const LogEvent = Schema.Union([StartEvent, RemarkEvent, VocabEvent, VocabPoolEvent, ScreenEvent, ScreenOffEvent, ScreenInputSkippedEvent, DiffEvent, DiffUpdatePausedEvent, DiffUpdateRetryEvent, DiffUpdateResumedEvent, DiffUpdateStateEvent]);
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
  readonly previousResponse: PreviousResponse | undefined; // 最後に適用した応答の対応と捨てた操作。差分更新の失敗の後と、どちらも空の応答の後は undefined
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

// 適用した応答から、次の差分更新の入力に載せる値を作る。対応も捨てた操作も無ければ載せるものが無い
// ライブ（callUpdater）と復元（replayDiff）が同じ関数を通す
const previousResponseOf = (applied: { refs: Record<string, string>; dropped: Dropped[] }): PreviousResponse | undefined =>
  Object.keys(applied.refs).length || applied.dropped.length ? { refs: applied.refs, dropped: applied.dropped } : undefined;

const typeOf = (event: unknown): unknown => (Predicate.isObject(event) && "type" in event ? event.type : undefined);

const decodeStart = Schema.decodeUnknownEffect(StartEvent);
const decodeRemark = Schema.decodeUnknownEffect(RemarkEvent);
const decodeDiff = Schema.decodeUnknownEffect(DiffEvent);
const decodeScreen = Schema.decodeUnknownEffect(ScreenEvent);

type UnsentScreen = ScreenRefs & { readonly seq: number };
// 復元の途中の状態。remarks・processed・known・files・unsent（screen の行で追記）は復元が所有する蓄積用で、行ごとに全コピーしないよう追記する。
// それ以外（map・history・received・attached）は、diff の反映が新しい値で返す
type Replay = {
  readonly map: MeetingMap | undefined;
  readonly remarks: Remark[];
  readonly processed: Remark[];
  readonly known: Set<string>;
  readonly history: History;
  readonly unsent: UnsentScreen[];
  readonly received: number;
  readonly attached: readonly ScreenRefs[];
  readonly files: Set<string>;
  readonly previousResponse: PreviousResponse | undefined;
};

// diff の入力の新しい発言を、ログの発言から id で引く。ログに無い id があれば不整合
const freshRemarksOf = (remarks: readonly Remark[], ids: readonly string[], invalid: (reason: string) => InvalidLogEvent): Effect.Effect<Remark[], InvalidLogEvent> => {
  const fresh: Remark[] = [];
  for (const id of ids) {
    const r = remarks.find((x) => x.id === id);
    if (!r) return Effect.fail(invalid(`ログに発言がありません: ${id}`));
    fresh.push(r);
  }
  return Effect.succeed(fresh);
};

// diff の行を 1 回分、復元の状態へ反映する。判定の順は、start が無い → ログに無い発言 → 反映数の超過 → screenCount の超過
const replayDiff = Effect.fnUntraced(function* (replay: Replay, e: typeof DiffEvent["Type"], invalid: (reason: string) => InvalidLogEvent): Effect.fn.Return<Replay, InvalidLogEvent> {
  const { map } = replay;
  if (!map) return yield* invalid("ログの diff より前に start がありません");
  const fresh = yield* freshRemarksOf(replay.remarks, e.input.fresh, invalid);
  const count = e.error !== undefined ? fresh.length : e.processedRemarks ?? fresh.length;
  if (count > fresh.length) return yield* invalid("diff の反映数が入力の発言数を超えています");
  const consumed = fresh.slice(0, count);
  const { known, processed } = replay;
  for (const r of consumed) {
    known.add(r.id);
    if (hasContent(r.text)) processed.push(r);
  }
  const selectedBefore = e.input.screenCount ?? 0;
  if (selectedBefore > replay.received) return yield* invalid(`diff の screenCount ${selectedBefore} が、ここまでの screen の行の数 ${replay.received} より大きい`);
  const cutoff = Math.max(...fresh.map((r) => r.end));
  const unsent = fresh.length ? replay.unsent.filter((h) => h.seq >= selectedBefore || h.start > cutoff) : replay.unsent;
  const attached = [...replay.attached, ...(e.input.screens ?? [])].slice(-LAST_SCREENS);
  const stamp = stampOf(replay.history, consumed);
  const applied = applyOps(map, e.ops, known, stamp);
  const history = e.error === undefined ? recordRound(replay.history, map, applied, stamp) : replay.history;
  return { ...replay, map: applied.map, unsent, attached, history, previousResponse: e.error === undefined ? previousResponseOf(applied) : undefined };
});

// ログのイベントを順に適用関数へ流して、状態を元に戻す。差分更新は呼ばない。
// 行ごとに type を見分けてから、その type の Schema で decode する。start・remark・screen・diff 以外（screen-off・screen-input-skipped・intake-*・知らない type）は読み飛ばす。
// まだ添えていない変化は、screen の行を受け取り順に積み、後ろの diff で、その diff の screenCount より前に受け取った画面のうち、
// 区切り（渡した新しい発言の end の最大値）以下に映り始めたものを外して求める（選んだ後に受け取った画面は、時刻が区切り以下でも残す）。
export const restoreState = Effect.fnUntraced(function* (events: Iterable<unknown>): Effect.fn.Return<SessionState & { readonly screens: RestoredScreens }, InvalidLogEvent> {
  let replay: Replay = {
    map: undefined, remarks: [], processed: [], known: new Set(), history: { round: 0, changes: [], currentTopic: undefined, lastChanged: undefined },
    unsent: [], received: 0, attached: [], files: new Set(), previousResponse: undefined,
  };
  let index = -1;
  for (const event of events) {
    index++;
    const invalid = (reason: string) => new InvalidLogEvent({ index, reason });
    const failed = Effect.mapError((error: { readonly message: string }) => invalid(error.message));
    const type = typeOf(event);
    if (type === StartEvent.fields.type.literal) {
      const e = yield* decodeStart(event).pipe(failed);
      replay = { ...replay, map: emptyMap(e.title) };
    } else if (type === RemarkEvent.fields.type.literal) {
      const e = yield* decodeRemark(event).pipe(failed);
      replay.remarks.push(e.remark);
    } else if (type === ScreenEvent.fields.type.literal) {
      const e = yield* decodeScreen(event).pipe(failed);
      replay.unsent.push({ start: e.start, image: e.image, seq: replay.received });
      if (e.image !== null) replay.files.add(e.image);
      replay = { ...replay, received: replay.received + 1 };
    } else if (type === DiffEvent.fields.type.literal) {
      const e = yield* decodeDiff(event).pipe(failed);
      replay = yield* replayDiff(replay, e, invalid);
    } else if (type === DiffUpdatePausedEvent.fields.type.literal) {
      replay = { ...replay, previousResponse: undefined };
    }
  }
  const { map, remarks, processed, known, history, unsent, attached, files, received, previousResponse } = replay;
  if (!map) return yield* new InvalidLogEvent({ index: 0, reason: "ログに start がありません" });
  const pending = remarks.filter((r) => !r.duplicate && !known.has(r.id) && hasContent(r.text));
  return { map, pending, processed, remarks, known, ...history, previousResponse, screens: { unsent: unsent.map(({ start, image }) => ({ start, image })), last: attached, files, received } };
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
  // original は補正する前の本文と、その本文の位置に合わせた語。付けた発言の行に raw・words を残す
  readonly push: (remark: Remark, original?: { readonly raw: string; readonly words: readonly Word[] }) => Effect.Effect<void>;
  // 呼び出し中のものと、それに続けて起きた呼び出しがすべて終わるまで待つ
  readonly idle: Effect.Effect<void>;
  // 共有画面の変化を受ける。差分更新は呼ばない。画像は writeScreen に渡し、変化ごとに screen の行を書く。
  // 差分更新に添える画面は、次の呼び出しの中で選ぶ
  // lines は OCR の行で、screen の行にだけ残す（ScreenChange・差分更新の入力には載せない）
  readonly pushScreen: (change: ScreenChange, lines?: ReadonlyArray<string>) => Effect.Effect<void>;
  // 共有画面を見ていない印を受ける。受け取った start・reason のまま screen-off の行を 1 行書くだけで、
  // 差分更新・添える画面・受け取った画面の数は変えない（Claude へのメッセージに載らない）
  readonly pushScreenOff: (off: Pick<typeof ScreenOffEvent["Type"], "start" | "reason">) => Effect.Effect<void>;
  // 終わりに、たまっている発言も流す（最後の発言を取りこぼさない）
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
const classifyFailure = (cause: Cause.Cause<DiffUpdateFailure>) => {
  const failure = Cause.findError(cause);
  const judge = Result.isSuccess(failure) ? failure.success.judge : undefined;
  return {
    judge,
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
    const ref = yield* Ref.make<SessionState & Runtime>({ ...initial, retryEnabled: true, diffUpdate: { status: "running" }, inFlight: undefined, reflecting: [], unsentScreens: screens.unsent, screenFiles: screens.files, lastScreens: screens.last, receivedScreens: screens.received });

    const setLifecycleState = Effect.fnUntraced(function* (state: DiffUpdateState) {
      const changed = yield* Ref.modify(ref, (s): [boolean, SessionState & Runtime] =>
        s.diffUpdate.status === "stopped" || s.diffUpdate.status === state.status
          ? [false, s] : [true, { ...s, diffUpdate: state }]);
      if (changed) yield* log.write({ type: "diff-update-state", state });
    });
    if (updater.lifecycle) yield* Effect.forkIn(Stream.runForEach(updater.lifecycle, (notification) =>
      setLifecycleState("status" in notification ? notification : { status: "stopped" }).pipe(Effect.uninterruptible),
    ), scope, { startImmediately: true });

    // 呼び出し中でなく、発言が 1 つ以上たまっていれば、たまった分をまとめて差分更新に渡す。
    // 取り出しから fork までの間に中断されて発言を取りこぼさないよう、中断させない
    function startDiffIfReady(retry = false): Effect.Effect<void> {
      return Effect.uninterruptible(
        Effect.gen(function* () {
          const reservation: Reservation = { kind: "reserved" };
          const fresh = yield* Ref.modify(ref, (s): [readonly Remark[] | undefined, SessionState & Runtime] =>
            s.inFlight || s.pending.length === 0 || (retry ? !s.retryEnabled || s.diffUpdate.status !== "paused" : s.diffUpdate.status === "paused" || s.diffUpdate.status === "stopped") ? [undefined, s] : [s.pending, { ...s, pending: [], inFlight: reservation }],
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
            yield* Ref.update(ref, (s) => ({ ...s, inFlight: undefined }));
            if (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)) return;
            const state = yield* Ref.get(ref);
            if (state.diffUpdate.status === "paused") {
              if (state.retryEnabled) yield* Effect.forkIn(Effect.sleep(DIFF_UPDATE_RETRY_MS).pipe(Effect.andThen(startDiffIfReady(true))), scope);
              return;
            }
            yield* startDiffIfReady();
          }),
        ),
        Effect.asVoid,
      );
    }

    // update だけを中断可能にする。状態の反映から SessionLog.write までは中断させない
    function callUpdater(fresh: readonly Remark[]): Effect.Effect<void> {
      return Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const state = (yield* Ref.get(ref)).diffUpdate;
          if (state.status === "paused") yield* log.write({ type: "diff-update-retry", reason: state.reason });
          const { map, recent, input, attached, previous, previousResponse } = yield* Ref.modify(ref, (s) => {
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
              { map: s.map, recent, input, attached, previous: images ? s.lastScreens : [], previousResponse: s.previousResponse },
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
          type CallTimes = { startedAt: string; endedAt: string };
          const classifyUnlessInterrupt = (cause: Cause.Cause<DiffUpdateFailure>) => (Cause.hasInterruptsOnly(cause) ? Effect.interrupt : Effect.succeed(classifyFailure(cause)));
          const outcome = yield* Effect.all([Effect.forEach(attached, readBack), readPrevious]).pipe(
            Effect.flatMap(([screens, previousScreens]) =>
              Effect.suspend(() => {
                const startedAt = logTimestamp();
                return Effect.exit(restore(updater.update({ map, recent: [...recent], fresh: [...fresh], ...(screens.length ? { screens } : {}), ...(previousScreens.length ? { previousScreens } : {}), ...(previousResponse ? { previousResponse } : {}) }))).pipe(
                  Effect.map((exit) => ({ exit, call: { startedAt, endedAt: logTimestamp() } as CallTimes })),
                );
              }),
            ),
            Effect.flatMap(({ exit, call }) =>
              exit.pipe(
                Effect.flatMap(({ ops, usage, judge, processedRemarks }) => {
                  const count = processedRemarks ?? fresh.length;
                  return !Number.isInteger(count) || count <= 0 || count > fresh.length
                    ? Effect.fail({ _tag: "InvalidProcessedRemarks", message: "反映数が入力の発言数に対して不正です", judge })
                    : Effect.succeed({ ok: true as const, ops, usage, judge, processedRemarks, count, call: call as CallTimes | undefined });
                }),
                Effect.catchCause((cause) => Effect.map(classifyUnlessInterrupt(cause), (failure) => ({ ...failure, call: call as CallTimes | undefined }))),
              ),
            ),
            Effect.catchCause((cause) => Effect.map(classifyUnlessInterrupt(cause), (failure) => ({ ...failure, call: undefined as CallTimes | undefined }))),
          );
          if (!outcome.ok) {
            if (outcome.stopped) {
              yield* Ref.update(ref, (s) => ({ ...s, reflecting: [], pending: [...fresh, ...s.pending], previousResponse: undefined }));
              yield* setLifecycleState({ status: "stopped" });
              return;
            }
            if (outcome.paused) {
              yield* Ref.update(ref, (s) => ({ ...s, reflecting: [], pending: [...fresh, ...s.pending], diffUpdate: { status: "paused" as const, reason: "ChatGPT の利用上限" as const }, previousResponse: undefined }));
              yield* log.write({ type: "diff-update-paused", reason: "ChatGPT の利用上限" });
              return;
            }
            // 失敗した回の発言は処理済みとして扱い、マップは変えずに次へ進む
            yield* Ref.update(ref, (s) => ({ ...s, diffUpdate: s.diffUpdate.status === "paused" ? { status: "running" as const } : s.diffUpdate, reflecting: [], known: new Set([...s.known, ...fresh.map((r) => r.id)]), processed: [...s.processed, ...fresh], previousResponse: undefined }));
            yield* log.write({ type: "diff", input, ops: [], dropped: [], error: outcome.error, ...(outcome.judge ? { judge: outcome.judge } : {}), ...(outcome.call ? { call: outcome.call } : {}) });
            return;
          }
          // ログへ書く（SessionLog.write）より先に状態へ反映する。write の中で読むスナップショットに今回分が載る
          const dropped = yield* Ref.modify(ref, (s) => {
            const consumed = fresh.slice(0, outcome.count);
            const known = new Set([...s.known, ...consumed.map((r) => r.id)]);
            const stamp = stampOf(s, consumed);
            const applied = applyOps(s.map, outcome.ops, known, stamp);
            return [applied.dropped, {
              ...s, ...recordRound(s, s.map, applied, stamp), diffUpdate: s.diffUpdate.status === "paused" ? { status: "running" as const } : s.diffUpdate, map: applied.map, reflecting: [], previousResponse: previousResponseOf(applied),
              known, processed: [...s.processed, ...consumed], pending: [...fresh.slice(outcome.count), ...s.pending],
            }];
          });
          yield* log.write({ type: "diff", input, ops: [...outcome.ops], dropped,
            ...(outcome.processedRemarks !== undefined ? { processedRemarks: outcome.processedRemarks } : {}),
            ...(outcome.usage ? { usage: outcome.usage } : {}), ...(outcome.judge ? { judge: outcome.judge } : {}), ...(outcome.call ? { call: outcome.call } : {}) });
          if (state.status === "paused") yield* log.write({ type: "diff-update-resumed" });
        }),
      );
    }

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
      push: (r, original) =>
        Effect.gen(function* () {
          yield* Ref.update(ref, (s) => ({ ...s, remarks: [...s.remarks, r] }));
          const extra = original === undefined ? {} : { raw: original.raw, words: original.words };
          if (!r.duplicate && !hasContent(r.text)) {
            // 中身のない発言: ログには残すが、差分更新・未反映の発言には関わらせない
            yield* log.write({ type: "remark", remark: r, noContent: true, ...extra });
            return;
          }
          yield* log.write({ type: "remark", remark: r, ...extra });
          if (r.duplicate) return;
          yield* Ref.update(ref, (s) => ({ ...s, pending: [...s.pending, r] }));
          yield* startDiffIfReady();
        }),
      idle,
      pushScreen: (change, lines) =>
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
          yield* log.write({ type: "screen", start: change.start, image: file, ...(lines === undefined ? {} : { lines }) });
        }),
      pushScreenOff: ({ start, reason }) => log.write({ type: "screen-off", start, reason }),
      flush: Effect.gen(function* () {
        // Scopeは書き出し後に閉じる。再試行の予約を先に止め、予約済みの更新はidleで待ち切る。
        yield* Ref.update(ref, (s) => ({ ...s, retryEnabled: false }));
        for (;;) {
          yield* idle;
          const state = yield* Ref.get(ref);
          if (state.pending.length === 0 || state.diffUpdate.status === "paused" || state.diffUpdate.status === "stopped") return;
          yield* startDiffIfReady();
        }
      }),
      snapshot: Effect.map(Ref.get(ref), snapshotOf),
      diffUpdate: Effect.map(Ref.get(ref), (s) => s.diffUpdate),
      unreflectedRemarks: Effect.map(Ref.get(ref), (s) => [...s.reflecting, ...s.pending].map((r) => ({ ...r }))),
      exportJson: Effect.map(Ref.get(ref), (s) => toJsonExport(snapshotOf(s), [...s.remarks])),
    } satisfies Session;
  });
}

// 新しいセッションを開く。最初に start をログへ書く。差分更新の呼び出しはこの Scope の Fiber で、Scope を閉じると中断される
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
    previousResponse: undefined,
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
