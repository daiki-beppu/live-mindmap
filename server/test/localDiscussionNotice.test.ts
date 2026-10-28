import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { DiffUpdater, makeSession, type LogEvent } from "../src/core/index.ts";
import { localUpdaterLayer } from "../src/localDiffUpdater.ts";
import type { Classification } from "../src/localPrompt.ts";
import { HAIKU, routedUpdater, SONNET } from "../src/routedDiffUpdater.ts";
import { collectLog } from "./fixtures/sessionLayers.ts";

describe("実ローカル変換からセッションの通知へ接続する", () => {
  it.effect.each([false, true])("振り分け=%sでも、同じセッションで子の増加と発言時刻から一度だけ通知する", (routed) => Effect.gen(function* () {
    const events: LogEvent[] = [];
    let classified = 0;
    const local = yield* DiffUpdater.pipe(Effect.provide(localUpdaterLayer({
      classify: (request) => Effect.sync(() => {
        const index = classified++;
        const raw: Classification = {
          議題: { id: index === 0 ? "新しい議題" : "n1", 題: index === 0 ? "資料配布" : "" },
          文: index === 0 ? [{ 種類: "問い", text: "配布方法は" }]
            : index <= 3 ? [{ 種類: "提案", text: `配布案${index}` }] : [{ 種類: "なし" }],
          済み: "なし", 名前: [],
        };
        return Schema.decodeUnknownSync(request.schema)(raw);
      }),
      katakana: () => Effect.succeed([]),
    })));
    let judged = 0;
    const updater = routed ? yield* routedUpdater({
      sonnet: local, haiku: local,
      ask: () => Effect.sync(() => {
        const p = judged++ % 2 === 0 ? 0.9 : 0.1;
        return { ok: true, answers: { route: { distribution: { yes: p, no: 1 - p }, chosen: p >= 0.5 ? "yes" : "no", confidence: Math.max(p, 1 - p) } } };
      }),
    }) : local;
    const session = yield* makeSession({ title: "資料配布" }).pipe(Effect.provide(Layer.merge(
      collectLog(events), Layer.succeed(DiffUpdater, updater),
    )));
    const advance = Effect.fnUntraced(function* (end: number) {
      yield* session.push({ id: `r${end}`, track: "相手", start: end === 1 ? 0 : end - 1, end, text: "候補です。" });
      yield* session.idle;
      const diff = events.filter((event) => event.type === "diff").at(-1);
      expect(diff).toMatchObject({ dropped: [] });
      expect(diff).not.toHaveProperty("error");
    });
    for (const end of [1, 100, 200, 300, 599]) yield* advance(end);
    expect(events.filter((event) => event.type === "discussion-notice")).toHaveLength(0);
    expect((yield* session.snapshot).nodes.filter((node) => node.kind === "案").map((node) => node.parent)).toEqual(["n2", "n2", "n2"]);
    yield* advance(600);
    expect(events.filter((event) => event.type === "discussion-notice")).toEqual([
      expect.objectContaining({ pointId: "n2", at: 600, text: "「配布方法は」が 10 分決まっていません。何を重視して決めるかを先に確かめませんか" }),
    ]);
    yield* advance(1200);
    expect(events.filter((event) => event.type === "discussion-notice")).toHaveLength(1);
    expect(classified).toBe(7);
    expect(judged).toBe(routed ? 7 : 0);
    if (routed) expect(events.filter((event) => event.type === "diff").map((event) => event.judge?.model)).toEqual([
      SONNET, HAIKU, SONNET, HAIKU, SONNET, HAIKU, SONNET,
    ]);
  }));
});
