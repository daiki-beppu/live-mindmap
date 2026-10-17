// 状態に合わない依頼や、起動し直しに失敗した結果の失敗。HTTP のステータスは持たない
// （タグからステータスへの対応は http.ts の表 1 つが決める）。文面はこのモジュールが持つ。
import { Schema } from "effect";
import type { UpdaterUnavailable } from "./updaterUnavailable.ts";
import type { StartupDepsMissing } from "./startupDepsMissing.ts";
import type { ManagedDepsFailed } from "./managedDeps.ts";

export class SessionBusy extends Schema.TaggedError<SessionBusy>()("SessionBusy", {}) {
  override get message(): string {
    return "セッションが進行中です（先に stop）";
  }
}

export class SessionTransition extends Schema.TaggedError<SessionTransition>()("SessionTransition", {}) {
  override get message(): string {
    return "セッションの開始・終了の処理中です";
  }
}

export class NoSession extends Schema.TaggedError<NoSession>()("NoSession", {}) {
  override get message(): string {
    return "進行中のセッションがありません";
  }
}

export class IntakeNotStopped extends Schema.TaggedError<IntakeNotStopped>()("IntakeNotStopped", {}) {
  override get message(): string {
    return "取り込みは止まっていません（動いているか、起動し直しの最中です）";
  }
}

// 録画からのセッション（cli recorded）では使えない操作（resume・自分の休止）。ヘルパーは起動し直さない
export class NotForRecordedSession extends Schema.TaggedError<NotForRecordedSession>()("NotForRecordedSession", {}) {
  override get message(): string {
    return "録画からのセッションでは使えません";
  }
}

// 話者に名前を付けられない（Issue #1026）。付けられるのは、発言に振った「相手 X」のラベルだけ。
// 自分・まだ振っていないラベル・ラベルの無い「相手」・空の名前は付けない。セッションの状態に依らない依頼の誤りなので SessionFailure には含めない
export class SpeakerNameRejected extends Schema.TaggedError<SpeakerNameRejected>()("SpeakerNameRejected", {
  reason: Schema.Literals(["ラベルがない", "名前が空"]),
}) {
  override get message(): string {
    return this.reason === "名前が空" ? "名前が空です" : "名前を付けられる話者のラベルではありません";
  }
}

// stop・サーバーの終了に中断された（起動・起動し直し自体は成立していない）
export class Aborted extends Schema.TaggedError<Aborted>()("Aborted", {}) {
  override get message(): string {
    return "中断されました";
  }
}

// 続けて失敗して起動し直しを諦めた。stderrTail は最後の失敗の標準エラーの末尾
export class RestartGaveUp extends Schema.TaggedError<RestartGaveUp>()("RestartGaveUp", {
  stderrTail: Schema.Array(Schema.String),
}) {
  override get message(): string {
    return `起動し直しに失敗しました: ${this.stderrTail.join("\n")}`;
  }
}

// セッションの開始で、ヘルパーが接続する前に終わった。code・signal は終わり方（どちらも無ければ null）、
// stderrTail は標準エラーの末尾
export class HelperExited extends Schema.TaggedError<HelperExited>()("HelperExited", {
  code: Schema.NullOr(Schema.Finite),
  signal: Schema.NullOr(Schema.String),
  stderrTail: Schema.Array(Schema.String),
}) {
  override get message(): string {
    return `ヘルパーが終了しました（${this.code ?? this.signal}）: ${this.stderrTail.join("\n")}`;
  }
}

export type SessionFailure = SessionBusy | SessionTransition | NoSession | IntakeNotStopped | NotForRecordedSession | Aborted | RestartGaveUp | HelperExited | UpdaterUnavailable | StartupDepsMissing | ManagedDepsFailed;
