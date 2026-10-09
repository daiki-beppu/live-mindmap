import { readFileSync } from "node:fs";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { restoreSession } from "../src/core/index.ts";
import { remark, restore, scripted } from "./fixtures/restore.ts";
import { silentLog, updaterLayer } from "./fixtures/sessionLayers.ts";

// 今の形式の log.jsonl（fixtures/session.log.jsonl）を本物のファイルシステムで読んで復元する。ほかの復元の確認は restore.test.ts

describe("今の形式の log.jsonl（fixtures）からの復元", () => {
  const lines = readFileSync(new URL("./fixtures/session.log.jsonl", import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l !== "")
    .map((l): unknown => JSON.parse(l));

  it("fixture の diff の行は、usage を持つ行と持たない行が混ざっている（新旧の形を同じログで読むための前提）", () => {
    const diffs = lines.filter((l) => (l as { type: string }).type === "diff");
    expect(diffs.some((l) => (l as { usage?: unknown }).usage !== undefined)).toBe(true);
    expect(diffs.some((l) => (l as { usage?: unknown }).usage === undefined)).toBe(true);
  });

  it("fixture は、行ごとに at を持つ今の形式で、intake-*・知らない type・noContent・error・dropped を含む（テストの前提）", () => {
    const types = lines.map((l) => (l as { type: string }).type);
    expect(new Set(types)).toEqual(new Set(["start", "remark", "diff", "intake-restarted", "intake-stopped", "future-event"]));
    expect(lines.every((l) => typeof (l as { at?: unknown }).at === "string")).toBe(true);
    expect(lines.some((l) => (l as { noContent?: boolean }).noContent === true)).toBe(true);
    expect(lines.some((l) => typeof (l as { error?: unknown }).error === "string")).toBe(true);
    expect(lines.some((l) => ((l as { dropped?: unknown[] }).dropped ?? []).length > 0)).toBe(true);
  });

  it.effect("ノード・根拠の発言・変わったこと・round・今の議題・今の時刻が、ログの内容どおりに戻る", () =>
    Effect.gen(function* () {
      const restored = yield* restore(lines);
      const snap = yield* restored.snapshot;

      expect(snap.nodes.map((n) => [n.id, n.kind, n.text])).toEqual([
        ["root", "会議", "定例"],
        ["n1", "議題", "採用"],
        ["n2", "論点", "面接は何回か"],
        ["n3", "決定", "2 回にする"],
      ]);
      expect(snap.nodes.find((n) => n.id === "n2")).toMatchObject({ pointStatus: "決定済み" });
      expect(snap.round).toBe(2); // 失敗した 3 回目の反映では進まない
      expect(snap.changes).toEqual([
        { round: 1, at: 19, change: "追加", node: "n1", kind: "議題", text: "採用" },
        { round: 1, at: 19, change: "追加", node: "n2", kind: "論点", text: "面接は何回か" },
        { round: 2, at: 49, change: "決定済み化", node: "n2", kind: "論点", text: "面接は何回か" },
        { round: 2, at: 49, change: "追加", node: "n3", kind: "決定", text: "2 回にする" },
      ]);
      expect(snap.remarks.map((r) => r.id)).toEqual(["r1", "r2", "r4"]); // 根拠に挙がった発言だけ
      expect(snap.currentTopic).toBe("n1");
      expect(snap.now).toBe(90); // 最後に受け取った発言（r9）の end
    }));

  it.effect("差分更新に渡さなかった発言だけが未反映に残る（重複の印つき・中身のない発言・error の回に渡した発言は含まない）", () =>
    Effect.gen(function* () {
      const restored = yield* restore(lines);
      expect((yield* restored.unreflectedRemarks).map((r) => r.id)).toEqual(["r9"]);
    }));

  it.effect("復元したセッションは、そのまま続きの発言を受け取って差分更新を呼べる", () =>
    Effect.gen(function* () {
      const cont = scripted([]);
      const restored = yield* restoreSession(lines).pipe(Effect.provide(Layer.merge(updaterLayer(cont.update), silentLog)));
      yield* restored.push(remark("続きの発言", { id: "r10" })); // fixture の発言 ID（r1〜r9）と重ならない ID にする
      yield* restored.idle;

      expect(cont.calls).toHaveLength(1);
      expect(cont.calls[0]!.fresh.map((u) => u.id)).toEqual(["r9", "r10"]);
      // 直前の発言は、処理済み（error の回に渡した r7・r8 も含む）の最後の 3 つ。中身のない r3 は含まない
      expect(cont.calls[0]!.recent.map((u) => u.id)).toEqual(["r5", "r7", "r8"]);
    }));
});
