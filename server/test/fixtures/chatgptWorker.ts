import { NodeFileSystem, NodeHttpClient, NodeRuntime } from "@effect/platform-node";
import { Console, Effect, FileSystem } from "effect";
import { accessToken, ChatgptEndpoints } from "../../src/chatgptAuth.ts";
import { withAuthLock } from "../../src/chatgptAuthStore.ts";

const [path, tokenUrl, mode] = process.argv.slice(2);
if (!path || !tokenUrl) throw new Error("worker arguments are missing");
const endpoints = ChatgptEndpoints.defaultValue();
const action = Effect.gen(function* () {
  if (mode === "exit") return;
  if (mode === "idle") return yield* Effect.andThen(Effect.sync(() => process.stderr.write("ready\n")), Effect.never);
  const fs = yield* FileSystem.FileSystem;
  let notified = false;
  const observed = FileSystem.FileSystem.of({
    ...fs,
    makeDirectory: (directory, options) => fs.makeDirectory(directory, options).pipe(
      Effect.tapError((error) => Effect.sync(() => {
        if (directory === `${path}.lock` && error.reason._tag === "AlreadyExists" && !notified) {
          notified = true;
          process.stderr.write("contended\n");
        }
      })),
    ),
  });
  if (mode === "hold") return yield* withAuthLock(path, Effect.andThen(Console.log("locked"), Effect.never));
  yield* Console.log(yield* accessToken(path).pipe(Effect.provideService(FileSystem.FileSystem, observed)));
  if (mode === "refresh-stay") return yield* Effect.never;
});
action.pipe(
  Effect.provideService(ChatgptEndpoints, { ...endpoints, token: tokenUrl }),
  Effect.provide([NodeFileSystem.layer, NodeHttpClient.layerFetch]),
  NodeRuntime.runMain,
);
