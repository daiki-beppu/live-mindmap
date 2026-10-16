// セッション: 発言の流れを受け、差分更新を呼んでマップを組み立てる。
// WebSocket・CLI・Node の実行環境に依存しない（ADR 0003）。差分更新（DiffUpdater）とログの書き先（SessionLog）は Service で受ける。
import { Cause, Clock, Context, DateTime, Effect, Exit, Fiber, Predicate, Ref, Result, Schema, Stream, type Scope } from "effect";
import { diffMaps } from "./changes.ts";
import { DIFF_UPDATE_RETRY_MS, DiffUpdatePaused, DiffUpdatePausedEvent, DiffUpdateRetryEvent, DiffUpdateResumedEvent, DiffUpdateStateEvent, type DiffUpdateLifecycle, type DiffUpdateState } from "./diffUpdate.ts";
import type { KatakanaAnswer } from "./latinWords.ts";
import { toJsonExport, type JsonExport } from "./export.ts";
import { attributePeople } from "./people.ts";
import { applyOps, cloneNode, Dropped, emptyMap, Op, pointStatus, type DiffOutput, type MeetingMap } from "./map.ts";
import { lastChangedNode, nextCurrentTopic } from "./topic.ts";
import { anchorAfter, byStart, carriedOf, selectScreens } from "./screenSelection.ts";
import { Remark } from "./remark.ts";
import type { ChangeEntry, Snapshot, SnapshotNode } from "./snapshot.ts";
import { Word, WordTime } from "./words.ts";

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
  raw: Schema.optionalKey(Schema.String), words: Schema.optionalKey(Schema.Array(Word)),
  // STT の run ごとの区間（Issue #1019）。受け取った発言の行にだけ付く（古いログには無い）。位置は関所を通った後の本文（raw）のまま、秒は会議の原点から
  wordTimes: Schema.optionalKey(Schema.Array(WordTime)) });
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
// shiftMs は、録画からのセッションで、基準の時刻（ファイルの作成日時）へそろえるための足し幅。ライブと play は 0
export const logTimestamp = (shiftMs = 0): string => DateTime.formatIso(DateTime.addDuration(DateTime.nowUnsafe(), shiftMs));
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
  readonly diffUpdate: DiffUpdateState; // 差分更新の状態。paused の行で一時停止（reason つき）、resumed の行・paused の後の diff の行で running に戻る
};

// ログから戻す共有画面の状態。画像は参照（screens/ のファイル名）だけで、バイト列は restoreSession が読む手段で読む（core はファイルを読まない）
type ScreenRefs = { readonly start: number; readonly image: string | null };
export type RestoredScreens = {
  readonly unsent: readonly ScreenRefs[]; // まだ添えていない変化
  readonly last: readonly ScreenRefs[]; // 最後に添えた画面（新しい最大 2 件）
  readonly files: ReadonlySet<string>; // 使ったファイル名
  readonly received: number; // 受け取った共有画面の総数（screen の行の数）
  readonly carried: string | undefined; // 持ち越している変化の画像のファイル名（10 秒未満で添えなかった変化の最新の 1 件）
  readonly anchor: number | undefined; // 10 秒を測る起点。直前に添えた画像の start
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
const decodePaused = Schema.decodeUnknownEffect(DiffUpdatePausedEvent);
const decodeScreen = Schema.decodeUnknownEffect(ScreenEvent);

type UnsentScreen = ScreenRefs & { readonly seq: number };
// 復元の途中の状態。remarks・processed・known・files・unsent（screen の行で追記）は復元が所有する蓄積用で、行ごとに全コピーしないよう追記する。
// それ以外（map・history・received・attached）は、diff の反映が新しい値で返す
type Replay = {
  readonly map: MeetingMap | undefined;
  readonly remarks: Remark[];
  readonly byId: Map<string, Remark>; // remarks の id 引き。出した人の統合で根拠の開始を比べる
  readonly processed: Remark[];
  readonly known: Set<string>;
  readonly history: History;
  readonly unsent: UnsentScreen[];
  readonly received: number;
  readonly attached: readonly ScreenRefs[];
  readonly carried: string | undefined;
  readonly anchor: number | undefined;
  readonly imagesSkipped: boolean; // screen-input-skipped の行を読んだ（画像を添えない会議）。10 秒の規則による保留は無いので持ち越しを作らない
  readonly files: Set<string>;
  readonly previousResponse: PreviousResponse | undefined;
  readonly diffUpdate: DiffUpdateState;
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

// diff が反映した分の発言を、復元の状態の known・processed へ足す。失敗した回は渡した発言をすべて反映済みとして扱う
const consumeFresh = (replay: Replay, fresh: readonly Remark[], e: typeof DiffEvent["Type"], invalid: (reason: string) => InvalidLogEvent): Effect.Effect<readonly Remark[], InvalidLogEvent> => {
  const count = e.error !== undefined ? fresh.length : e.processedRemarks ?? fresh.length;
  if (count > fresh.length) return Effect.fail(invalid("diff の反映数が入力の発言数を超えています"));
  const consumed = fresh.slice(0, count);
  for (const r of consumed) {
    replay.known.add(r.id);
    if (hasContent(r.text)) replay.processed.push(r);
  }
  return Effect.succeed(consumed);
};

// diff の行を 1 回分、復元の状態へ反映する。判定の順は、start が無い → ログに無い発言 → 反映数の超過 → screenCount の超過
const replayDiff = Effect.fnUntraced(function* (replay: Replay, e: typeof DiffEvent["Type"], invalid: (reason: string) => InvalidLogEvent): Effect.fn.Return<Replay, InvalidLogEvent> {
  const { map } = replay;
  if (!map) return yield* invalid("ログの diff より前に start がありません");
  const fresh = yield* freshRemarksOf(replay.remarks, e.input.fresh, invalid);
  const consumed = yield* consumeFresh(replay, fresh, e, invalid);
  const selectedBefore = e.input.screenCount ?? 0;
  if (selectedBefore > replay.received) return yield* invalid(`diff の screenCount ${selectedBefore} が、ここまでの screen の行の数 ${replay.received} より大きい`);
  const cutoff = Math.max(...fresh.map((r) => r.end));
  const added = e.input.screens ?? [];
  // ライブ（callUpdater）と同じ候補と関数で、持ち越しを求める。ログの input.screens を「添えたもの」として使う（選び方を再計算しない）
  const candidates = fresh.length ? byStart(replay.unsent.filter((h) => h.seq < selectedBefore && (h.start <= cutoff || h.image === replay.carried))) : [];
  const carried = replay.imagesSkipped ? undefined : carriedOf(candidates, new Set(added.flatMap((h) => (h.image === null ? [] : [h.image]))));
  const anchor = anchorAfter(added, replay.anchor);
  const unsent = fresh.length ? replay.unsent.filter((h) => h.seq >= selectedBefore || h.start > cutoff || (h.image !== null && h.image === carried)) : replay.unsent;
  const attached = [...replay.attached, ...added].slice(-LAST_SCREENS);
  const stamp = stampOf(replay.history, consumed);
  const applied = applyOps(map, e.ops, replay.known, stamp, replay.byId);
  const history = e.error === undefined ? recordRound(replay.history, map, applied, stamp) : replay.history;
  // ライブ（callUpdater）と同じく、一時停止からの再試行で届いた diff の行（失敗も含む）で running に戻る
  const diffUpdate = replay.diffUpdate.status === "paused" ? { status: "running" as const } : replay.diffUpdate;
  return { ...replay, diffUpdate, map: applied.map, unsent, attached, carried: fresh.length ? carried : replay.carried, anchor, history, previousResponse: e.error === undefined ? previousResponseOf(applied) : undefined };
});

// ログのイベントを順に適用関数へ流して、状態を元に戻す。差分更新は呼ばない。
// 行ごとに type を見分けてから、その type の Schema で decode する。start・remark・screen・diff・screen-input-skipped（画像を添えない会議の印として、持ち越しの判定に使う）・diff-update-paused（前回の応答をなくす）を読む。screen-off・intake-*・知らない type は読み飛ばす。
// まだ添えていない変化は、screen の行を受け取り順に積み、後ろの diff で、その diff の screenCount より前に受け取った画面のうち、
// 区切り（渡した新しい発言の end の最大値）以下に映り始めたものを外して求める（選んだ後に受け取った画面は、時刻が区切り以下でも残す）。
// 10 秒未満で添えなかった変化の最新の 1 件（持ち越し）は外さず残し、起点（直前に添えた画像の start）とともに、ログの input.screens から求める。
export const restoreState = Effect.fnUntraced(function* (events: Iterable<unknown>): Effect.fn.Return<SessionState & { readonly screens: RestoredScreens }, InvalidLogEvent> {
  let replay: Replay = {
    map: undefined, remarks: [], byId: new Map(), processed: [], known: new Set(), history: { round: 0, changes: [], currentTopic: undefined, lastChanged: undefined },
    unsent: [], received: 0, attached: [], carried: undefined, anchor: undefined, imagesSkipped: false, files: new Set(), previousResponse: undefined, diffUpdate: { status: "running" },
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
      replay.byId.set(e.remark.id, e.remark);
    } else if (type === ScreenEvent.fields.type.literal) {
      const e = yield* decodeScreen(event).pipe(failed);
      replay.unsent.push({ start: e.start, image: e.image, seq: replay.received });
      if (e.image !== null) replay.files.add(e.image);
      replay = { ...replay, received: replay.received + 1 };
    } else if (type === DiffEvent.fields.type.literal) {
      const e = yield* decodeDiff(event).pipe(failed);
      replay = yield* replayDiff(replay, e, invalid);
    } else if (type === ScreenInputSkippedEvent.fields.type.literal) {
      replay = { ...replay, imagesSkipped: true };
    } else if (type === DiffUpdatePausedEvent.fields.type.literal) {
      const e = yield* decodePaused(event).pipe(failed);
      replay = { ...replay, previousResponse: undefined, diffUpdate: { status: "paused", reason: e.reason } };
    } else if (type === DiffUpdateResumedEvent.fields.type.literal) {
      replay = { ...replay, diffUpdate: { status: "running" } };
    }
  }
  const { map, remarks, processed, known, history, unsent, attached, files, received, previousResponse, carried, anchor, diffUpdate } = replay;
  if (!map) return yield* new InvalidLogEvent({ index: 0, reason: "ログに start がありません" });
  const pending = remarks.filter((r) => !r.duplicate && !known.has(r.id) && hasContent(r.text));
  return { map, pending, processed, remarks, known, ...history, previousResponse, diffUpdate, screens: { unsent: unsent.map(({ start, image }) => ({ start, image })), last: attached, files, received, carried, anchor } };
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
  readonly push: (remark: Remark, original?: { readonly raw: string; readonly words: readonly Word[] }, wordTimes?: readonly WordTime[]) => Effect.Effect<void>;
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
  // 一時停止の間、次に再試行する時刻（エポックからのミリ秒）。一時停止でなければ undefined。再試行でも戻らなければ、その時点から DIFF_UPDATE_RETRY_MS 後に更新される
  readonly nextRetryAt: Effect.Effect<number | undefined>;
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
  readonly nextRetryAt: number | undefined; // 一時停止から次に再試行する時刻（エポックからのミリ秒）。一時停止の間だけ持つ
  readonly inFlight: InFlight | undefined;
  readonly reflecting: readonly Remark[]; // 差分更新の結果待ちの発言。結果を log する直前に外す
  readonly catchUpUntil: string | undefined; // 一時停止の間にたまった発言の最後の ID。これが pending に残っている間は CATCH_UP_REMARKS 件ずつ渡す
  readonly unsentScreens: readonly HeldScreen[]; // まだ差分更新に添えていない共有画面の変化（受け取った順）
  readonly catchUpScreen: HeldScreen | undefined; // 一時停止の間にたまった共有画面のうち start が最も遅い 1 件（同じ start なら後に受け取った方。要素の同一性で照合する）。これが unsentScreens に残っている間は SCREENS_MAX で切らない
  readonly screenFiles: ReadonlySet<string>; // 画像に付けたファイル名
  readonly lastScreens: readonly HeldScreen[]; // 最後に添えた共有画面（古い順・最大 LAST_SCREENS 件）。失敗した回に選んだ画面も数える（一時停止の回は数えない）。画像はファイル名だけで、送るときに読み戻す
  readonly receivedScreens: number; // 受け取った共有画面の総数。diff の行の screenCount に使う
  readonly carriedScreen: string | undefined; // 持ち越している変化の画像のファイル名。10 秒未満で添えなかった変化の最新の 1 件
  readonly lastImageStart: number | undefined; // 10 秒を測る起点。直前に添えた画像の start（lastScreens から導かない: 画像が押し出されることがある）
};

// 差分更新に添えるまで持つのは、画像のバイト列ではなく、書いたファイル名（file）だけ
type HeldScreen = { readonly start: number; readonly image: { readonly id: string; readonly file: string } | null };

const LAST_SCREENS = 2; // query を開き直したときに送り直す、最後に添えた共有画面の件数
// Why: 一時停止から戻ったとき、たまった発言を 1 回に全部渡すと、共有画面の境目（渡した発言の end の最大値）が先へ進み、間に映った画面が捨てられる。
// 1 回の量は、待ち時間なしで流したときに 1 回で渡る発言の数（2 件）に合わせる。
// 録画のセッションが等速で入れるときの、処理を待つ発言（unreflectedRemarks）の上限にも同じ値を使う
export const CATCH_UP_REMARKS = 2;
// 1 回の呼び出しに添える共有画面の上限（新しいものから）。通常時の費用を抑えるための上限。
// Why: 一時停止の間にたまった画面（catchUpScreen まで）には適用しない。受け取った順と start の順は食い違うことがあり、境目（start <= cutoff）で未送信一覧から外れる順は start の順なので、start が最も遅いものを印にする。切り捨てた画面は未送信一覧からも外れるので、後の回で回復できず、映った時刻の発言に添えられなくなる
const SCREENS_MAX = 3;

// 映り始めた時刻から付ける画像のファイル名（整数部 4 桁・小数 1 桁。例 0754.2.jpg）。重なったら 2 件目から -n を足す
function screenFileName(start: number, used: ReadonlySet<string>): string {
  const base = start.toFixed(1).padStart(6, "0");
  let name = `${base}.jpg`;
  for (let n = 2; used.has(name); n++) name = `${base}-${n}.jpg`;
  return name;
}

// 失敗した差分更新の error 欄。タグ付きの失敗は "<_tag>: <message>"、defect は "defect: <内容>"
// diff の行に、値のある任意の欄（反映数・トークン・判定・呼び出しの時刻）だけを載せる
function presentFields<T extends object, K extends keyof T>(source: T, keys: readonly K[]): { [P in K]?: Exclude<T[P], undefined> } {
  return Object.fromEntries(keys.filter((k) => source[k] !== undefined).map((k) => [k, source[k]])) as { [P in K]?: Exclude<T[P], undefined> };
}

const classifyFailure = (cause: Cause.Cause<DiffUpdateFailure>) => {
  const failure = Cause.findError(cause);
  const judge = Result.isSuccess(failure) ? failure.success.judge : undefined;
  return {
    judge,
    ok: false as const,
    error: Result.isSuccess(failure) ? `${failure.success._tag}: ${failure.success.message}` : `defect: ${String(Cause.squash(cause))}`,
    pause: Result.isSuccess(failure) && failure.success instanceof DiffUpdatePaused ? failure.success : undefined,
    stopped: Result.isSuccess(failure) && failure.success._tag === "DiffUpdateStopped",
  };
};

// 次の呼び出しに渡す発言と、残す pending、新しい catchUpUntil を決める。たまりの最後の発言が pending に残っている間だけ小分けにする
function takeFresh(pending: readonly Remark[], catchUpUntil: string | undefined): { readonly fresh: readonly Remark[]; readonly rest: readonly Remark[]; readonly catchUpUntil: string | undefined } {
  const end = catchUpUntil === undefined ? -1 : pending.findIndex((r) => r.id === catchUpUntil);
  if (end < 0) return { fresh: pending, rest: [], catchUpUntil: undefined };
  // 末尾を含む回が一部だけ反映されると、残りが pending へ戻る。印は、末尾が pending から無くなったと確かめるまで残す
  return { fresh: pending.slice(0, CATCH_UP_REMARKS), rest: pending.slice(CATCH_UP_REMARKS), catchUpUntil };
}

type InitialScreens = { readonly unsent: readonly HeldScreen[]; readonly last: readonly HeldScreen[]; readonly files: ReadonlySet<string>; readonly received: number; readonly carried: string | undefined; readonly anchor: number | undefined };
const noScreens: InitialScreens = { unsent: [], last: [], files: new Set(), received: 0, carried: undefined, anchor: undefined };

function openSession(initial: SessionState, screens: InitialScreens, images: boolean, logShiftMs = 0): Effect.Effect<Session, never, Scope.Scope | DiffUpdater | SessionLog> {
  return Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const updater = yield* DiffUpdater;
    const log = yield* SessionLog;
    const ref = yield* Ref.make<SessionState & Runtime>({ ...initial, retryEnabled: true, nextRetryAt: undefined, inFlight: undefined, reflecting: [], catchUpUntil: undefined, catchUpScreen: undefined, unsentScreens: screens.unsent, screenFiles: screens.files, lastScreens: screens.last, receivedScreens: screens.received, carriedScreen: screens.carried, lastImageStart: screens.anchor });

    const setLifecycleState = Effect.fnUntraced(function* (state: DiffUpdateState) {
      const changed = yield* Ref.modify(ref, (s): [boolean, SessionState & Runtime] =>
        s.diffUpdate.status === "stopped" || s.diffUpdate.status === state.status
          ? [false, s] : [true, { ...s, diffUpdate: state, nextRetryAt: undefined }]);
      if (changed) yield* log.write({ type: "diff-update-state", state });
    });
    if (updater.lifecycle) yield* Effect.forkIn(Stream.runForEach(updater.lifecycle, (notification) =>
      setLifecycleState("status" in notification ? notification : { status: "stopped" }).pipe(Effect.uninterruptible),
    ), scope, { startImmediately: true });

    // 呼び出し中でなく、発言が 1 つ以上たまっていれば、たまった分をまとめて差分更新に渡す。
    // 取り出しから fork までの間に中断されて発言を取りこぼさないよう、中断させない
    function takeStep(s: SessionState & Runtime, reservation: Reservation): [readonly Remark[], SessionState & Runtime] {
      const taken = takeFresh(s.pending, s.catchUpUntil);
      return [taken.fresh, { ...s, pending: taken.rest, catchUpUntil: taken.catchUpUntil, inFlight: reservation }];
    }

    function startDiffIfReady(retry = false): Effect.Effect<void> {
      return Effect.uninterruptible(
        Effect.gen(function* () {
          const reservation: Reservation = { kind: "reserved" };
          const fresh = yield* Ref.modify(ref, (s): [readonly Remark[] | undefined, SessionState & Runtime] =>
            s.inFlight || s.pending.length === 0 || (retry ? !s.retryEnabled || s.diffUpdate.status !== "paused" : s.diffUpdate.status === "paused" || s.diffUpdate.status === "stopped") ? [undefined, s] : takeStep(s, reservation),
          );
          if (!fresh) return;
          const fiber = yield* Effect.forkIn(Effect.interruptible(runCall(fresh)), scope, { startImmediately: true });
          // fork から戻る前に呼び出しが終わっていたら（印が自分のものでなければ）置き換えない
          yield* Ref.update(ref, (s) => (s.inFlight === reservation ? { ...s, inFlight: { kind: "running" as const, fiber } } : s));
        }),
      );
    }

    // 一時停止からの再試行を予約する。retryAt が先の時刻ならその時刻に、無い・過ぎているなら DIFF_UPDATE_RETRY_MS 後に試す
    // 呼び出しが一時停止で終わったとき（時刻は一時停止に入るときに決めてある）と、一時停止のログから復元した直後（時刻は無いので DIFF_UPDATE_RETRY_MS 後にして記録する）の両方から呼ぶ
    const scheduleRetry: Effect.Effect<void> = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const { retryEnabled, nextRetryAt } = yield* Ref.modify(ref, (s) => {
        const next = s.nextRetryAt ?? now + DIFF_UPDATE_RETRY_MS;
        return [{ retryEnabled: s.retryEnabled, nextRetryAt: next }, s.nextRetryAt === undefined ? { ...s, nextRetryAt: next } : s] as const;
      });
      const wait = Math.max(0, nextRetryAt - now);
      if (retryEnabled) yield* Effect.forkIn(Effect.sleep(wait).pipe(Effect.andThen(startDiffIfReady(true))), scope);
    });
    if (initial.diffUpdate.status === "paused") yield* scheduleRetry;

    // 呼び出しが終わったら印を外し、続きがあれば次を呼ぶ。中断で終わったときは続けない
    function runCall(fresh: readonly Remark[]): Effect.Effect<void> {
      return callUpdater(fresh).pipe(
        Effect.onExit((exit) =>
          Effect.gen(function* () {
            yield* Ref.update(ref, (s) => ({ ...s, inFlight: undefined }));
            if (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)) return;
            const state = yield* Ref.get(ref);
            if (state.diffUpdate.status === "paused") {
              yield* scheduleRetry;
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
          const { map, recent, input, attached, previous, previousResponse, before, keptUnsent } = yield* Ref.modify(ref, (s) => {
            const recent = s.processed.slice(-RECENT);
            // 添える共有画面: 新しい発言の end の最大値以下に映り始めた、まだ添えていない変化（と持ち越し）を時刻順に並べ、
            // 直前に添えた画像から 10 秒以上離れたものを選び、新しい SCREENS_MAX 件。選び方は screenSelection.ts（復元と共通）。
            // 添えなかった変化は、最新の 1 件だけ持ち越し、途中の変化は捨てる（添えなかった古い変化を後から送ると、映り続ける画面と食い違う）。後に映り始めた変化は次へ回す
            const cutoff = Math.max(...fresh.map((u) => u.end));
            const candidates = byStart(s.unsentScreens.filter((h) => h.start <= cutoff || (h.image !== null && h.image.file === s.carriedScreen)));
            const keyed = candidates.map((h) => ({ start: h.start, image: h.image?.file ?? null, held: h }));
            const selected = images ? selectScreens(keyed, s.carriedScreen, s.lastImageStart, cutoff) : [];
            const catchingUp = s.catchUpScreen !== undefined && s.unsentScreens.includes(s.catchUpScreen);
            const chosen = catchingUp ? selected : selected.slice(-SCREENS_MAX);
            const attached = chosen.map((c) => c.held);
            const carriedScreen = images ? carriedOf(keyed, new Set(chosen.flatMap((c) => (c.image === null ? [] : [c.image])))) : undefined;
            const input = {
              recent: recent.map((u) => u.id),
              fresh: fresh.map((u) => u.id),
              nodeCount: s.map.order.length - 1,
              ...(attached.length ? { screens: attached.map((h) => ({ start: h.start, image: h.image?.file ?? null })) } : {}),
              ...(s.receivedScreens > 0 ? { screenCount: s.receivedScreens } : {}),
            };
            const keptUnsent = s.unsentScreens.filter((h) => h.start > cutoff || (carriedScreen !== undefined && h.image?.file === carriedScreen));
            const before = { unsentScreens: s.unsentScreens, carriedScreen: s.carriedScreen, lastImageStart: s.lastImageStart, lastScreens: s.lastScreens };
            const catchUpScreen = s.catchUpScreen !== undefined && keptUnsent.includes(s.catchUpScreen) ? s.catchUpScreen : undefined;
            return [
              { map: s.map, recent, input, attached, previous: images ? s.lastScreens : [], previousResponse: s.previousResponse, before, keptUnsent: keptUnsent.length },
              {
                ...s,
                reflecting: fresh,
                unsentScreens: keptUnsent,
                catchUpScreen,
                carriedScreen,
                lastImageStart: anchorAfter(chosen, s.lastImageStart),
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
                const startedAt = logTimestamp(logShiftMs);
                return Effect.exit(restore(updater.update({ map, recent: [...recent], fresh: [...fresh], ...(screens.length ? { screens } : {}), ...(previousScreens.length ? { previousScreens } : {}), ...(previousResponse ? { previousResponse } : {}) }))).pipe(
                  Effect.map((exit) => ({ exit, call: { startedAt, endedAt: logTimestamp(logShiftMs) } as CallTimes })),
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
            if (outcome.pause) {
              // 再試行（呼び出し前から paused）でも戻らなかったときは、返ってきた時刻に関わらず DIFF_UPDATE_RETRY_MS ごとに試す
              const { reason } = outcome.pause;
              const requestedAt = state.status === "paused" ? undefined : outcome.pause.retryAt;
              const now = yield* Clock.currentTimeMillis;
              const nextRetryAt = requestedAt !== undefined && requestedAt > now ? requestedAt : now + DIFF_UPDATE_RETRY_MS;
              // Why: 一時停止の回は diff の行を書かず、復元は選ぶ前の画面の状態から続ける。ライブも選ぶ前に戻して揃える（応答待ちの間に受けた画面は末尾に残す）
              yield* Ref.update(ref, (s) => {
                const unsentScreens = [...before.unsentScreens, ...s.unsentScreens.slice(keptUnsent)];
                return { ...s, ...before, unsentScreens, catchUpScreen: byStart(unsentScreens).at(-1), reflecting: [], pending: [...fresh, ...s.pending], catchUpUntil: [...fresh, ...s.pending].at(-1)?.id, diffUpdate: { status: "paused" as const, reason }, nextRetryAt, previousResponse: undefined };
              });
              yield* log.write({ type: "diff-update-paused", reason });
              return;
            }
            // 失敗した回の発言は処理済みとして扱い、マップは変えずに次へ進む
            yield* Ref.update(ref, (s) => ({ ...s, diffUpdate: s.diffUpdate.status === "paused" ? { status: "running" as const } : s.diffUpdate, nextRetryAt: undefined, reflecting: [], known: new Set([...s.known, ...fresh.map((r) => r.id)]), processed: [...s.processed, ...fresh], previousResponse: undefined }));
            yield* log.write({ type: "diff", input, ops: [], dropped: [], error: outcome.error, ...presentFields(outcome, ["judge", "call"]) });
            return;
          }
          // ログへ書く（SessionLog.write）より先に状態へ反映する。write の中で読むスナップショットに今回分が載る
          const { dropped, ops } = yield* Ref.modify(ref, (s) => {
            const consumed = fresh.slice(0, outcome.count);
            const known = new Set([...s.known, ...consumed.map((r) => r.id)]);
            const stamp = stampOf(s, consumed);
            // 出した人と担当の話者はサーバーが決め、決めた後の操作をログに残す（復元は計算し直さず、ログの値を読む）
            const byId = new Map(s.remarks.map((r) => [r.id, r]));
            const ops = attributePeople(outcome.ops, byId);
            const applied = applyOps(s.map, ops, known, stamp, byId);
            return [{ dropped: applied.dropped, ops }, {
              ...s, ...recordRound(s, s.map, applied, stamp), diffUpdate: s.diffUpdate.status === "paused" ? { status: "running" as const } : s.diffUpdate, nextRetryAt: undefined, map: applied.map, reflecting: [], previousResponse: previousResponseOf(applied),
              known, processed: [...s.processed, ...consumed], pending: [...fresh.slice(outcome.count), ...s.pending],
            }];
          });
          yield* log.write({ type: "diff", input, ops, dropped, ...presentFields(outcome, ["processedRemarks", "usage", "judge", "call"]) });
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
      push: (r, original, wordTimes) =>
        Effect.gen(function* () {
          yield* Ref.update(ref, (s) => ({ ...s, remarks: [...s.remarks, r] }));
          const extra = { ...(original === undefined ? {} : { raw: original.raw, words: original.words }), ...(wordTimes === undefined ? {} : { wordTimes }) };
          if (!r.duplicate && !hasContent(r.text)) {
            // 中身のない発言: ログには残すが、差分更新・未反映の発言には関わらせない
            yield* log.write({ type: "remark", remark: r, noContent: true, ...extra });
            return;
          }
          yield* log.write({ type: "remark", remark: r, ...extra });
          if (r.duplicate) return;
          yield* Ref.update(ref, (s) => ({ ...s, pending: [...s.pending, r], catchUpUntil: s.diffUpdate.status === "paused" ? r.id : s.catchUpUntil }));
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
          yield* Ref.update(ref, (s) => ({ ...s, receivedScreens: s.receivedScreens + 1, unsentScreens: [...s.unsentScreens, held], catchUpScreen: s.diffUpdate.status === "paused" && (s.catchUpScreen === undefined || held.start >= s.catchUpScreen.start) ? held : s.catchUpScreen }));
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
      nextRetryAt: Effect.map(Ref.get(ref), (s) => s.nextRetryAt),
      unreflectedRemarks: Effect.map(Ref.get(ref), (s) => [...s.reflecting, ...s.pending].map((r) => ({ ...r }))),
      exportJson: Effect.map(Ref.get(ref), (s) => toJsonExport(snapshotOf(s), [...s.remarks])),
    } satisfies Session;
  });
}

// 新しいセッションを開く。最初に start をログへ書く。差分更新の呼び出しはこの Scope の Fiber で、Scope を閉じると中断される
export const makeSession = Effect.fnUntraced(function* ({ title, images = true, logShiftMs = 0 }: { readonly title: string; readonly images?: boolean; readonly logShiftMs?: number }): Effect.fn.Return<Session, never, Scope.Scope | DiffUpdater | SessionLog> {
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
    diffUpdate: { status: "running" },
  }, noScreens, images, logShiftMs);
});

// ログのイベントから、セッションを元の状態に戻す。差分更新は呼ばず、イベントも log し直さない。
// 共有画面は、まだ添えていない変化と最後に添えた 2 件・持ち越しと起点を、screens/ のファイル名だけで戻す（復元した画像の id はファイル名）。
// 画像のバイト列は、ライブと同じく、続きの呼び出しで添える・送り直すときに SessionLog.readScreen で読み戻す（core はファイルを読まない）
export const restoreSession = Effect.fnUntraced(function* (events: Iterable<unknown>): Effect.fn.Return<Session, InvalidLogEvent, Scope.Scope | DiffUpdater | SessionLog> {
  const { screens, ...state } = yield* restoreState(events);
  const hold = (ref: ScreenRefs): HeldScreen => ({ start: ref.start, image: ref.image === null ? null : { id: ref.image, file: ref.image } });
  return yield* openSession(state, { unsent: screens.unsent.map(hold), last: screens.last.map(hold), files: screens.files, received: screens.received, carried: screens.carried, anchor: screens.anchor }, true);
});
