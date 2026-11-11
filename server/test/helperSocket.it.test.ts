import { createHash } from "node:crypto";
import { createServer, type AddressInfo, type Server } from "node:net";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber, Stream } from "effect";
import { TestClock } from "effect/testing";
import { openHelperSocket } from "../src/helperSocket.ts";

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

describe("openHelperSocket（ヘルパーへの WebSocket。Queue.offerUnsafe + Stream.fromQueue）", () => {
  it.effect("ハンドシェイクと同じ塊で届いたメッセージも、Stream から届いた順に読める（early バッファ無しで取りこぼさない）", () =>
    Effect.gen(function* () {
      const server = yield* Effect.acquireRelease(
        Effect.promise(() => coalescingServer(['{"n":1}', '{"n":2}'])),
        (s) => Effect.sync(() => s.close()),
      );
      const port = (server.address() as AddressInfo).port;

      const { events } = yield* openHelperSocket(`ws://127.0.0.1:${port}`);
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
      const port = yield* Effect.promise(() => new Promise<number>((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port))));
      yield* Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve())));

      const exit = yield* Effect.exit(openHelperSocket(`ws://127.0.0.1:${port}`));

      expect(exit._tag).toBe("Failure");
    }));

  it.effect("つなげなかった後でも、同じ関数呼び出しを再試行すればつながる", () =>
    Effect.gen(function* () {
      const closedServer = createServer();
      const port = yield* Effect.promise(() => new Promise<number>((resolve) => closedServer.listen(0, "127.0.0.1", () => resolve((closedServer.address() as AddressInfo).port))));
      yield* Effect.promise(() => new Promise<void>((resolve) => closedServer.close(() => resolve())));
      const failed = yield* Effect.exit(openHelperSocket(`ws://127.0.0.1:${port}`));
      expect(failed._tag).toBe("Failure");

      const server = yield* Effect.acquireRelease(
        Effect.promise(() => coalescingServer([])),
        (s) => Effect.sync(() => s.close()),
      );
      const reopenedPort = (server.address() as AddressInfo).port;

      const { events } = yield* openHelperSocket(`ws://127.0.0.1:${reopenedPort}`);
      expect(events).toBeDefined();
    }));
});
