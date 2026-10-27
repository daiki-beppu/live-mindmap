import { Effect, Fiber, Logger, Stream } from "effect";
import { TestClock } from "effect/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Snapshot } from "../../server/src/core/index.ts";
import { Message } from "../src/app/liveFeed/message.ts";
import { init, update } from "../src/app/liveFeed/main.ts";
import { captionDeadlineStream, liveFeedStream, RECONNECT_MS } from "../src/app/liveFeed/subscription.ts";
import { spokenBubble, spokenFrame } from "./fixtures/captions.ts";

// ライブの受信（Issue #828）の Subscription の stream。WebSocket と location は最小の代役、時計は TestClock。
// Subscription は「つながった」「frame を受けた」「切れた」の事実を Message にするだけで、1 秒後のつなぎ直しはこの stream の中にある。
// 状態の更新の規則（applyFrame / applyOpen / applyClose）は update 側（liveFeed.story.test.ts）で確かめる。

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  onopen: ((e?: unknown) => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e?: unknown) => void) | null = null;
  onerror: ((e?: unknown) => void) | null = null;
  private listeners: Record<string, Array<(e: unknown) => void>> = {};
  close = vi.fn();
  readonly url: string;
  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }
  addEventListener(type: string, listener: (e: unknown) => void) {
    (this.listeners[type] ??= []).push(listener);
  }
  removeEventListener(type: string, listener: (e: unknown) => void) {
    this.listeners[type] = (this.listeners[type] ?? []).filter((l) => l !== listener);
  }
  private fire(type: string, event: unknown, handler: ((e: never) => void) | null) {
    handler?.(event as never);
    for (const l of this.listeners[type] ?? []) l(event);
  }
  open() {
    this.fire("open", {}, this.onopen);
  }
  receive(data: string) {
    this.fire("message", { data }, this.onmessage);
  }
  drop() {
    this.fire("close", {}, this.onclose);
  }
}

const node = (id: string, parent: string | null) => ({ id, parent, kind: parent === null ? ("会議" as const) : ("議題" as const), text: id, evidence: parent ? ["r1"] : [] });
const snapshot: Snapshot = { nodes: [node("root", null), node("A", "root")], round: 1, changes: [], remarks: [] };

const sockets = () => FakeWebSocket.instances;
const settle = Effect.forEach(Array.from({ length: 20 }), () => Effect.yieldNow, { discard: true });

// stream を走らせて届いた Message を集める。body は走らせている間の操作
const run = <A>(body: (collected: Array<typeof Message.Type>, fiber: Fiber.Fiber<void, unknown>) => Effect.Effect<A>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const collected: Array<typeof Message.Type> = [];
      const fiber = yield* Effect.forkChild(Stream.runForEach(liveFeedStream, (m) => Effect.sync(() => void collected.push(m))));
      yield* settle;
      const result = yield* body(collected, fiber);
      yield* Fiber.interrupt(fiber);
      return result;
    }).pipe(Effect.provide(TestClock.layer())),
  );

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("location", { protocol: "http:", host: "localhost:1" });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("接続先", () => {
  it.each([
    ["http:", "ws://localhost:1/ws"],
    ["https:", "wss://localhost:1/ws"],
  ])("location.protocol が %s なら %s につなぐ（同じホストの /ws）", async (protocol, url) => {
    vi.stubGlobal("location", { protocol, host: "localhost:1" });
    await run(() => Effect.sync(() => expect(sockets().map((s) => s.url)).toEqual([url])));
  });
});

describe("事実を Message にする", () => {
  it("open は ConnectedLiveFeed、close は DisconnectedLiveFeed になる", async () => {
    await run((collected) =>
      Effect.gen(function* () {
        sockets()[0]!.open();
        yield* settle;
        expect(collected).toEqual([Message.ConnectedLiveFeed()]);
        sockets()[0]!.drop();
        yield* settle;
        expect(collected).toEqual([Message.ConnectedLiveFeed(), Message.DisconnectedLiveFeed()]);
      }),
    );
  });

  it("server が送る 8 種類の type の frame を decode して ReceivedLiveFrame にする", async () => {
    const frames = [
      { type: "snapshot", snapshot },
      { type: "captions", bubbles: [{ id: "c1", track: "相手", speaker: "相手 A", label: "仮", start: 1, end: 2, text: "こんにち", settledLength: 0 }] },
      { type: "intake", status: "interrupted" },
      { type: "screen-notice", text: "共有画面は使っていません" },
      { type: "tap-notice", text: null },
      { type: "diff-update", state: { status: "paused", reason: "ChatGPT の利用上限" } },
      { type: "session-mode", local: true },
      { type: "self-pause", paused: true, reason: "自動" },
    ] as const;
    await run((collected) =>
      Effect.gen(function* () {
        sockets()[0]!.open();
        for (const f of frames) sockets()[0]!.receive(JSON.stringify(f));
        yield* settle;
        expect(collected).toEqual([Message.ConnectedLiveFeed(), ...frames.map((frame) => Message.ReceivedLiveFrame({ frame, receivedAt: 0 }))]);
      }),
    );
  });

  it("frame を受けた時刻は、Subscription が Clock から付ける（接続や切断の事実には付けない）", async () => {
    await run((collected) =>
      Effect.gen(function* () {
        sockets()[0]!.open();
        yield* TestClock.adjust(500);
        sockets()[0]!.receive(JSON.stringify({ type: "intake", status: "stopped" }));
        yield* settle;
        yield* TestClock.adjust(250);
        sockets()[0]!.receive(JSON.stringify({ type: "intake", status: "running" }));
        yield* settle;
        expect(collected).toEqual([
          Message.ConnectedLiveFeed(),
          Message.ReceivedLiveFrame({ frame: { type: "intake", status: "stopped" }, receivedAt: 500 }),
          Message.ReceivedLiveFrame({ frame: { type: "intake", status: "running" }, receivedAt: 750 }),
        ]);
      }),
    );
  });

  it("type が snapshot でない frame は、スナップショットを持っていても、スナップショットとして扱わない（知らない type・不正な payload）", async () => {
    await run((collected) =>
      Effect.gen(function* () {
        const ws = sockets()[0]!;
        ws.open();
        ws.receive(JSON.stringify({ type: "snapshot", snapshot }));
        ws.receive(JSON.stringify({ type: "future-frame", snapshot }));
        ws.receive(JSON.stringify({ type: "captions", bubbles: "x", snapshot }));
        ws.receive(JSON.stringify({ type: "intake", status: "stopped" }));
        yield* settle;
        expect(collected).toEqual([
          Message.ConnectedLiveFeed(),
          Message.ReceivedLiveFrame({ frame: { type: "snapshot", snapshot }, receivedAt: 0 }),
          Message.ReceivedLiveFrame({ frame: { type: "intake", status: "stopped" }, receivedAt: 0 }),
        ]);
        expect(sockets()).toHaveLength(1);
      }),
    );
  });

  it("壊れた JSON・知らない type・形の合わない frame は Message にせず、その後の frame は届き続ける（画面を止めない）", async () => {
    await run((collected) =>
      Effect.gen(function* () {
        const ws = sockets()[0]!;
        ws.open();
        ws.receive("これは JSON ではない");
        ws.receive(JSON.stringify({ type: "future-frame", x: 1 }));
        ws.receive(JSON.stringify({ type: "captions", bubbles: [{ id: "c", track: "他人", label: "なし", start: 0, end: 1, text: "x" }] }));
        ws.receive(JSON.stringify({ type: "intake", status: "unknown-status" }));
        ws.receive(JSON.stringify({ type: "self-pause", paused: "yes" }));
        ws.receive(JSON.stringify({ type: "self-pause" }));
        ws.receive(JSON.stringify({ type: "self-pause", paused: true })); // 休止中は理由が要る
        ws.receive(JSON.stringify({ type: "self-pause", paused: true, reason: "判定できない" })); // 休止中の理由は手動・自動だけ
        ws.receive(JSON.stringify({ type: "intake", status: "stopped" }));
        yield* settle;
        expect(collected).toEqual([Message.ConnectedLiveFeed(), Message.ReceivedLiveFrame({ frame: { type: "intake", status: "stopped" }, receivedAt: 0 })]);
        expect(sockets()).toHaveLength(1); // 無視しただけで、つなぎ直さない
      }),
    );
  });
});

const waitUntil = Effect.fnUntraced(function* (condition: () => boolean, description: string) {
  const deadline = performance.now() + 2000;
  while (!condition()) {
    if (performance.now() >= deadline) return yield* Effect.die(new Error(`待機期限: ${description}`));
    yield* Effect.yieldNow;
  }
});

type LogEntry = ReturnType<typeof Logger.formatStructured.log>;

const runPage = async (body: (messages: Message[], logs: LogEntry[]) => Effect.Effect<void>) => {
  vi.resetModules();
  const { liveFeedStream: pageStream } = await import("../src/app/liveFeed/subscription.ts");
  const logs: LogEntry[] = [];
  const logger = Logger.map(Logger.formatStructured, (entry) => void logs.push(entry));
  await Effect.runPromise(
    Effect.gen(function* () {
      const messages: Message[] = [];
      const fiber = yield* Effect.forkChild(Stream.runForEach(pageStream, (m) => Effect.sync(() => void messages.push(m))));
      yield* waitUntil(() => sockets().length === 1, "最初の WebSocket");
      yield* body(messages, logs).pipe(Effect.ensuring(Fiber.interrupt(fiber)));
    }).pipe(Effect.provide(TestClock.layer()), Effect.provide(Logger.layer([logger]))),
  );
};

const warningSentence = (type: string) => `読めない画面の更新「${type}」を読み飛ばしました。server と画面の版がずれています。画面を読み込み直してください`;
const warningText = (entry: LogEntry) => JSON.stringify({ message: entry.message, cause: entry.cause, annotations: entry.annotations });
const flushFrames = Effect.fnUntraced(function* (messages: Message[], status: "stopped" | "running") {
  const before = messages.length;
  sockets().at(-1)!.receive(JSON.stringify({ type: "intake", status }));
  yield* waitUntil(() => messages.slice(before).some((m) => m._tag === "ReceivedLiveFrame" && m.frame.type === "intake" && m.frame.status === status), `後続の intake ${status}`);
});

describe("読めない frame の警告", () => {
  it.each([
    {
      type: "captions",
      frame: { type: "captions", bubbles: [{ ...spokenBubble("字幕本文の秘密"), track: "不正値の秘密" }] },
      path: "track",
      secrets: ["字幕本文の秘密", "不正値の秘密"],
    },
    {
      type: "snapshot",
      frame: { type: "snapshot", snapshot: { ...snapshot, nodes: [{ ...node("root", null), text: "マップ本文の秘密" }], round: "不正値の秘密" } },
      path: "round",
      secrets: ["マップ本文の秘密", "不正値の秘密"],
    },
  ])("$type の不正な payload は type と失敗位置だけを Warning に出し、本文を出さない", async ({ type, frame, path, secrets }) => {
    await runPage((messages, logs) =>
      Effect.gen(function* () {
        sockets()[0]!.open();
        sockets()[0]!.receive(JSON.stringify(frame));
        yield* flushFrames(messages, "stopped");
        expect(logs).toHaveLength(1);
        expect(logs[0]!.level).toBe("WARN");
        expect(warningText(logs[0]!)).toContain(warningSentence(type));
        expect(warningText(logs[0]!)).toContain(path);
        for (const entry of logs) {
          for (const secret of secrets) expect(warningText(entry)).not.toContain(secret);
        }
      }),
    );
  });

  it("最上位の type ごとに一度だけ警告し、payload 内の type で分類しない", async () => {
    await runPage((messages, logs) =>
      Effect.gen(function* () {
        const ws = sockets()[0]!;
        ws.open();
        yield* flushFrames(messages, "running");
        expect(logs).toEqual([]);
        ws.receive(JSON.stringify({ type: "future-a", payload: { type: "future-b", text: "未知の本文の秘密" } }));
        ws.receive(JSON.stringify({ type: "future-a", payload: { text: "別の本文の秘密" } }));
        ws.receive(JSON.stringify({ type: "future-b" }));
        yield* flushFrames(messages, "stopped");
        expect(logs).toHaveLength(2);
        expect(warningText(logs[0]!)).toContain(warningSentence("future-a"));
        expect(warningText(logs[1]!)).toContain(warningSentence("future-b"));
        for (const entry of logs) {
          expect(entry.level).toBe("WARN");
          expect(warningText(entry)).toContain("$");
          expect(warningText(entry)).not.toContain("未知の本文の秘密");
          expect(warningText(entry)).not.toContain("別の本文の秘密");
        }
      }),
    );
  });

  it("type を読めない入力は一組で一度だけ警告し、実際の文字列 type と衝突しない", async () => {
    await runPage((messages, logs) =>
      Effect.gen(function* () {
        const ws = sockets()[0]!;
        ws.open();
        yield* flushFrames(messages, "running");
        for (const data of [
          '{"type": "壊れた本文の秘密"',
          JSON.stringify({ payload: { type: "future-a" } }),
          JSON.stringify({ type: 7 }),
          JSON.stringify({ type: null }),
          JSON.stringify([{ type: "future-b" }]),
          "null",
          "42",
          JSON.stringify("本文中の type の秘密"),
        ]) ws.receive(data);
        yield* flushFrames(messages, "stopped");
        expect(logs).toHaveLength(1);
        const entry = logs[0]!;
        expect(entry.level).toBe("WARN");
        const text = warningText(entry);
        const match = /読めない画面の更新「([^」]*)」を読み飛ばしました。server と画面の版がずれています。画面を読み込み直してください/.exec(text);
        expect(match).not.toBeNull();
        expect(text.replace(match![0], "")).toMatch(/\$|root|ルート|\[\]|\//);
        for (const secret of ["壊れた本文の秘密", "本文中の type の秘密", "future-a", "future-b"]) expect(text).not.toContain(secret);
        ws.receive(JSON.stringify({ type: match![1] }));
        yield* flushFrames(messages, "running");
        expect(logs).toHaveLength(2);
        expect(warningText(logs[1]!)).toContain(warningSentence(match![1]!));
      }),
    );
  });

  it("同じページでつなぎ直しても既知の type と type 不明の警告を増やさず、新しい type は警告する", async () => {
    await runPage((messages, logs) =>
      Effect.gen(function* () {
        const first = sockets()[0]!;
        first.open();
        first.receive(JSON.stringify({ type: "captions", bubbles: "bad" }));
        first.receive("{");
        yield* flushFrames(messages, "stopped");
        const before = [...logs];
        first.drop();
        yield* waitUntil(() => messages.some((m) => m._tag === "DisconnectedLiveFeed") && first.close.mock.calls.length > 0, "切断の通知と解放");
        yield* TestClock.adjust(RECONNECT_MS);
        yield* waitUntil(() => sockets().length === 2, "再接続");
        const second = sockets()[1]!;
        second.open();
        second.receive(JSON.stringify({ type: "captions", bubbles: null }));
        second.receive(JSON.stringify({ type: false }));
        second.receive(JSON.stringify({ type: "future-after-reconnect" }));
        yield* flushFrames(messages, "running");
        expect(before).toHaveLength(2);
        expect(logs.slice(0, 2)).toEqual(before);
        expect(logs).toHaveLength(3);
        expect(warningText(logs[2]!)).toContain(warningSentence("future-after-reconnect"));
        expect(second.close).not.toHaveBeenCalled();
      }),
    );
  });

  it("不正な更新を画面に通知せず既存のマップと字幕を保ち、同じ接続で後続の正常更新を届ける", async () => {
    await runPage((messages) =>
      Effect.gen(function* () {
        const ws = sockets()[0]!;
        ws.open();
        const frames = [{ type: "snapshot", snapshot }, spokenFrame("表示済みの字幕")] as const;
        for (const frame of frames) ws.receive(JSON.stringify(frame));
        yield* waitUntil(() => messages.length === 3, "正常なマップと字幕の受信");
        const before = messages.reduce((model, m) => update(model, m).model, init());
        ws.receive(JSON.stringify({ type: "captions", bubbles: "bad" }));
        ws.receive(JSON.stringify({ type: "snapshot", snapshot: "bad" }));
        ws.receive(JSON.stringify({ type: "future-frame", text: "通知してはいけない" }));
        ws.receive("{");
        yield* flushFrames(messages, "stopped");
        expect(messages).toEqual([
          Message.ConnectedLiveFeed(),
          ...frames.map((frame) => Message.ReceivedLiveFrame({ frame, receivedAt: 0 })),
          Message.ReceivedLiveFrame({ frame: { type: "intake", status: "stopped" }, receivedAt: 0 }),
        ]);
        expect(messages.reduce((model, m) => update(model, m).model, init())).toEqual({ ...before, intake: "stopped" });
        expect(sockets()).toHaveLength(1);
        expect(ws.close).not.toHaveBeenCalled();
      }),
    );
  });
});

describe("1 秒後のつなぎ直し", () => {
  it("切れた直後は新しくつながず、RECONNECT_MS（1,000 ms）ちょうどでつなぎ直す。つなぎ直した先の事実も届く", async () => {
    expect(RECONNECT_MS).toBe(1000);
    await run((collected) =>
      Effect.gen(function* () {
        sockets()[0]!.open();
        sockets()[0]!.drop();
        yield* settle;
        expect(sockets()).toHaveLength(1);

        yield* TestClock.adjust(RECONNECT_MS - 1);
        yield* settle;
        expect(sockets()).toHaveLength(1); // 999 ms ではまだ

        yield* TestClock.adjust(1);
        yield* settle;
        expect(sockets()).toHaveLength(2);
        expect(sockets()[1]!.url).toBe(sockets()[0]!.url);

        sockets()[1]!.open();
        sockets()[1]!.receive(JSON.stringify({ type: "session-mode", local: true }));
        yield* settle;
        expect(collected).toEqual([
          Message.ConnectedLiveFeed(),
          Message.DisconnectedLiveFeed(),
          Message.ConnectedLiveFeed(),
          Message.ReceivedLiveFrame({ frame: { type: "session-mode", local: true }, receivedAt: RECONNECT_MS }),
        ]);
      }),
    );
  });

  it("切れるたびにつなぎ直す（2 回続けて切れても、そのたびに 1,000 ms 後）", async () => {
    await run(() =>
      Effect.gen(function* () {
        sockets()[0]!.drop();
        yield* settle;
        yield* TestClock.adjust(RECONNECT_MS);
        yield* settle;
        expect(sockets()).toHaveLength(2);

        sockets()[1]!.drop();
        yield* settle;
        yield* TestClock.adjust(RECONNECT_MS - 1);
        yield* settle;
        expect(sockets()).toHaveLength(2);
        yield* TestClock.adjust(1);
        yield* settle;
        expect(sockets()).toHaveLength(3);
      }),
    );
  });

  it("つながっている間は、時間が経っても新しくつながない", async () => {
    await run(() =>
      Effect.gen(function* () {
        sockets()[0]!.open();
        yield* TestClock.adjust(RECONNECT_MS * 5);
        yield* settle;
        expect(sockets()).toHaveLength(1);
      }),
    );
  });
});

describe("止めたとき", () => {
  it("つながっている最中に止めると socket を閉じ、その後に切れても、時間が経っても、つなぎ直さない", async () => {
    await run((collected, fiber) =>
      Effect.gen(function* () {
        sockets()[0]!.open();
        yield* settle;
        yield* Fiber.interrupt(fiber);
        expect(sockets()[0]!.close).toHaveBeenCalled();

        sockets()[0]!.drop();
        yield* TestClock.adjust(RECONNECT_MS * 5);
        yield* settle;
        expect(sockets()).toHaveLength(1);
        expect(collected).toEqual([Message.ConnectedLiveFeed()]); // 止めた後の close は Message にしない
      }),
    );
  });

  it("切れて待っている最中に止めると、つなぎ直しは予約されたままにならない", async () => {
    await run((_collected, fiber) =>
      Effect.gen(function* () {
        sockets()[0]!.drop();
        yield* settle;
        yield* Fiber.interrupt(fiber);

        yield* TestClock.adjust(RECONNECT_MS * 5);
        yield* settle;
        expect(sockets()).toHaveLength(1);
      }),
    );
  });
});

describe("字幕の期限", () => {
  const collect = (deadline: number | null) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const collected: Array<typeof Message.Type> = [];
        const fiber = yield* Effect.forkChild(Stream.runForEach(captionDeadlineStream(deadline), (m) => Effect.sync(() => void collected.push(m))));
        yield* settle;
        const before = [...collected];
        yield* TestClock.adjust(999);
        const almost = [...collected];
        yield* TestClock.adjust(1);
        yield* settle;
        yield* Fiber.interrupt(fiber);
        return { before, almost, after: collected };
      }).pipe(Effect.provide(TestClock.layer())),
    );

  it("期限の時刻まで待って、来た時刻つきで 1 回だけ届ける", async () => {
    const { before, almost, after } = await collect(1000);

    expect(before).toEqual([]);
    expect(almost).toEqual([]);
    expect(after).toEqual([Message.ReachedCaptionDeadline({ at: 1000 })]);
  });

  it("期限が無ければ何も届けない", async () => {
    expect((await collect(null)).after).toEqual([]);
  });
});
