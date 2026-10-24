import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { Config, Effect, FileSystem, Schema } from "effect";
import { withFileLock } from "./fileLock.ts";

export class ChatgptUnavailable extends Schema.TaggedError<ChatgptUnavailable>()("ChatgptUnavailable", {
  message: Schema.String,
}) {}
export const chatgptRefusal = (reason: string) => new ChatgptUnavailable({
  message: `${reason}\nlive-mindmap login chatgpt でサインインしてください`,
});
export const Credentials = Schema.Struct({
  client_id: Schema.NonEmptyString, ext_agent_host_id: Schema.NonEmptyString, subject: Schema.NonEmptyString,
  email: Schema.optionalKey(Schema.String), id_token: Schema.NonEmptyString,
  access_token: Schema.NonEmptyString, refresh_token: Schema.NonEmptyString,
  scopes: Schema.Array(Schema.NonEmptyString), expires_at: Schema.Finite, saved_at: Schema.String,
});
export type Credentials = typeof Credentials.Type;
export const authPath = Effect.map(Config.String("HOME").pipe(Config.withDefault(homedir())), (home) => join(home, ".live-mindmap", "auth", "chatgpt.json"));

export const readCredentials = Effect.fnUntraced(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs.readFileString(path).pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.void));
  if (text === undefined) return undefined;
  return yield* Schema.decodeEffect(Schema.fromJsonString(Credentials), { onExcessProperty: "error" })(text);
});

export const writeAuthFile = Effect.fnUntraced(function* (path: string, text: string) {
  const fs = yield* FileSystem.FileSystem;
  const pending = `${path}.${randomUUID()}.tmp`;
  yield* Effect.addFinalizer(() => fs.remove(pending, { force: true }).pipe(Effect.orDie));
  yield* fs.writeFileString(pending, text, { mode: 0o600, flag: "wx" });
  yield* fs.rename(pending, path);
}, Effect.scoped);

export const logoutChatgpt = Effect.gen(function* () {
  const path = yield* authPath;
  const fs = yield* FileSystem.FileSystem;
  yield* withFileLock(path, fs.remove(path, { force: true }));
}).pipe(Effect.mapError(() => chatgptRefusal("ChatGPT の資格情報を削除できません")));
