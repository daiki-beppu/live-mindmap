import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber, Queue, Scope } from "effect";
import { Socket } from "effect/socket";
import { TestClock } from "effect/testing";
import type { CaptionsFrame, IntakeFrame, Snapshot, SnapshotFrame } from "../src/core/index.ts";
import { Viewers, type ViewerFrame } from "../src/viewers.ts";

const snap = (...texts: string[]): Snapshot => ({
  nodes: [
    { id: "root", parent: null, kind: "会議", text: "定例", evidence: [] },
    ...texts.map((text, i) => ({ id: `n${i + 1}`, parent: "root", kind: "議題" as const, text, evidence: ["r1"] })),
  ],
  round: 0, changes: [], remarks: [],
});
const snapFrame = (...texts: string[]): SnapshotFrame => ({ type: "snapshot", snapshot: snap(...texts) });
// 吹き出し 1 つの字幕のフレーム。texts が空なら空の並び
const captions = (...texts: string[]): CaptionsFrame => ({
  type: "captions",
  bubbles: texts.map((text, i) => ({ id: `c${i}`, track: "相手", label: "なし", start: i, end: i + 1, text, settledLength: text.length })),
});
const intake = (status: IntakeFrame["status"]): IntakeFrame => ({ type: "intake", status });

// Socket の契約に合わせ、切断は reader の失敗、送信は writer の完了で表す。
const client = Effect.fnUntraced(function* (beforeWrite: Effect.Effect<void>) {
  const frames = yield* Queue.make<unknown>();
  const closed = yield* Deferred.make<never, Socket.SocketError>();
  const reading = yield* Deferred.make<void>();
  const writerReleased = yield* Deferred.make<void>();
  const write: Socket.Writer["write"] = (chunk) => Effect.gen(function* () {
    if (Socket.isCloseEvent(chunk)) return;
    yield* beforeWrite;
    const text = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    yield* Queue.offer(frames, JSON.parse(text));
  });
  const socket = Socket.Socket.of({
    [Socket.TypeId]: Socket.TypeId,
    reader: Effect.succeed({
      // ブラウザ向けの配信は送信だけなので、pull は切断まで値を出さない（Socket はクリーンな close も失敗で表す）
      pull: Deferred.succeed(reading, undefined).pipe(Effect.andThen(Deferred.await(closed))),
      upgrade: Socket.SocketUpgradeError.unsupported,
    }),
    writer: Effect.acquireRelease(
      Effect.succeed({ write, writeAll: (chunks) => Effect.forEach(chunks, write, { discard: true }) }),
      () => Deferred.succeed(writerReleased, undefined),
    ),
  });
  return {
    socket, frames, writerReleased, ready: Deferred.await(reading),
    disconnect: Deferred.fail(closed, new Socket.SocketError({ reason: new Socket.SocketCloseError({ code: 1000 }) })),
  };
});

const receivedFrames = Effect.fnUntraced(function* (frames: Queue.Queue<unknown>) {
  return yield* Queue.takeN(frames, yield* Queue.size(frames));
});

describe("Viewers の配信と保持（要件14〜18・25）", () => {
  const cases = [
    { name: "snapshot", first: snapFrame("採用"), latest: snapFrame("採用", "予算"), clear: "keep" },
    { name: "captions", first: captions("あ"), latest: captions("あ", "い"), clear: captions() },
    { name: "intake", first: intake("interrupted"), latest: intake("stopped"), clear: intake("none") },
    { name: "screen-notice", first: { type: "screen-notice", text: "最初の知らせ" }, latest: { type: "screen-notice", text: "次の知らせ" }, clear: { type: "screen-notice", text: null } },
    { name: "tap-notice", first: { type: "tap-notice", text: "最初の一文" }, latest: { type: "tap-notice", text: "次の一文" }, clear: { type: "tap-notice", text: null } },
    { name: "self-pause", first: { type: "self-pause", paused: true, reason: "自動" }, latest: { type: "self-pause", paused: true, reason: "手動" }, clear: { type: "self-pause", paused: false } },
    { name: "diff-update", first: { type: "diff-update", state: { status: "running" } }, latest: { type: "diff-update", state: { status: "paused", reason: "Claude の利用上限" } }, clear: { type: "diff-update", state: null } },
    { name: "session-mode", first: { type: "session-mode", local: false }, latest: { type: "session-mode", local: true }, clear: { type: "session-mode", local: false } },
    { name: "speaker-names", first: { type: "speaker-names", names: [{ label: "相手 A", name: "佐藤" }] }, latest: { type: "speaker-names", names: [{ label: "相手 A", name: "鈴木" }] }, clear: "keep" },
  ] satisfies ReadonlyArray<{ name: string; first: ViewerFrame; latest: ViewerFrame; clear: ViewerFrame | "keep" }>;

  it.effect.each(cases)("$name は接続中と途中接続へ最新値を送り、Scope 終了後も最後の値を保持する", ({ first, latest, clear }) =>
    Effect.gen(function* () {
      const viewers = yield* Viewers;
      const connected = yield* client(Effect.void);
      yield* Effect.forkChild(viewers.connect(connected.socket));
      yield* connected.ready;
      const scope = yield* Effect.acquireRelease(Scope.make(), (scope) => Scope.close(scope, Exit.void));
      const send = yield* Scope.provide(scope)(viewers.forSession);
      yield* send(first);
      expect(yield* Queue.take(connected.frames)).toEqual(first);
      yield* send(latest);
      expect(yield* Queue.take(connected.frames)).toEqual(latest);

      const late = yield* client(Effect.void);
      yield* Effect.forkChild(viewers.connect(late.socket));
      yield* late.ready;
      expect(yield* receivedFrames(late.frames)).toEqual([latest]);

      yield* Scope.close(scope, Exit.void);
      yield* TestClock.adjust(1);
      const ending = clear === "keep" ? [] : [clear];
      expect(yield* receivedFrames(connected.frames)).toEqual(ending);
      expect(yield* receivedFrames(late.frames)).toEqual(ending);

      const after = yield* client(Effect.void);
      yield* Effect.forkChild(viewers.connect(after.socket));
      yield* after.ready;
      expect(yield* receivedFrames(after.frames)).toEqual([clear === "keep" ? latest : clear]);
    }).pipe(Effect.provide(Viewers.layer)));

  it.effect("何も送らない口は取得時も Scope 終了時も何も送らない", () =>
    Effect.gen(function* () {
      const viewers = yield* Viewers;
      const connected = yield* client(Effect.void);
      yield* Effect.forkChild(viewers.connect(connected.socket));
      yield* connected.ready;
      yield* Effect.scoped(viewers.forSession);
      yield* TestClock.adjust(1);
      expect(yield* receivedFrames(connected.frames)).toEqual([]);
      const after = yield* client(Effect.void);
      yield* Effect.forkChild(viewers.connect(after.socket));
      yield* after.ready;
      expect(yield* receivedFrames(after.frames)).toEqual([]);
      yield* viewers.publish(snap("接続の確認"));
      expect(yield* Queue.take(connected.frames)).toEqual(snapFrame("接続の確認"));
      expect(yield* Queue.take(after.frames)).toEqual(snapFrame("接続の確認"));
    }).pipe(Effect.provide(Viewers.layer)));

  it.effect("前の口の送信履歴は次の空の口へ引き継がない", () =>
    Effect.gen(function* () {
      const viewers = yield* Viewers;
      const connected = yield* client(Effect.void);
      yield* Effect.forkChild(viewers.connect(connected.socket));
      yield* connected.ready;
      yield* Effect.scoped(Effect.gen(function* () {
        const send = yield* viewers.forSession;
        yield* send(intake("running"));
        expect(yield* Queue.take(connected.frames)).toEqual(intake("running"));
      }));
      expect(yield* Queue.take(connected.frames)).toEqual(intake("none"));
      yield* Effect.scoped(viewers.forSession);
      yield* TestClock.adjust(1);
      expect(yield* receivedFrames(connected.frames)).toEqual([]);
      yield* viewers.publish(snap("継続"));
      expect(yield* Queue.take(connected.frames)).toEqual(snapFrame("継続"));
    }).pipe(Effect.provide(Viewers.layer)));

  it.effect("保持値と解除は送信順によらず種類の表の順に届く", () =>
    Effect.gen(function* () {
      const viewers = yield* Viewers;
      const connected = yield* client(Effect.void);
      yield* Effect.forkChild(viewers.connect(connected.socket));
      yield* connected.ready;
      const scope = yield* Effect.acquireRelease(Scope.make(), (scope) => Scope.close(scope, Exit.void));
      const send = yield* Scope.provide(scope)(viewers.forSession);
      for (const { latest } of cases.toReversed()) {
        yield* send(latest);
        expect(yield* Queue.take(connected.frames)).toEqual(latest);
      }
      const late = yield* client(Effect.void);
      yield* Effect.forkChild(viewers.connect(late.socket));
      yield* late.ready;
      expect(yield* receivedFrames(late.frames)).toEqual(cases.map(({ latest }) => latest));
      yield* Scope.close(scope, Exit.void);
      yield* TestClock.adjust(1);
      const cleared = cases.flatMap<ViewerFrame>(({ clear }) => clear === "keep" ? [] : [clear]);
      expect(yield* receivedFrames(connected.frames)).toEqual(cleared);
      expect(yield* receivedFrames(late.frames)).toEqual(cleared);
      const after = yield* client(Effect.void);
      yield* Effect.forkChild(viewers.connect(after.socket));
      yield* after.ready;
      expect(yield* receivedFrames(after.frames)).toEqual(cases.map(({ latest, clear }) => clear === "keep" ? latest : clear));
    }).pipe(Effect.provide(Viewers.layer)));

  it.effect("forSession の後に登録した finalizer の送信が終わってから解除する", () =>
    Effect.gen(function* () {
      const viewers = yield* Viewers;
      const connected = yield* client(Effect.void);
      yield* Effect.forkChild(viewers.connect(connected.socket));
      yield* connected.ready;
      yield* Effect.scoped(Effect.gen(function* () {
        const send = yield* viewers.forSession;
        yield* send(intake("running"));
        expect(yield* Queue.take(connected.frames)).toEqual(intake("running"));
        yield* Effect.addFinalizer(() => send(intake("stopped")));
      }));
      expect(yield* Queue.takeN(connected.frames, 2)).toEqual([intake("stopped"), intake("none")]);
      yield* TestClock.adjust(1);
      expect(yield* receivedFrames(connected.frames)).toEqual([]);
    }).pipe(Effect.provide(Viewers.layer)));

  it.effect("初回送信中の更新を、保持値送信後に取りこぼさず届ける（要件16）", () =>
    Effect.gen(function* () {
      const viewers = yield* Viewers;
      const sending = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const c = yield* client(Deferred.succeed(sending, undefined).pipe(Effect.andThen(Deferred.await(release))));
      yield* viewers.publish(snap("初回"));
      yield* Effect.forkChild(viewers.connect(c.socket));
      yield* Deferred.await(sending);
      yield* viewers.publish(snap("更新1"));
      yield* viewers.publish(snap("更新2"));
      yield* Deferred.succeed(release, undefined);
      expect(yield* Queue.take(c.frames)).toEqual(snapFrame("初回"));
      expect(yield* Queue.takeN(c.frames, 2)).toEqual([snapFrame("更新1"), snapFrame("更新2")]);
    }).pipe(Effect.provide(Viewers.layer)));

  it.effect("切断で配信Fiberとwriterを終了し、残った接続へは更新が届く（要件17）", () =>
    Effect.gen(function* () {
      const viewers = yield* Viewers;
      yield* viewers.publish(snap("前"));
      const a = yield* client(Effect.void);
      const b = yield* client(Effect.void);
      const fiber = yield* Effect.forkChild(viewers.connect(a.socket));
      yield* Effect.forkChild(viewers.connect(b.socket));
      expect(yield* Queue.take(a.frames)).toEqual(snapFrame("前"));
      expect(yield* Queue.take(b.frames)).toEqual(snapFrame("前"));
      yield* a.disconnect;
      yield* Effect.exit(Fiber.join(fiber));
      yield* Deferred.await(a.writerReleased);
      yield* viewers.publish(snap("後"));
      expect(yield* Queue.take(b.frames)).toEqual(snapFrame("後"));
      expect(yield* Queue.size(a.frames)).toBe(0);
    }).pipe(Effect.provide(Viewers.layer)));
});
