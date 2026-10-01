import { describe, expect, it } from "vitest";
import { createSession, playback, type DiffInput, type Remark } from "../src/core/index.ts";

const remarks: Remark[] = [
  { id: "r1", track: "相手", start: 0.5, end: 9.8, text: "a" },
  { id: "r2", track: "相手", start: 9.8, end: 19.2, text: "b" },
  { id: "r3", track: "相手", start: 19.2, end: 28.0, text: "c" },
];

function setup(order: string[]) {
  const updater = async (input: DiffInput) => {
    order.push(`diff:${input.fresh.map((u) => u.id).join("+")}`);
    return { ops: [] };
  };
  return createSession({
    title: "定例",
    updater,
    log: (e) => {
      if (e.type === "remark") order.push(`push:${e.remark.id}`);
    },
  });
}

describe("再生", () => {
  it("等速: 発言の end の差だけ待ってから流す（最初は 0 からの差）", async () => {
    const order: string[] = [];
    const sleep = async (ms: number) => {
      order.push(`sleep:${Math.round(ms)}`);
    };
    await playback(setup(order), remarks, { sleep });
    const sleeps = order.filter((s) => s.startsWith("sleep:"));
    expect(sleeps).toEqual(["sleep:9800", "sleep:9400", "sleep:8800"]);
    // 待ってから流す順
    expect(order.filter((s) => !s.startsWith("diff:"))).toEqual([
      "sleep:9800", "push:r1", "sleep:9400", "push:r2", "sleep:8800", "push:r3",
    ]);
  });

  it("等速: 流した発言は最後の flush で取りこぼさず差分更新に渡る", async () => {
    const order: string[] = [];
    await playback(setup(order), remarks, { sleep: async () => {} });
    const diffs = order.filter((s) => s.startsWith("diff:")).join(",").replaceAll("diff:", "").split(/[,+]/);
    expect(diffs.sort()).toEqual(["r1", "r2", "r3"]);
  });

  it("等速: 差分更新の呼び出しの完了を待たずに次の待ちへ進む（ライブと同じ呼び出し方）", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const calls: string[][] = [];
    let sleepCount = 0;
    const session = createSession({
      title: "定例",
      updater: async (input) => {
        calls.push(input.fresh.map((u) => u.id));
        await gate;
        return { ops: [] };
      },
      log: () => {},
    });
    const done = playback(session, remarks, {
      sleep: async () => {
        sleepCount++;
        if (sleepCount === 3) release(); // 3 つ目の待ちに入った時点で、最初の呼び出しはまだ終わっていない
      },
    });
    await done;
    expect(sleepCount).toBe(3);
    expect(calls[0]).toEqual(["r1", "r2"]);
  });

  it("待ち時間なし（sleep を渡さない）: sleep せず、1 発言ごとに呼び出しの終わりを待つ", async () => {
    const order: string[] = [];
    await playback(setup(order), remarks);
    expect(order).toEqual(["push:r1", "push:r2", "diff:r1+r2", "push:r3", "diff:r3"]);
  });
});
