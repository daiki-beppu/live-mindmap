// CLI と server の間の要求・応答の形（ADR 0023。ADR 0009 の本文の置き場所を置き換えた）。
// 経路ごとに { method, path, body?, response } を 1 つの値にして、この 1 か所に並べる。CLI は記述とその本文を渡して要求を組み、
// server は同じ記述で経路を張って応答を書き出す。本文の Schema もここに置く（web は型だけを import する）。
// 失敗（ステータスと { error } の本文）は経路に宣言しない。失敗からステータスへの対応は http.ts の表 1 つが持つ。
// effect の Schema だけを import する純粋なモジュール（web の型検査が Node の型や effect/http に依存しないように）。
// ドメインの値である応答（取り込みの状態・共有の状態・録画の経過）の Schema は core にあり、ここから参照する。
import { Effect, Option, Schema, SchemaGetter } from "effect";
import { IntakeStatusReport } from "./core/intake.ts";
import { RecordedEvent } from "./core/recordedProgress.ts";
import { OpenShareStatus, ShareMail, ShareStatus } from "./core/viewingShare.ts";
import { TransferredJudge } from "./judgeSelection.ts";
import { CheckReport, InstallBody, InstallEvent, Item, StartupWarnings, UpdateBody } from "./managedDepsProtocol.ts";
import { TransferredModel } from "./modelSelection.ts";

// 既定値の補完は、本文の decode のここだけで行う（null は今まで通り受ける。手で送った本文の互換）。
// 真偽値の省略と null は true（audio・screen）。
const TrueByDefault = Schema.NullOr(Schema.Boolean).pipe(
  Schema.decodeTo(Schema.Boolean, { decode: SchemaGetter.transform((value) => value ?? true), encode: SchemaGetter.passthrough() }),
  Schema.withDecodingDefaultKey(Effect.succeed(true)),
);

// title は文字列か null か無し。null は無しにする
const OptionalTitle = Schema.optionalKey(Schema.NullOr(Schema.String)).pipe(
  Schema.decodeTo(Schema.optionalKey(Schema.String), {
    decode: SchemaGetter.transformOptional((title) => Option.filter(title, (value) => value !== null)),
    encode: SchemaGetter.passthrough(),
  }),
);

// 利用者が足した語（cli start --vocab）。1 語ずつ。省略は空
const Vocabulary = Schema.Array(Schema.String).pipe(Schema.withDecodingDefaultKey(Effect.succeed<ReadonlyArray<string>>([])));

// /session/start の本文。app は空でない文字列。trim・形式・長さの制限は足さない（空白だけの app も、今まで通り受理する）
export const SessionStartBody = Schema.Struct({
  app: Schema.NonEmptyString,
  title: OptionalTitle,
  audio: TrueByDefault,
  screen: TrueByDefault,
  vocab: Vocabulary,
  model: Schema.optionalKey(TransferredModel),
  judge: Schema.optionalKey(TransferredJudge), // 開始時に決めた判定のモデル（cli start）。鍵は送らず、環境変数の名前だけを送る
});

// /session/recorded の本文。file は録画の音声の絶対パス（CLI が解決して渡す）。title・vocab・model は /session/start と同じ意味。
// realtime は音声の時刻どおりに等速で入れる（省略は待ち時間なしの false）
export const SessionRecordedBody = Schema.Struct({
  file: Schema.NonEmptyString,
  selfFile: Schema.optionalKey(Schema.NonEmptyString), // 自分用の録音の絶対パス（cli recorded --self）。省略は 1 本だけ
  title: OptionalTitle,
  vocab: Vocabulary,
  realtime: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
  model: Schema.optionalKey(TransferredModel),
});

// /share/open の本文。範囲は { anyone: true } か { mails: [1 件以上] }、範囲なしの {}（範囲が空の拒否はサーバーが判定順の最後で決める）。
// 両方を持つ本文は、どの形にも当たらず 400
export const ShareOpenBody = Schema.Union([
  Schema.Struct({ anyone: Schema.optionalKey(Schema.Literal(true)) }),
  Schema.Struct({ mails: Schema.Array(ShareMail).check(Schema.isMinLength(1)) }),
]);

// /session/self-pause の本文。状態を指定する形（トグルではない）なので、同じ指示を重ねても結果が変わらない
export const SelfPauseBody = Schema.Struct({ paused: Schema.Boolean });

// /session/speaker-name の本文。ラベルに付ける名前（付けられるラベルかどうか・名前が空かどうかはサーバーが決める）
export const SpeakerNameBody = Schema.Struct({ label: Schema.String, name: Schema.String });

const StartedSession = Schema.Struct({ dir: Schema.String, ...StartupWarnings.fields });
const StoppedSession = Schema.Struct({ paths: Schema.Array(Schema.String) });
// 待ち受けているサーバー自身の PID。cli server stop は、記録の PID ではなくこれにだけシグナルを送る（serverProcess.ts）
const ServerIdentity = Schema.Struct({ pid: Schema.Int.check(Schema.isGreaterThan(0)) });

export type ServerRoute = {
  readonly method: "GET" | "POST";
  readonly path: `/${string}`;
  readonly body?: Schema.Top;
  // 本文なしの応答（204 と /ws の upgrade）は Void。NDJSON の stream は 1 行ぶんの形
  readonly response: Schema.Top;
};

export const ServerRoutes = {
  apps: { method: "GET", path: "/apps", response: Schema.Unknown }, // ヘルパーの `list` の結果。形は決めていない
  sessionStart: { method: "POST", path: "/session/start", body: SessionStartBody, response: StartedSession },
  sessionRecorded: { method: "POST", path: "/session/recorded", body: SessionRecordedBody, response: RecordedEvent }, // NDJSON の stream
  sessionStop: { method: "POST", path: "/session/stop", response: StoppedSession },
  sessionStatus: { method: "GET", path: "/session/status", response: IntakeStatusReport },
  sessionResume: { method: "POST", path: "/session/resume", response: StartupWarnings },
  sessionSelfPause: { method: "POST", path: "/session/self-pause", body: SelfPauseBody, response: Schema.Void }, // 204
  sessionSpeakerName: { method: "POST", path: "/session/speaker-name", body: SpeakerNameBody, response: Schema.Void }, // 204
  shareOpen: { method: "POST", path: "/share/open", body: ShareOpenBody, response: OpenShareStatus }, // 応答ヘッダー SHARE_OPEN_OUTCOME_HEADER 付き
  shareClose: { method: "POST", path: "/share/close", response: ShareStatus },
  shareStatus: { method: "GET", path: "/share/status", response: ShareStatus },
  server: { method: "GET", path: "/server", response: ServerIdentity },
  check: { method: "GET", path: "/check", response: CheckReport }, // query: for・route・screen
  depsCheck: { method: "GET", path: "/deps/check", response: Schema.Array(Item) }, // query: names
  depsInstall: { method: "POST", path: "/deps/install", body: InstallBody, response: InstallEvent }, // NDJSON の stream
  update: { method: "POST", path: "/update", body: UpdateBody, response: InstallEvent }, // NDJSON の stream
  feed: { method: "GET", path: "/ws", response: Schema.Void }, // ブラウザへの配信（WebSocket の upgrade）
} as const satisfies Record<string, ServerRoute>;
