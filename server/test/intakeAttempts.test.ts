import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Result, Scope } from "effect";
import { TestClock, TestConsole } from "effect/testing";
import { vi } from "vitest";
import { Helpers } from "../src/helpers.ts";
import { openIntake } from "../src/intakeAttempts.ts";
import { makeFakeHelpers, type AttemptScript } from "./fixtures/intakeHelpers.ts";

type Intake = Effect.Success<ReturnType<typeof openIntake>>;
type RunOptions = Parameters<Intake["run"]>[0];
type Transition = Parameters<RunOptions["observe"]>[0];
type Event = Parameters<RunOptions["apply"]>[0];
type Log = Parameters<RunOptions["log"]>[0];
type OpenOptions = Parameters<typeof openIntake>[0];

const crashed = (afterMs: number, code = 1): AttemptScript => ({ unexpectedExit: { afterMs, exit: { code, signal: null } } });
const remark = { type: "remark", track: "相手", start: 0, end: 1, text: "発言", duplicate: false };
const waitFor = (condition: () => boolean, label: string) => Effect.promise(() =>
  vi.waitFor(() => expect(condition(), label).toBe(true), { timeout: 3000, interval: 1 }));

const setup = Effect.fnUntraced(function* (
  scripts: AttemptScript[],
  options: Partial<Pick<OpenOptions, "argv" | "commands">> & Partial<Pick<RunOptions, "apply" | "observe" | "exitZero">> = {},
) {
  const fake = yield* makeFakeHelpers(scripts);
  const scope = yield* Scope.fork(yield* Effect.scope, "sequential");
  const transitions: Transition[] = [];
  const events: Event[] = [];
  const logs: Log[] = [];
  const intake = yield* openIntake({
    scope,
    argv: options.argv ?? ((attemptNo) => Effect.succeed(["run", "--audio-index", String(attemptNo)])),
    commands: options.commands ?? {},
  }).pipe(Effect.provideService(Helpers, fake.helpers));
  const run = (trigger: "auto" | "resume") => intake.run({
    trigger,
    exitZero: options.exitZero ?? "restart",
    log: (line) => Effect.sync(() => { logs.push(line); }),
    apply: (event) => Effect.gen(function* () {
      events.push(event);
      if (options.apply) yield* options.apply(event);
    }),
    observe: (transition) => Effect.gen(function* () {
      transitions.push(transition);
      if (options.observe) yield* options.observe(transition);
    }),
  });
  const running = yield* run("auto");
  return { fake, intake, running, run, transitions, events, logs };
});

describe("取り込みの試行", () => {
  it.effect.each([0, 2])("最初の接続失敗はコード%sでもHelperExitedで返し、起動し直さない", (code) => Effect.gen(function* () {
    const fake = yield* makeFakeHelpers([{ connect: false, launchExit: { code, signal: null }, stderrTail: ["初回の失敗"] }]);
    const result = yield* Effect.result(openIntake({
      scope: yield* Scope.fork(yield* Effect.scope, "sequential"), argv: () => Effect.succeed(["run"]), commands: {},
    }).pipe(Effect.provideService(Helpers, fake.helpers)));
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) expect(result.failure).toMatchObject({ _tag: "HelperExited", code, signal: null, stderrTail: ["初回の失敗"] });
    expect(fake.calls).toEqual([["run"]]);
    expect(fake.lifecycle).toContain("closed:0");
  }));

  it.effect.each([false, true])("録画の接続前コード0は失敗に数え、接続後コード0だけ正常完了する（接続成功=%s）", (connected) => Effect.gen(function* () {
    const r = yield* setup([
      crashed(1),
      connected ? crashed(1, 0) : { connect: false, launchExit: { code: 0, signal: null }, stderrTail: ["二回目"] },
      { connect: false, launchExit: { code: 0, signal: null }, stderrTail: ["最後の失敗"] },
    ], { exitZero: "finish" });
    yield* TestClock.adjust(10);
    expect(yield* r.running.end).toEqual(connected ? { kind: "finished" } : {
      kind: "gaveUp", last: { exit: { code: 0, signal: null }, stderrTail: ["最後の失敗"] },
    });
    expect(yield* r.intake.stats).toEqual({ attempt: connected ? 2 : 3, restarts: connected ? 1 : 0 });
    expect(r.transitions.filter((transition) => transition.kind === "crashed")).toEqual([{ kind: "crashed" }]);
    expect(r.logs.filter((line) => line.type === "intake-stopped")).toEqual([
      { type: "intake-stopped", code: 1, signal: null, stderrTail: [] },
      ...(connected ? [] : [
        { type: "intake-stopped", code: 0, signal: null, stderrTail: ["二回目"] },
        { type: "intake-stopped", code: 0, signal: null, stderrTail: ["最後の失敗"] },
      ]),
    ]);
  }));

  it.effect("接続できない回も失敗に数え、最後のstderrで諦め、再起動には数えない", () => Effect.gen(function* () {
    const r = yield* setup([
      crashed(1),
      { connect: false, stderrTail: ["二回目"] },
      { connect: false, launchExit: { code: 9, signal: null }, stderrTail: ["最後の失敗"] },
    ]);
    yield* TestClock.adjust(10);
    expect(yield* r.running.end).toMatchObject({ kind: "gaveUp", last: { exit: { code: 9, signal: null }, stderrTail: ["最後の失敗"] } });
    expect(r.fake.calls.map((args) => args.at(-1))).toEqual(["1", "2", "3"]);
    expect(yield* r.intake.stats).toEqual({ attempt: 3, restarts: 0 });
    expect(r.logs.filter((line) => line.type === "intake-stopped")).toEqual([
      { type: "intake-stopped", code: 1, signal: null, stderrTail: [] },
      { type: "intake-stopped", code: null, signal: null, stderrTail: ["二回目"] },
      { type: "intake-stopped", code: 9, signal: null, stderrTail: ["最後の失敗"] },
    ]);
    expect(r.logs.filter((line) => line.type === "intake-gave-up")).toEqual([{ type: "intake-gave-up", reason: "failures" }]);
    expect(r.fake.lifecycle.filter((entry) => entry.startsWith("closed:"))).toEqual(["closed:0", "closed:1", "closed:2"]);
    expect(r.transitions.map((transition) => transition.kind)).toEqual(expect.arrayContaining(["crashed", "stopped"]));
    expect((yield* TestConsole.errorLines).join("\n")).toContain("起動し直しを諦めました。取り込みは止まった状態です");
  }));

  it.effect("再起動ごとに番号を進め、接続失敗した番号も再使用しない", () => Effect.gen(function* () {
    const r = yield* setup([crashed(1), { connect: false }, {}]);
    yield* TestClock.adjust(10);
    expect(r.fake.calls).toEqual([
      ["run", "--audio-index", "1"], ["run", "--audio-index", "2"], ["run", "--audio-index", "3"],
    ]);
    expect(yield* r.intake.stats).toEqual({ attempt: 3, restarts: 1 });
    expect(r.transitions).toContainEqual({ kind: "connected", restarted: true });
    expect(r.transitions.map((transition) => transition.kind)).toEqual(expect.arrayContaining(["interrupted", "running"]));
    expect(yield* TestConsole.errorLines).toEqual([
      "取り込みが止まった（1）", "取り込みが止まった（不明）", "ヘルパーを起動し直しました",
    ]);
    yield* r.intake.stop;
    yield* r.running.end;
  }));

  it.effect.each([60_000, 60_001])("crashedの処理時間を含めた%sミリ秒で失敗を判断する", (elapsed) => Effect.gen(function* () {
    let crashes = 0;
    const r = yield* setup([crashed(1), crashed(1), crashed(1), {}], {
      observe: (transition) => transition.kind === "crashed" && ++crashes === 2 ? Effect.sleep(elapsed - 1) : Effect.void,
    });
    yield* TestClock.adjust(elapsed + 2);
    if (elapsed === 60_000) {
      expect(yield* r.running.end).toMatchObject({ kind: "gaveUp" });
      expect(r.fake.calls).toHaveLength(3);
    } else {
      expect(r.fake.calls).toHaveLength(4);
      yield* r.intake.stop;
      yield* r.running.end;
    }
  }));

  it.effect.each([60_000, 60_001])("%sミリ秒動いた回の後は連続失敗の規則に従う", (duration) => Effect.gen(function* () {
    const r = yield* setup([crashed(1), crashed(duration), crashed(1), {}]);
    yield* TestClock.adjust(1);
    yield* TestClock.adjust(duration);
    yield* TestClock.adjust(1);
    if (duration === 60_000) {
      expect(yield* r.running.end).toMatchObject({ kind: "gaveUp" });
      expect(r.fake.calls).toHaveLength(3);
    } else {
      expect(r.fake.calls).toHaveLength(4);
      yield* r.intake.stop;
      yield* r.running.end;
    }
  }));

  it.effect.each([59_999, 60_000])("接続待ち%sミリ秒も試行の経過時間に含める", (waited) => Effect.gen(function* () {
    const gate = yield* Deferred.make<void>();
    const r = yield* setup([crashed(1), { ...crashed(1), connectGate: gate }, crashed(1), {}]);
    yield* TestClock.adjust(1);
    expect(r.fake.calls).toHaveLength(2);
    yield* TestClock.adjust(waited);
    yield* Deferred.succeed(gate, undefined);
    yield* TestClock.adjust(2);
    if (waited === 59_999) {
      expect(yield* r.running.end).toMatchObject({ kind: "gaveUp" });
      expect(r.fake.calls).toHaveLength(3);
    } else {
      expect(r.fake.calls).toHaveLength(4);
      yield* r.intake.stop;
      yield* r.running.end;
    }
  }));

  it.effect.each([false, true])("75の終了は接続の前後とも十回まで再試行し、十一回で諦める（接続前=%s）", (beforeConnect) => Effect.gen(function* () {
    const change: AttemptScript = beforeConnect ? { connect: false, launchExit: { code: 75, signal: null } } : crashed(1, 75);
    const r = yield* setup([...(beforeConnect ? [crashed(1)] : []), ...Array.from({ length: 11 }, () => change), {}]);
    yield* TestClock.adjust(10 + (beforeConnect ? 1 : 0));
    expect(r.fake.calls).toHaveLength(11 + (beforeConnect ? 1 : 0));
    expect(r.logs.filter((line) => line.type === "intake-gave-up")).toEqual([]);
    yield* TestClock.adjust(1);
    expect(yield* r.running.end).toMatchObject({ kind: "gaveUp" });
    expect(r.logs.filter((line) => line.type === "intake-gave-up")).toEqual([{ type: "intake-gave-up", reason: "configuration-changes" }]);
    expect((yield* TestConsole.errorLines).join("\n")).toContain("マイクの入力の構成の変化が 60 秒に 10 回を超えて続いたため");
  }));

  it.effect.each([60_000, 60_001])("75の窓は%sミリ秒前の終了を規則どおりに扱う", (elapsed) => Effect.gen(function* () {
    const r = yield* setup([crashed(1, 75), crashed(elapsed - 9, 75), ...Array.from({ length: 9 }, () => crashed(1, 75)), {}]);
    yield* TestClock.adjust(1);
    yield* TestClock.adjust(elapsed);
    if (elapsed === 60_000) {
      expect(yield* r.running.end).toMatchObject({ kind: "gaveUp" });
      expect(r.fake.calls).toHaveLength(11);
    } else {
      expect(r.fake.calls).toHaveLength(12);
      yield* r.intake.stop;
      yield* r.running.end;
    }
  }));

  it.effect("75を挟んでも失敗の数を戻さず、シグナル付き75は失敗に数える", () => Effect.gen(function* () {
    const r = yield* setup([crashed(1), crashed(1, 75), { connect: false, launchExit: { code: 75, signal: "SIGKILL" } }, crashed(1), {}]);
    yield* TestClock.adjust(10);
    expect(yield* r.running.end).toMatchObject({ kind: "gaveUp" });
    expect(r.fake.calls).toHaveLength(4);
    expect(r.logs.at(-1)).toEqual({ type: "intake-gave-up", reason: "failures" });
  }));

  it.effect("接続待ちのstopは冪等ですぐ戻り、以降は起動せずstoppedになる", () => Effect.gen(function* () {
    const r = yield* setup([crashed(1), { hold: true, stopExit: { code: null, signal: "SIGKILL" } }]);
    yield* TestClock.adjust(1);
    expect(r.fake.calls).toHaveLength(2);
    yield* r.intake.stop;
    yield* r.intake.stop;
    expect(yield* r.running.end).toEqual({ kind: "stopped", exit: { code: null, signal: "SIGKILL" } });
    expect(r.fake.stops).toEqual([1]);
    expect(r.fake.calls).toHaveLength(2);
  }));

  it.effect("stopの後に接続した回もconnectedを通知し、届いたイベントを読み切る", () => Effect.gen(function* () {
    const gate = yield* Deferred.make<void>();
    const r = yield* setup([crashed(1), { connectGate: gate, events: [JSON.stringify(remark)] }]);
    yield* TestClock.adjust(1);
    expect(r.fake.calls).toHaveLength(2);
    yield* r.intake.stop;
    yield* Deferred.succeed(gate, undefined);
    expect(yield* r.running.end).toMatchObject({ kind: "stopped" });
    expect(r.events).toEqual([remark]);
    expect(r.transitions.filter((transition) => transition.kind === "connected")).toEqual([
      { kind: "connected", restarted: false }, { kind: "connected", restarted: false },
    ]);
    expect(yield* r.intake.stats).toEqual({ attempt: 2, restarts: 0 });
    expect(r.logs.filter((line) => line.type === "intake-restarted")).toEqual([]);
  }));

  it.effect("stopは終了を待たずに印を立て、endがヘルパーの終了と解放を待つ", () => Effect.gen(function* () {
    const r = yield* setup([{ stopDelayMs: 100 }]);
    yield* r.intake.stop;
    expect(r.fake.lifecycle).toEqual([]);
    yield* TestClock.adjust(100);
    expect(yield* r.running.end).toEqual({ kind: "stopped", exit: { code: null, signal: "SIGTERM" } });
    expect(r.fake.lifecycle).toEqual(["exit:0", "stderr:0", "closed:0"]);
  }));

  it.effect.each(["restart", "finish"] as const)("終了コード0を%sとして扱う", (exitZero) => Effect.gen(function* () {
    const r = yield* setup([crashed(1, 0), {}], { exitZero });
    yield* TestClock.adjust(1);
    if (exitZero === "finish") {
      expect(yield* r.running.end).toEqual({ kind: "finished" });
      expect(r.fake.calls).toHaveLength(1);
      expect(r.logs).toEqual([]);
      expect(r.fake.lifecycle).toEqual(["exit:0", "stderr:0", "closed:0"]);
    } else {
      expect(r.fake.calls).toHaveLength(2);
      yield* r.intake.stop;
      yield* r.running.end;
    }
  }));

  it.effect("読み取りとexitとstderrの後に試行Scopeを閉じ、crashedが終わるまでargvを評価しない", () => Effect.gen(function* () {
    const applyGate = yield* Deferred.make<void>();
    const crashGate = yield* Deferred.make<void>();
    let from = 0;
    const r = yield* setup([{ ...crashed(1), events: [JSON.stringify(remark)] }, {}], {
      argv: (attemptNo) => Effect.sync(() => ["transcribe-file", "--from", String(from), ...(attemptNo === 1 ? ["--audio-dir", "/session"] : [])]),
      apply: () => Deferred.await(applyGate),
      observe: (transition) => transition.kind === "crashed" ? Effect.andThen(Deferred.await(crashGate), Effect.sync(() => { from = 12; })) : Effect.void,
    });
    yield* TestClock.adjust(1);
    expect(r.events).toEqual([remark]);
    expect(r.fake.lifecycle).toEqual([]);
    yield* Deferred.succeed(applyGate, undefined);
    yield* waitFor(() => r.transitions.some((transition) => transition.kind === "crashed"), "crashedの開始");
    expect(r.fake.lifecycle).toEqual(["exit:0", "stderr:0", "closed:0"]);
    expect(r.fake.calls).toEqual([["transcribe-file", "--from", "0", "--audio-dir", "/session"]]);
    yield* Deferred.succeed(crashGate, undefined);
    yield* waitFor(() => r.fake.calls.length === 2, "最新の再開位置での起動");
    expect(r.fake.calls[1]).toEqual(["transcribe-file", "--from", "12"]);
    yield* r.intake.stop;
    yield* r.running.end;
  }));

  it.effect("reading-pauseは現在の回へ送り、接続待ちでは最新値を覚えて前の回へ送らない", () => Effect.gen(function* () {
    const gate = yield* Deferred.make<void>();
    const r = yield* setup([crashed(1), { connectGate: gate }, {}], { commands: { "reading-pause": "sticky" } });
    yield* r.intake.send({ type: "reading-pause", paused: true });
    expect(r.fake.sentInstructions).toEqual([{ attempt: 0, instruction: { type: "reading-pause", paused: true } }]);
    yield* TestClock.adjust(1);
    yield* r.intake.send({ type: "reading-pause", paused: false });
    yield* r.intake.send({ type: "reading-pause", paused: true });
    expect(r.fake.sentInstructions).toHaveLength(1);
    yield* Deferred.succeed(gate, undefined);
    yield* waitFor(() => r.fake.sentInstructions.length === 2, "再接続直後のstickyの再送");
    expect(r.fake.sentInstructions[1]).toEqual({ attempt: 1, instruction: { type: "reading-pause", paused: true } });
    yield* r.intake.send({ type: "reading-pause", paused: false });
    expect(r.fake.sentInstructions[2]).toEqual({ attempt: 1, instruction: { type: "reading-pause", paused: false } });
    yield* r.intake.stop;
    yield* r.running.end;
  }));

  it.effect("一時停止のまま再接続するとイベントを読む前にreading-pauseを送り直す", () => Effect.gen(function* () {
    const gate = yield* Deferred.make<void>();
    let sentBeforeApply = false;
    let isPaused = () => false;
    const r = yield* setup([crashed(1), { connectGate: gate, events: [JSON.stringify(remark)] }], {
      commands: { "reading-pause": "sticky" },
      apply: () => Effect.sync(() => { sentBeforeApply = isPaused(); }),
    });
    isPaused = () => r.fake.sentInstructions.some(({ attempt, instruction }) => attempt === 1 && instruction.paused);
    yield* r.intake.send({ type: "reading-pause", paused: true });
    yield* TestClock.adjust(1);
    yield* Deferred.succeed(gate, undefined);
    yield* waitFor(() => r.events.length === 1, "再接続した回のイベント");
    expect(sentBeforeApply).toBe(true);
    expect(r.fake.sentInstructions).toEqual([
      { attempt: 0, instruction: { type: "reading-pause", paused: true } },
      { attempt: 1, instruction: { type: "reading-pause", paused: true } },
    ]);
    yield* r.intake.stop;
    yield* r.running.end;
  }));

  it.effect("接続待ちにstickyを既定へ戻したら次の回へ停止を再送しない", () => Effect.gen(function* () {
    const gate = yield* Deferred.make<void>();
    const r = yield* setup([crashed(1), { connectGate: gate }], { commands: { "reading-pause": "sticky" } });
    yield* r.intake.send({ type: "reading-pause", paused: true });
    yield* TestClock.adjust(1);
    yield* r.intake.send({ type: "reading-pause", paused: false });
    yield* Deferred.succeed(gate, undefined);
    yield* waitFor(() => r.transitions.filter((transition) => transition.kind === "connected").length === 2, "再接続の通知");
    expect(r.fake.sentInstructions).toEqual([{ attempt: 0, instruction: { type: "reading-pause", paused: true } }]);
    yield* r.intake.stop;
    yield* r.running.end;
  }));

  it.effect("self-pauseは接続待ちの最新値だけを一回送り、次の回へ持ち越さない", () => Effect.gen(function* () {
    const gate = yield* Deferred.make<void>();
    const r = yield* setup([crashed(1), { ...crashed(1), connectGate: gate }, {}], { commands: { "self-pause": "pending-once" } });
    yield* r.intake.send({ type: "self-pause", paused: true });
    yield* TestClock.adjust(1);
    yield* r.intake.send({ type: "self-pause", paused: true });
    yield* r.intake.send({ type: "self-pause", paused: false });
    expect(r.fake.sentPauses).toEqual([{ attempt: 0, paused: true }]);
    yield* Deferred.succeed(gate, undefined);
    yield* waitFor(() => r.fake.sentPauses.length === 2, "接続待ちの最新の指令の送信");
    yield* TestClock.adjust(1);
    expect(r.fake.calls).toHaveLength(3);
    expect(r.fake.sentPauses).toEqual([{ attempt: 0, paused: true }, { attempt: 1, paused: false }]);
    yield* r.intake.stop;
    yield* r.running.end;
  }));

  it.effect.each(["running", "gaveUp", "aborted"] as const)("resumeのreachedは%sを返す", (expected) => Effect.gen(function* () {
    const r = yield* setup([crashed(1), { connect: false }, { connect: false },
      ...(expected === "running" ? [{}] : expected === "aborted" ? [{ hold: true }] : Array.from({ length: 3 }, () => ({ connect: false, stderrTail: ["再開の最後"] }))),
    ]);
    yield* TestClock.adjust(10);
    yield* r.running.end;
    const resumed = yield* r.run("resume");
    if (expected === "aborted") yield* r.intake.stop;
    yield* TestClock.adjust(10);
    expect(yield* resumed.reached).toEqual(expected === "gaveUp" ? { kind: "gaveUp", stderrTail: ["再開の最後"] } : { kind: expected });
    if (expected === "running") yield* r.intake.stop;
    yield* resumed.end;
  }));

  it.effect("resumeで構成変化を数え直し、ログのtriggerは最初の成功だけresumeになる", () => Effect.gen(function* () {
    const r = yield* setup([...Array.from({ length: 11 }, () => crashed(1, 75)), ...Array.from({ length: 10 }, () => crashed(1, 75)), {}]);
    yield* TestClock.adjust(11);
    yield* r.running.end;
    const resumed = yield* r.run("resume");
    expect(yield* resumed.reached).toEqual({ kind: "running" });
    yield* TestClock.adjust(10);
    expect(r.fake.calls).toHaveLength(22);
    expect(r.logs.filter((line) => line.type === "intake-restarted").slice(-11)).toEqual([
      { type: "intake-restarted", trigger: "resume" }, ...Array.from({ length: 10 }, () => ({ type: "intake-restarted", trigger: "auto" })),
    ]);
    yield* r.intake.stop;
    yield* resumed.end;
  }));

  it.effect("resumeで連続失敗を数え直し、再開した回の短い終了の後も起動できる", () => Effect.gen(function* () {
    const r = yield* setup([crashed(1), { connect: false }, { connect: false }, crashed(1), {}]);
    yield* TestClock.adjust(10);
    yield* r.running.end;
    const resumed = yield* r.run("resume");
    expect(yield* resumed.reached).toEqual({ kind: "running" });
    yield* TestClock.adjust(1);
    expect(r.fake.calls).toHaveLength(5);
    yield* r.intake.stop;
    yield* resumed.end;
  }));

  it.effect("未知typeは診断せず、項目の壊れた既知typeは読み飛ばしの文面で一行記録する", () => Effect.gen(function* () {
    const r = yield* setup([{ events: ['{"type":"heartbeat"}', JSON.stringify(remark)] }]);
    yield* waitFor(() => r.events.length === 1, "未知type後の発言");
    expect(yield* TestConsole.errorLines).toEqual([]);
    r.fake.send(0, { ...remark, track: "司会" });
    r.fake.send(0, { ...remark, start: 1, end: 2 });
    yield* waitFor(() => r.events.length === 2, "壊れた既知type後の発言");
    expect((yield* TestConsole.errorLines).map(String)).toEqual([expect.stringContaining("ヘルパーのイベントを読み飛ばしました:")]);
    yield* r.intake.stop;
    yield* r.running.end;
    expect(r.events).toEqual([remark, { ...remark, start: 1, end: 2 }]);
  }));

  it.effect("既知typeのルートオブジェクトを一回適用する", () => Effect.gen(function* () {
    const r = yield* setup([{ events: [JSON.stringify(remark)] }]);
    yield* waitFor(() => r.events.length === 1, "remarkの適用");
    yield* r.intake.stop;
    yield* r.running.end;
    expect(r.events).toEqual([remark]);
  }));

  it.effect("非対象の行や壊れたJSONは適用せず、フェンス間の有効なJSON行は処理する", () => Effect.gen(function* () {
    const r = yield* setup([{ events: [
      '{"type":"heartbeat","text":"remark"}', '{"payload":{"type":"remark"}}', '{"type":"remark"',
      '"remark"', '[]', '```json', JSON.stringify(remark), '```', '~~~json', '// comment', '~~~', JSON.stringify({ ...remark, start: 1, end: 2 }),
    ] }]);
    yield* waitFor(() => r.events.length === 2, "後続の有効なイベント");
    yield* r.intake.stop;
    yield* r.running.end;
    expect(r.events).toEqual([remark, { ...remark, start: 1, end: 2 }]);
  }));

  it.effect("applyのdefectを解読失敗と区別して記録し、後続のイベントを処理する", () => Effect.gen(function* () {
    const r = yield* setup([{ events: [JSON.stringify(remark), JSON.stringify({ ...remark, start: 1, end: 2 })] }], {
      apply: (event) => event.type === "remark" && event.start === 0 ? Effect.die(new Error("受け渡し失敗")) : Effect.void,
    });
    yield* waitFor(() => r.events.length === 2, "defect後のイベント");
    yield* r.intake.stop;
    yield* r.running.end;
    expect(yield* TestConsole.errorLines).toEqual(["ヘルパーのイベントの処理に失敗しました: 受け渡し失敗"]);
  }));
});
