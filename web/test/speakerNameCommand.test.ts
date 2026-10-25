import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCollectingLogs } from "./debugLogs.ts";
import { RequestSpeakerName } from "../src/app/sessionLayout/command.ts";
import { Message } from "../src/app/sessionLayout/message.ts";

// Issue #1026: 名前の欄の確定が出す RequestSpeakerName を実際に実行し、fetch 境界で POST /session/speaker-name と {label,name} の本文を観測する
const run = (label: string, name: string) => Effect.runPromise((RequestSpeakerName({ label, name }) as unknown as { effect: Effect.Effect<unknown> }).effect);

afterEach(() => vi.unstubAllGlobals());

describe("RequestSpeakerName の実行", () => {
  it("label と name を POST /session/speaker-name の JSON 本文で送り、完了の Message を返す", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await run("相手 B", "田中");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/session/speaker-name");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ label: "相手 B", name: "田中" });
    expect(result).toEqual(Message.CompletedRequestSpeakerName());
  });

  it("送れなかった・断られたときも、画面は変えず（名前は /ws の frame でだけ変わる）完了の Message を返す", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("network"); }));
    expect(await run("相手 B", "田中")).toEqual(Message.CompletedRequestSpeakerName());
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 409 })));
    expect(await run("相手 B", "田中")).toEqual(Message.CompletedRequestSpeakerName());
  });

  // Issue #1576: server が 4xx/5xx で断ったら、送れなかったときと同じ失敗の道（Debug ログ）を通る
  for (const status of [409, 500]) {
    it(`status ${status} の応答は失敗として Debug ログに残し、完了の Message を返す`, async () => {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status })));
      const { result, logs } = await runCollectingLogs((RequestSpeakerName({ label: "相手 B", name: "田中" }) as unknown as { effect: Effect.Effect<unknown> }).effect);
      expect(result).toEqual(Message.CompletedRequestSpeakerName());
      expect(logs).toContainEqual({ level: "Debug", message: "話者の名前を server に送れない" });
    });
  }

  it("2xx の応答では失敗のログを出さない", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
    const { logs } = await runCollectingLogs((RequestSpeakerName({ label: "相手 B", name: "田中" }) as unknown as { effect: Effect.Effect<unknown> }).effect);
    expect(logs).not.toContainEqual(expect.objectContaining({ message: "話者の名前を server に送れない" }));
  });
});
