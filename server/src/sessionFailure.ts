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

export class NotForRecordedSession extends Schema.TaggedError<NotForRecordedSession>()("NotForRecordedSession", {}) {
  override get message(): string {
    return "録画からのセッションでは使えません";
  }
}

export class SpeakerNameRejected extends Schema.TaggedError<SpeakerNameRejected>()("SpeakerNameRejected", {
  reason: Schema.Literals(["ラベルがない", "名前が空"]),
}) {
  override get message(): string {
    return this.reason === "名前が空" ? "名前が空です" : "名前を付けられる話者のラベルではありません";
  }
}

export class Aborted extends Schema.TaggedError<Aborted>()("Aborted", {}) {
  override get message(): string {
    return "中断されました";
  }
}

export class RestartGaveUp extends Schema.TaggedError<RestartGaveUp>()("RestartGaveUp", {
  stderrTail: Schema.Array(Schema.String),
}) {
  override get message(): string {
    return `起動し直しに失敗しました: ${this.stderrTail.join("\n")}`;
  }
}

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
