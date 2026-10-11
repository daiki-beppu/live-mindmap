import { Console, Effect, Exit, Layer, Queue, Ref, Result, Schema, Scope, Stream, type Cause } from "effect";
import { AppleIntelligence } from "./appleIntelligence.ts";
import { DiffUpdater, DiffUpdateStopped, type DiffUpdateLifecycle } from "./core/index.ts";
import { localUpdaterLayer, type Classify } from "./localDiffUpdater.ts";
import type { ExecutableModel } from "./modelSelection.ts";
import { prepareCompatible } from "./openaiCompatible.ts";

const MAX_RESTARTS = 3;
class AppleRestarting extends Schema.TaggedError<AppleRestarting>()("AppleRestarting", { message: Schema.String }) {}
type Availability = { readonly status: "running"; readonly classify: Classify } |
  { readonly status: "restarting" } | DiffUpdateStopped;

export const prepareAppleUpdater = Effect.fnUntraced(function* (model: Extract<ExecutableModel, { route: "apple" }>) {
  const meetingScope = yield* Effect.scope;
  const apple = yield* AppleIntelligence;
  const notifications = yield* Queue.unbounded<DiffUpdateLifecycle, Cause.Done>();
  yield* Effect.addFinalizer(() => Queue.end(notifications));
  const launch = Effect.fnUntraced(function* () {
    const scope = yield* Scope.fork(meetingScope, "sequential");
    return yield* Effect.gen(function* () {
      const child = yield* apple.launch;
      const classify = yield* prepareCompatible({ name: model.name, route: "openai-compatible", model: "apple", local: false, url: child.url });
      return { child, classify, scope };
    }).pipe(Scope.provide(scope), Effect.onExit((exit) => Exit.isFailure(exit) ? Scope.close(scope, exit) : Effect.void));
  });
  const initial = yield* launch();
  yield* Console.error(`ローカルモード: Apple Intelligence（子プロセス PID ${initial.child.pid}、宛先 ${initial.child.url}）`);
  yield* Console.error("Apple Intelligence は試験的で、決定・TODO を拾いすぎ・取りこぼしがあります");
  const available = yield* Ref.make<Availability>({ status: "running", classify: initial.classify });
  const restarts = yield* Ref.make(0);
  const notify = Effect.fnUntraced(function* (state: Availability) {
    yield* Ref.set(available, state);
    yield* Queue.offer(notifications, state instanceof DiffUpdateStopped ? state : { status: state.status });
  });
  yield* Effect.forkIn(Effect.gen(function* () {
    let current = initial;
    for (;;) {
      yield* current.child.exited;
      yield* notify({ status: "restarting" });
      yield* Scope.close(current.scope, Exit.void);
      for (;;) {
        if ((yield* Ref.get(restarts)) === MAX_RESTARTS) {
          yield* notify(new DiffUpdateStopped({ message: "Apple Intelligence の再起動が上限に達しました" }));
          return;
        }
        yield* Ref.update(restarts, (count) => count + 1);
        const result = yield* Effect.result(launch());
        if (Result.isFailure(result)) continue;
        current = result.success;
        yield* notify({ status: "running", classify: current.classify });
        break;
      }
    }
  }), meetingScope, { startImmediately: true });
  const classify: Classify = Effect.fnUntraced(function* (request) {
    const state = yield* Ref.get(available);
    if (state instanceof DiffUpdateStopped) return yield* state;
    if (state.status === "restarting") return yield* new AppleRestarting({ message: "Apple Intelligence を再起動しています" });
    return yield* state.classify(request);
  });
  const updater = yield* DiffUpdater.pipe(Effect.provide(localUpdaterLayer(classify)));
  return Layer.succeed(DiffUpdater, DiffUpdater.of({ ...updater, lifecycle: Stream.fromQueue(notifications) }));
});
