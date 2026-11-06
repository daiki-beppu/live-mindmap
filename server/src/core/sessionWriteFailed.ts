import { Predicate, Schema } from "effect";

export class SessionWriteFailed extends Schema.TaggedError<SessionWriteFailed>()("SessionWriteFailed", {
  path: Schema.String,
  cause: Schema.Unknown,
}) {
  override get message(): string {
    const original = Predicate.isObject(this.cause) && Predicate.isError(this.cause.cause) ? this.cause.cause : this.cause;
    const reason = Predicate.isError(original) ? original.message : String(original);
    return `ログを書けない: ${this.path}: ${reason.replaceAll(/\r?\n/g, " ")}`;
  }
}
