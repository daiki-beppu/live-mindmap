import { Clock, Console, Deferred, Effect, Exit, Fiber, Ref, Result, Scope, Stream, SynchronizedRef } from "effect";
import { CONFIGURATION_CHANGE_WINDOW_MS, MAX_CONFIGURATION_CHANGES, decideIntakeRestart, decodeHelperEvent, type HelperEvent, type IntakeLogEvent } from "./core/index.ts";
import { Helpers, type HelperAttempt, type HelperExitInfo, type HelperInstruction } from "./helpers.ts";
import { HelperExited } from "./sessionFailure.ts";
import { withoutFinalNewline } from "./consoleText.ts";

type AttemptEnd = { exit: HelperExitInfo; stderrTail: ReadonlyArray<string> };
type IntakeEnd = { kind: "stopped"; exit: HelperExitInfo | undefined } | { kind: "finished" } | { kind: "gaveUp"; last: AttemptEnd };
type Reached = { kind: "running" } | { kind: "gaveUp"; stderrTail: ReadonlyArray<string> } | { kind: "aborted" };
type Transition = { kind: "connected"; restarted: boolean } | { kind: "crashed" | "running" | "interrupted" | "stopped" };
type RunOptions = {
  trigger: "auto" | "resume";
  exitZero: "restart" | "finish";
  log: (line: Extract<IntakeLogEvent, { type: "intake-stopped" | "intake-restarted" | "intake-gave-up" }>) => Effect.Effect<void>;
  apply: (event: HelperEvent) => Effect.Effect<void>;
  observe: (transition: Transition) => Effect.Effect<void>;
};
type Running = { reached: Effect.Effect<Reached>; end: Effect.Effect<IntakeEnd> };
type Intake = {
  run: (options: RunOptions) => Effect.Effect<Running>;
  send: (instruction: HelperInstruction) => Effect.Effect<void>;
  stop: Effect.Effect<void>;
  stats: Effect.Effect<{ attempt: number; restarts: number }>;
};
type Launched = { attempt: HelperAttempt; scope: Scope.Closeable; startedAt: number };
type Commands = Partial<Record<HelperInstruction["type"], "pending-once" | "sticky">>;
type Link = { target: HelperAttempt | undefined; pending: ReadonlyMap<HelperInstruction["type"], HelperInstruction> };

const note = (text: string) => Console.error(withoutFinalNewline(text));
const defectReason = (defect: unknown) => defect instanceof Error ? defect.message : String(defect);
const handleEvent = (apply: RunOptions["apply"], noticedTypes: Ref.Ref<ReadonlySet<string>>) => (data: string) => decodeHelperEvent(data).pipe(
  Effect.flatMap((decoded) => Effect.gen(function* () {
    if (decoded.kind === "known") return decoded.event;
    const first = yield* Ref.modify(noticedTypes, (types): [boolean, ReadonlySet<string>] =>
      types.has(decoded.type) ? [false, types] : [true, new Set([...types, decoded.type])]);
    if (first) yield* note(`ヘルパーの知らないイベント「${decoded.type}」を読み飛ばしました。ヘルパーを作り直してください（swift build -c release --package-path helper）`);
    return undefined;
  })),
  Effect.catchTag("SchemaError", (error) => Effect.as(note(`ヘルパーのイベントを読み飛ばしました: ${error.message}\n`), undefined)),
  Effect.catchDefect((defect) => Effect.as(note(`ヘルパーのイベントを読み飛ばしました: ${defectReason(defect)}\n`), undefined)),
  Effect.flatMap((event) => event === undefined ? Effect.void : apply(event).pipe(
    Effect.catchDefect((defect) => note(`ヘルパーのイベントの処理に失敗しました: ${defectReason(defect)}\n`)),
  )),
);

export const openIntake = Effect.fnUntraced(function* (options: {
  scope: Scope.Closeable;
  argv: (attemptNo: number) => Effect.Effect<ReadonlyArray<string>>;
  commands: Commands;
}): Effect.fn.Return<Intake, HelperExited, Helpers> {
  const helpers = yield* Helpers;
  const stopRequested = yield* Deferred.make<void>();
  const stats = yield* Ref.make({ attempt: 0, restarts: 0 });
  const link = yield* SynchronizedRef.make<Link>({ target: undefined, pending: new Map() });
  const launch = Effect.gen(function* () {
    const { attempt: attemptNo } = yield* Ref.updateAndGet(stats, (s) => ({ ...s, attempt: s.attempt + 1 }));
    const startedAt = yield* Clock.currentTimeMillis;
    const scope = yield* Scope.fork(options.scope, "sequential");
    const result = yield* helpers.launch(yield* options.argv(attemptNo), stopRequested).pipe(Scope.provide(scope), Effect.result);
    if (Result.isFailure(result)) yield* Scope.close(scope, Exit.void);
    return { result, scope, startedAt };
  });
  const first = yield* launch;
  if (Result.isFailure(first.result)) {
    const failure = first.result.failure;
    return yield* new HelperExited({ code: failure.exit?.code ?? null, signal: failure.exit?.signal ?? null, stderrTail: failure.stderrTail });
  }
  const firstAttempt = first.result.success;
  const initial = yield* Ref.make<Launched | undefined>({ attempt: firstAttempt, scope: first.scope, startedAt: first.startedAt });
  yield* SynchronizedRef.update(link, (value) => ({ ...value, target: firstAttempt }));

  const connect = (attempt: HelperAttempt) => SynchronizedRef.updateEffect(link, (current) => Effect.gen(function* () {
    if (current.target === attempt) return current;
    const pending = new Map(current.pending);
    for (const [type, instruction] of pending) {
      if (options.commands[type] === "pending-once" || instruction.paused) yield* attempt.send(instruction);
      if (options.commands[type] === "pending-once") pending.delete(type);
    }
    return { target: attempt, pending };
  }));
  const serve = Effect.fnUntraced(function* (current: Launched, apply: RunOptions["apply"]) {
    const noticedTypes = yield* Ref.make<ReadonlySet<string>>(new Set());
    yield* Effect.forkIn(Effect.andThen(Deferred.await(stopRequested), current.attempt.stop), current.scope);
    yield* Stream.runForEach(current.attempt.events, handleEvent(apply, noticedTypes)).pipe(
      Effect.ensuring(SynchronizedRef.update(link, (value) => ({ ...value, target: undefined }))),
    );
    const exit = yield* current.attempt.exit;
    const stderrTail = yield* current.attempt.stderrTail;
    yield* Scope.close(current.scope, Exit.void);
    return { exit, stderrTail };
  });
  const run = Effect.fnUntraced(function* (p: RunOptions): Effect.fn.Return<Running> {
    const reached = yield* Deferred.make<Reached>();
    const trigger = yield* Ref.make(p.trigger);
    const history = yield* Ref.make<{ failures: number; configurationChanges: ReadonlyArray<number> }>({ failures: 0, configurationChanges: [] });
    const finishAttempt = Effect.fnUntraced(function* (last: AttemptEnd, startedAt: number) {
      yield* p.log({ type: "intake-stopped", ...last.exit, stderrTail: [...last.stderrTail] });
      yield* note(`取り込みが止まった（${last.exit.code ?? last.exit.signal ?? "不明"}）\n`);
      const now = yield* Clock.currentTimeMillis;
      const decision = decideIntakeRestart({ ...(yield* Ref.get(history)), ranMs: now - startedAt, exit: last.exit, now });
      yield* Ref.set(history, { failures: decision.failures, configurationChanges: decision.configurationChanges });
      if (decision.action === "giveup") {
        yield* p.log({ type: "intake-gave-up", reason: decision.reason });
        yield* note(decision.reason === "configuration-changes"
          ? `マイクの入力の構成の変化が ${CONFIGURATION_CHANGE_WINDOW_MS / 1000} 秒に ${MAX_CONFIGURATION_CHANGES} 回を超えて続いたため、起動し直しを諦めました。取り込みは止まった状態です\n`
          : "起動し直しを諦めました。取り込みは止まった状態です\n");
        yield* p.observe({ kind: "stopped" });
        yield* Deferred.succeed(reached, { kind: "gaveUp", stderrTail: last.stderrTail });
      } else {
        yield* p.observe({ kind: "interrupted" });
      }
      return decision.action;
    });
    const readConnected = Effect.fnUntraced(function* (connected: Launched, reconnecting: boolean) {
      yield* connect(connected.attempt);
      const restarted = reconnecting && !(yield* Deferred.isDone(stopRequested));
      yield* p.observe({ kind: "connected", restarted });
      if (restarted) {
        yield* Ref.update(stats, (s) => ({ ...s, restarts: s.restarts + 1 }));
        yield* p.log({ type: "intake-restarted", trigger: yield* Ref.getAndSet(trigger, "auto") });
        yield* note("ヘルパーを起動し直しました\n");
        yield* p.observe({ kind: "running" });
      }
      if (!(yield* Deferred.isDone(stopRequested))) yield* Deferred.succeed(reached, { kind: "running" });
      return yield* serve(connected, p.apply);
    });
    const readNext = Effect.fnUntraced(function* (current: Launched | undefined) {
      if (current !== undefined) return { kind: "served" as const, last: yield* readConnected(current, false), startedAt: current.startedAt };
      if (yield* Deferred.isDone(stopRequested)) return { kind: "stopped" as const, exit: undefined };
      const next = yield* launch;
      if (Result.isFailure(next.result)) {
        if (yield* Deferred.isDone(stopRequested)) return { kind: "stopped" as const, exit: next.result.failure.exit };
        return { kind: "connectionFailed" as const, last: { exit: next.result.failure.exit ?? { code: null, signal: null }, stderrTail: next.result.failure.stderrTail }, startedAt: next.startedAt };
      }
      return { kind: "served" as const, last: yield* readConnected({ attempt: next.result.success, scope: next.scope, startedAt: next.startedAt }, true), startedAt: next.startedAt };
    });
    const body = Effect.gen(function* (): Effect.fn.Return<IntakeEnd> {
      let current = yield* Ref.getAndSet(initial, undefined);
      for (;;) {
        const next = yield* readNext(current);
        if (next.kind === "stopped") return next;
        const { last, startedAt } = next;
        current = undefined;
        if (yield* Deferred.isDone(stopRequested)) return { kind: "stopped", exit: last.exit };
        if (next.kind === "served") {
          if (p.exitZero === "finish" && last.exit.code === 0) return { kind: "finished" };
          yield* p.observe({ kind: "crashed" });
        }
        if ((yield* finishAttempt(last, startedAt)) === "giveup") return { kind: "gaveUp", last };
      }
    }).pipe(Effect.ensuring(Deferred.succeed(reached, { kind: "aborted" })));
    const fiber = yield* Effect.forkIn(body, options.scope);
    return { reached: Deferred.await(reached), end: Fiber.join(fiber) };
  });
  return {
    run,
    send: (instruction) => SynchronizedRef.updateEffect(link, (current) => Effect.gen(function* () {
      const pending = new Map(current.pending);
      const mode = options.commands[instruction.type];
      if (mode === "sticky" || (mode === "pending-once" && current.target === undefined)) pending.set(instruction.type, instruction);
      if (current.target !== undefined) yield* current.target.send(instruction);
      return { ...current, pending };
    })),
    stop: Effect.asVoid(Deferred.succeed(stopRequested, undefined)),
    stats: Ref.get(stats),
  };
});
