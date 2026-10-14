import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RequestSelfPause } from "../src/app/meeting/command.ts";
import { Message } from "../src/app/meeting/message.ts";

// Issue #1069: M が出す RequestSelfPause を実際に実行し、fetch 境界で POST /session/self-pause と {paused} の本文を観測する
const run = (paused: boolean) => Effect.runPromise((RequestSelfPause({ paused }) as unknown as { effect: Effect.Effect<unknown> }).effect);

afterEach(() => vi.unstubAllGlobals());

describe("RequestSelfPause の実行", () => {
  for (const paused of [true, false]) {
    it(`paused:${paused} を POST /session/self-pause の JSON 本文で送り、完了の Message を返す`, async () => {
      const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
      vi.stubGlobal("fetch", fetchMock);
      const result = await run(paused);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe("/session/self-pause");
      expect(init.method).toBe("POST");
      expect(JSON.parse(String(init.body))).toEqual({ paused });
      expect(result).toEqual(Message.CompletedRequestSelfPause());
    });
  }

  it("送れなかった・断られたときも、画面は変えず完了の Message を返す", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("network"); }));
    expect(await run(true)).toEqual(Message.CompletedRequestSelfPause());
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 409 })));
    expect(await run(false)).toEqual(Message.CompletedRequestSelfPause());
  });
});
