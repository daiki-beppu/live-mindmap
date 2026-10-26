import { Effect, Schema } from "effect";
import type { ServerRoutes } from "../../../server/src/serverProtocol.ts";

type PostPath = Extract<(typeof ServerRoutes)[keyof typeof ServerRoutes], { readonly method: "POST" }>["path"];

export class ServerUnreachable extends Schema.TaggedError<ServerUnreachable>()("ServerUnreachable", { cause: Schema.Defect() }) {}

export class ServerRejected extends Schema.TaggedError<ServerRejected>()("ServerRejected", { status: Schema.Number }) {}

export const postToServer = (path: PostPath, body: unknown): Effect.Effect<void, ServerUnreachable | ServerRejected> =>
  Effect.tryPromise({
    try: () => fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    catch: (cause) => new ServerUnreachable({ cause }),
  }).pipe(Effect.flatMap((response) => (response.ok ? Effect.void : Effect.fail(new ServerRejected({ status: response.status })))));
