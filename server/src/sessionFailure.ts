// 状態に合わない依頼や、起動し直しに失敗した結果の失敗。HTTP のステータスは持たない
// （タグからステータスへの対応は http.ts の表 1 つが決める）。文面はこのモジュールが持つ。
import { Schema } from "effect";

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

const FAILURES = [SessionBusy, SessionTransition, NoSession, IntakeNotStopped, Aborted, RestartGaveUp] as const;

export type SessionFailure = InstanceType<(typeof FAILURES)[number]>;

// セッションの側（まだ古いコード）が投げたものが、タグ付きの失敗かどうか。
// そうでないものは予期しない失敗なので、呼び出し側が defect にする
export const isSessionFailure = (u: unknown): u is SessionFailure => FAILURES.some((failure) => u instanceof failure);
