import { createHash } from "node:crypto";
import { createServer, type AddressInfo, type Server } from "node:net";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber, Stream } from "effect";
import { TestClock } from "effect/testing";
import { openHelperSocket } from "../src/helperSocket.ts";
import { promiseOrDie } from "./fixtures/promiseOrDie.ts";

// ハンドシェイクの応答と、続くテキストフレームを 1 回の write で返すサーバー。
// 遅い環境で、ヘルパーが接続直後に送ったイベントが応答と同じ塊で届く状況を、毎回起こす
function coalescingServer(messages: string[]): Promise<Server> {
  const frame = (text: string) => {
    const payload = Buffer.from(text);
    return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  };
  const server = createServer((socket) =>
    socket.once("data", (request) => {
      const key = /Sec-WebSocket-Key: (.*)\r\n/i.exec(String(request))![1]!.trim();
      const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
      const head = `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`;
      socket.write(Buffer.concat([Buffer.from(head), ...messages.map(frame)]));
    }),
  );
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

// server/src/helperSocket.ts は段 3（Issue #240、ADR 0008）で early バッファをやめ、
// 同じ同期区間で作った Queue へ Queue.offerUnsafe し、読む側は Stream.fromQueue で読む形に書き換える
// （order.md:33, 63）。接続できなければ失敗になり、呼び出し側（Helpers）が Schedule.spaced で再試行できる
// （order.md:23, 63。今までは undefined を返して呼び出し側がループしていた）。
describe("openHelperSocket（ヘルパーへの WebSocket。Queue.offerUnsafe + Stream.fromQueue）", () => {
  it.effect("ハンドシェイクと同じ塊で届いたメッセージも、Stream から届いた順に読める（early バッファ無しで取りこぼさない）", () =>
    Effect.gen(function* () {
      const server = yield* Effect.acquireRelease(
        promiseOrDie(() => coalescingServer(['{"n":1}', '{"n":2}'])),
        (s) => Effect.sync(() => s.close()),
      );
      const port = (server.address() as AddressInfo).port;

      const events = yield* openHelperSocket(`ws://127.0.0.1:${port}`);
      // Queue.offerUnsafe は接続の時点からすぐに流れている（購読を遅らせても、
      // ハンドシェイクと同じ塊で届いた分を取りこぼさないことを確かめるため、TestClock で少し進めてから読む）
      const waiting = yield* Effect.forkChild(Effect.sleep(50));
      yield* TestClock.adjust(50);
      yield* Fiber.join(waiting);
      const received = yield* Stream.runCollect(Stream.take(events, 2));

      expect(received).toEqual(['{"n":1}', '{"n":2}']);
    }));

  it.effect("つなげなければ失敗になる（呼び出し側が再試行できる）", () =>
    Effect.gen(function* () {
      const server = yield* Effect.acquireRelease(
        Effect.sync(() => createServer()),
        (s) => Effect.sync(() => s.close()),
      );
      const port = yield* promiseOrDie(() => new Promise<number>((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port))));
      yield* promiseOrDie(() => new Promise<void>((resolve) => server.close(() => resolve()))); // listen した直後に閉じ、何も待ち受けていないポートにする

      const exit = yield* Effect.exit(openHelperSocket(`ws://127.0.0.1:${port}`));

      expect(exit._tag).toBe("Failure");
    }));

  it.effect("つなげなかった後でも、同じ関数呼び出しを再試行すればつながる", () =>
    Effect.gen(function* () {
      const closedServer = createServer();
      const port = yield* promiseOrDie(() => new Promise<number>((resolve) => closedServer.listen(0, "127.0.0.1", () => resolve((closedServer.address() as AddressInfo).port))));
      yield* promiseOrDie(() => new Promise<void>((resolve) => closedServer.close(() => resolve())));
      const failed = yield* Effect.exit(openHelperSocket(`ws://127.0.0.1:${port}`));
      expect(failed._tag).toBe("Failure");

      const server = yield* Effect.acquireRelease(
        promiseOrDie(() => coalescingServer([])),
        (s) => Effect.sync(() => s.close()),
      );
      const reopenedPort = (server.address() as AddressInfo).port;

      const events = yield* openHelperSocket(`ws://127.0.0.1:${reopenedPort}`);
      expect(events).toBeDefined();
    }));
});
