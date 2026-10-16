import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Queue } from "effect";
import { Socket } from "effect/socket";
import { TestClock } from "effect/testing";
import type { CaptionsFrame, IntakeFrame, Snapshot } from "../src/core/index.ts";
import { Viewers } from "../src/viewers.ts";

const snap = (...texts: string[]): Snapshot => ({
  nodes: [
    { id: "root", parent: null, kind: "会議", text: "定例", evidence: [] },
    ...texts.map((text, i) => ({ id: `n${i + 1}`, parent: "root", kind: "議題" as const, text, evidence: ["r1"] })),
  ],
  round: 0, changes: [], remarks: [],
});
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
      pull: Deferred.await(closed),
      upgrade: Socket.SocketUpgradeError.unsupported,
    }),
    writer: Effect.acquireRelease(
      Effect.succeed({ write, writeAll: (chunks) => Effect.forEach(chunks, write, { discard: true }) }),
      () => Deferred.succeed(writerReleased, undefined),
    ),
  });
  return {
    socket, frames, writerReleased,
    disconnect: Deferred.fail(closed, new Socket.SocketError({ reason: new Socket.SocketCloseError({ code: 1000 }) })),
  };
});

describe("Viewers の配信と保持（要件14〜18・25）", () => {
  it.effect("local の通知は接続中と途中接続へ届き、終了後の再接続へは解除を送る", () =>
    Effect.gen(function* () {
      const viewers = yield* Viewers;
      const mode = { type: "session-mode" as const, local: true };
      yield* viewers.sessionMode(mode);
      const first = yield* client(Effect.void);
      yield* Effect.forkChild(viewers.connect(first.socket));
      expect(yield* Queue.take(first.frames)).toEqual(mode);
      const late = yield* client(Effect.void);
      yield* Effect.forkChild(viewers.connect(late.socket));
      expect(yield* Queue.take(late.frames)).toEqual(mode);
      const ended = { type: "session-mode" as const, local: false };
      yield* viewers.sessionMode(ended);
      expect(yield* Queue.take(first.frames)).toEqual(ended);
      expect(yield* Queue.take(late.frames)).toEqual(ended);
      const reconnected = yield* client(Effect.void);
      yield* Effect.forkChild(viewers.connect(reconnected.socket));
      expect(yield* Queue.take(reconnected.frames)).toEqual(ended);
    }).pipe(Effect.provide(Viewers.layer)));

  // Issue #1069: 自分の休止は、休止中だけ最後の値を保持して新しい接続へ送り、false で保持を消す
  it.effect("自分の休止は接続中へ届き、休止中の途中接続にも届く。false を送ると、その後の接続には届かない", () =>
    Effect.gen(function* () {
      const viewers = yield* Viewers;
      const first = yield* client(Effect.void);
      yield* Effect.forkChild(viewers.connect(first.socket));
      yield* viewers.selfPause({ type: "self-pause", paused: true, reason: "自動" });
      expect(yield* Queue.take(first.frames)).toEqual({ type: "self-pause", paused: true, reason: "自動" });

      const late = yield* client(Effect.void);
      yield* Effect.forkChild(viewers.connect(late.socket));
      expect(yield* Queue.take(late.frames)).toEqual({ type: "self-pause", paused: true, reason: "自動" });

      // 休止中に理由だけが変わったら、保持も置き換わる（後からつないだ画面には最新の理由が届く）
      yield* viewers.selfPause({ type: "self-pause", paused: true, reason: "手動" });
      expect(yield* Queue.take(first.frames)).toEqual({ type: "self-pause", paused: true, reason: "手動" });
      expect(yield* Queue.take(late.frames)).toEqual({ type: "self-pause", paused: true, reason: "手動" });
      const replaced = yield* client(Effect.void);
      yield* Effect.forkChild(viewers.connect(replaced.socket));
      expect(yield* Queue.take(replaced.frames)).toEqual({ type: "self-pause", paused: true, reason: "手動" });
      expect(yield* Queue.size(replaced.frames)).toBe(0);

      yield* viewers.selfPause({ type: "self-pause", paused: false });
      expect(yield* Queue.take(first.frames)).toEqual({ type: "self-pause", paused: false });
      expect(yield* Queue.take(late.frames)).toEqual({ type: "self-pause", paused: false });

      const after = yield* client(Effect.void);
      yield* Effect.forkChild(viewers.connect(after.socket));
      yield* Effect.yieldNow;
      expect(yield* Queue.size(after.frames)).toBe(0);
    }).pipe(Effect.provide(Viewers.layer)));

  it.effect("自分の休止の保持は取り込みの状態・一言の保持と独立している（休止を解いても他の保持は残る）", () =>
    Effect.gen(function* () {
      const viewers = yield* Viewers;
      yield* viewers.intake(intake("running"));
      yield* viewers.selfPause({ type: "self-pause", paused: true, reason: "手動" });
      yield* viewers.selfPause({ type: "self-pause", paused: false });
      const late = yield* client(Effect.void);
      yield* Effect.forkChild(viewers.connect(late.socket));
      expect(yield* Queue.take(late.frames)).toEqual(intake("running"));
      yield* Effect.yieldNow;
      expect(yield* Queue.size(late.frames)).toBe(0);
    }).pipe(Effect.provide(Viewers.layer)));

  it.effect("初回の最新全体、接続中の更新、再接続の最新全体が届く", () =>
    Effect.gen(function* () {
      const viewers = yield* Viewers;
      const first = yield* client(Effect.void);
      yield* viewers.publish(snap("採用"));
      const fiber = yield* Effect.forkChild(viewers.connect(first.socket));
      expect(yield* Queue.take(first.frames)).toEqual(snap("採用"));
      yield* viewers.publish(snap("採用", "予算"));
      expect(yield* Queue.take(first.frames)).toEqual(snap("採用", "予算"));
      yield* first.disconnect;
      yield* Effect.exit(Fiber.join(fiber));
      yield* viewers.publish(snap("採用", "予算", "日程"));
      const second = yield* client(Effect.void);
      yield* Effect.forkChild(viewers.connect(second.socket));
      expect(yield* Queue.take(second.frames)).toEqual(snap("採用", "予算", "日程"));
      yield* TestClock.adjust(1);
      expect(yield* Queue.size(second.frames)).toBe(0);
    }).pipe(Effect.provide(Viewers.layer)));

  it.effect("接続中のすべてのクライアントへ同じ更新が届く", () =>
    Effect.gen(function* () {
      const viewers = yield* Viewers;
      yield* viewers.publish(snap());
      const clients = [yield* client(Effect.void), yield* client(Effect.void)];
      for (const c of clients) {
        yield* Effect.forkChild(viewers.connect(c.socket));
        expect(yield* Queue.take(c.frames)).toEqual(snap());
      }
      yield* viewers.publish(snap("採用"));
      for (const c of clients) expect(yield* Queue.take(c.frames)).toEqual(snap("採用"));
    }).pipe(Effect.provide(Viewers.layer)));

  it.effect("未公開なら何も送らず、その後の最初の公開は届く", () =>
    Effect.gen(function* () {
      const viewers = yield* Viewers;
      const c = yield* client(Effect.void);
      yield* Effect.forkChild(viewers.connect(c.socket));
      yield* TestClock.adjust(1);
      expect(yield* Queue.size(c.frames)).toBe(0);
      yield* viewers.publish(snap("採用"));
      expect(yield* Queue.take(c.frames)).toEqual(snap("採用"));
    }).pipe(Effect.provide(Viewers.layer)));

  it.effect("snapshot、最後の非空captions、最後のintakeの順に送る", () =>
    Effect.gen(function* () {
      const viewers = yield* Viewers;
      yield* viewers.publish(snap("採用"));
      yield* viewers.speak(captions("あ"));
      yield* viewers.speak(captions("あ", "い"));
      yield* viewers.intake(intake("interrupted"));
      yield* viewers.intake(intake("stopped"));
      const c = yield* client(Effect.void);
      yield* Effect.forkChild(viewers.connect(c.socket));
      expect(yield* Queue.takeN(c.frames, 3)).toEqual([snap("採用"), captions("あ", "い"), intake("stopped")]);
      yield* TestClock.adjust(1);
      expect(yield* Queue.size(c.frames)).toBe(0);
    }).pipe(Effect.provide(Viewers.layer)));

  it.effect("空のcaptionsは接続中に送り、保持から除く。つなぎ直したクライアントには送らない", () =>
    Effect.gen(function* () {
      const viewers = yield* Viewers;
      yield* viewers.speak(captions("あ"));
      const first = yield* client(Effect.void);
      yield* Effect.forkChild(viewers.connect(first.socket));
      expect(yield* Queue.take(first.frames)).toEqual(captions("あ"));
      yield* viewers.speak(captions());
      expect(yield* Queue.take(first.frames)).toEqual(captions());
      const second = yield* client(Effect.void);
      yield* Effect.forkChild(viewers.connect(second.socket));
      yield* TestClock.adjust(1);
      expect(yield* Queue.size(second.frames)).toBe(0);
    }).pipe(Effect.provide(Viewers.layer)));

  for (const status of ["running", "interrupted", "stopped", "none"] as const) {
    it.effect(`intake ${status} は後から接続しても届く`, () =>
      Effect.gen(function* () {
        const viewers = yield* Viewers;
        yield* viewers.intake(intake(status));
        const c = yield* client(Effect.void);
        yield* Effect.forkChild(viewers.connect(c.socket));
        expect(yield* Queue.take(c.frames)).toEqual(intake(status));
        yield* TestClock.adjust(1);
        expect(yield* Queue.size(c.frames)).toBe(0);
      }).pipe(Effect.provide(Viewers.layer)));
  }

  it.effect("runningからnoneへの変更は同じ接続へ届き、後から接続するとnoneだけが届く", () =>
    Effect.gen(function* () {
      const viewers = yield* Viewers;
      yield* viewers.intake(intake("running"));
      const first = yield* client(Effect.void);
      yield* Effect.forkChild(viewers.connect(first.socket));
      expect(yield* Queue.take(first.frames)).toEqual(intake("running"));
      yield* viewers.intake(intake("none"));
      expect(yield* Queue.take(first.frames)).toEqual(intake("none"));
      const second = yield* client(Effect.void);
      yield* Effect.forkChild(viewers.connect(second.socket));
      expect(yield* Queue.take(second.frames)).toEqual(intake("none"));
      yield* TestClock.adjust(1);
      expect(yield* Queue.size(second.frames)).toBe(0);
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
      expect(yield* Queue.take(c.frames)).toEqual(snap("初回"));
      expect(yield* Queue.takeN(c.frames, 2)).toEqual([snap("更新1"), snap("更新2")]);
    }).pipe(Effect.provide(Viewers.layer)));

  it.effect("切断で配信Fiberとwriterを終了し、残った接続へは更新が届く（要件17）", () =>
    Effect.gen(function* () {
      const viewers = yield* Viewers;
      yield* viewers.publish(snap("前"));
      const a = yield* client(Effect.void);
      const b = yield* client(Effect.void);
      const fiber = yield* Effect.forkChild(viewers.connect(a.socket));
      yield* Effect.forkChild(viewers.connect(b.socket));
      expect(yield* Queue.take(a.frames)).toEqual(snap("前"));
      expect(yield* Queue.take(b.frames)).toEqual(snap("前"));
      yield* a.disconnect;
      yield* Effect.exit(Fiber.join(fiber));
      yield* Deferred.await(a.writerReleased);
      yield* viewers.publish(snap("後"));
      expect(yield* Queue.take(b.frames)).toEqual(snap("後"));
      expect(yield* Queue.size(a.frames)).toBe(0);
    }).pipe(Effect.provide(Viewers.layer)));
});
