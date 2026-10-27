import { Result } from "effect";
import { describe, expect, it } from "vitest";
import * as ScreenQueue from "../src/core/screenQueue.ts";
import type { DiffEvent } from "../src/core/session.ts";

type Queue = ReturnType<typeof ScreenQueue.make>;
type Ref = NonNullable<(typeof DiffEvent.Type)["input"]["screens"]>[number];
const shot = (start: number): Ref => ({ start, image: `${start}.jpg` });
const gone = (start: number): Ref => ({ start, image: null });
const receive = (queue: Queue, screens: readonly Ref[], paused = false): Queue =>
  screens.reduce((q, screen) => ScreenQueue.receive(q, screen, paused), queue);
const diff = (selection: ReturnType<typeof ScreenQueue.select>, fresh = true): typeof DiffEvent.Type => ({
  type: "diff", input: { recent: [], fresh: fresh ? ["r1"] : [], nodeCount: 0, ...selection }, ops: [], dropped: [],
});
const consume = (queue: Queue, cutoff: number): Queue =>
  Result.getOrThrow(ScreenQueue.consume(queue, diff(ScreenQueue.select(queue, cutoff)), cutoff));

describe("共有画面のキュー", () => {
  it("一度も受信していなければ screens と screenCount のキーを返さない", () => {
    expect(ScreenQueue.select(ScreenQueue.make(), 20)).toEqual({});
  });

  it("締め切りを含む画面を時刻順に選び、締め切りより後の画面を次に残す", () => {
    const queue = receive(ScreenQueue.make(), [shot(20), shot(5), shot(35)]);
    expect(ScreenQueue.select(queue, 20)).toEqual({ screens: [shot(5), shot(20)], screenCount: 3 });
    expect(ScreenQueue.select(consume(queue, 20), 40)).toEqual({ screens: [shot(35)], screenCount: 3 });
  });

  it("受信済みでも締め切りに該当しなければ screens のキーを返さない", () => {
    const queue = receive(ScreenQueue.make(), [shot(50)]);
    expect(ScreenQueue.select(queue, 9)).toEqual({ screenCount: 1 });
  });

  it("新しい3件だけを選び、消費した後に古い画面を戻さない", () => {
    const queue = receive(ScreenQueue.make(), [0, 10, 20, 30, 40].map(shot));
    expect(ScreenQueue.select(queue, 50)).toEqual({ screens: [20, 30, 40].map(shot), screenCount: 5 });
    expect(ScreenQueue.select(consume(queue, 50), 60)).toEqual({ screenCount: 5 });
  });

  it("ちょうど3件なら「なし」も1件として全件を選び、4件なら古い1件を除く", () => {
    const three = receive(ScreenQueue.make(), [shot(0), gone(5), shot(10)]);
    expect(ScreenQueue.select(three, 20)).toEqual({ screens: [shot(0), gone(5), shot(10)], screenCount: 3 });
    const four = ScreenQueue.receive(three, gone(15), false);
    expect(ScreenQueue.select(four, 20)).toEqual({ screens: [gone(5), shot(10), gone(15)], screenCount: 4 });
  });

  it("選ぶだけでは消費も10秒の起点の更新もしない", () => {
    const queue = receive(ScreenQueue.make(), [shot(0), shot(5)]);
    const expected = { screens: [shot(0)], screenCount: 2 };
    expect(ScreenQueue.select(queue, 6)).toEqual(expected);
    expect(ScreenQueue.select(queue, 6)).toEqual(expected);
    expect(ScreenQueue.select(queue, 10)).toEqual(expected);
  });

  it("消費後に新しく受けた画面だけを次回に選び、受信数は累積する", () => {
    const first = receive(ScreenQueue.make(), [shot(0)]);
    const next = ScreenQueue.receive(consume(first, 10), shot(20), false);
    expect(ScreenQueue.select(next, 30)).toEqual({ screens: [shot(20)], screenCount: 2 });
  });

  for (const late of [shot(20), gone(0)]) {
    it(`選択後に受けた${late.image === null ? "同時刻の「なし」" : "画像"}を過去のdiffで消費しない`, () => {
      const first = receive(ScreenQueue.make(), [shot(0)]);
      const event = diff(ScreenQueue.select(first, 30));
      const during = ScreenQueue.receive(first, late, false);
      const next = Result.getOrThrow(ScreenQueue.consume(during, event, 30));
      expect(ScreenQueue.select(next, 30)).toEqual({ screens: [late], screenCount: 2 });
    });
  }

  it("失敗したdiffでもその行の受信数までを消費し、後着の画像と「なし」を残す", () => {
    const first = receive(ScreenQueue.make(), [shot(0)]);
    const event = { ...diff(ScreenQueue.select(first, 30)), error: "UpdateFailed: 失敗" };
    const during = receive(first, [shot(20), gone(21)]);
    const next = Result.getOrThrow(ScreenQueue.consume(during, event, 30));
    expect(ScreenQueue.select(next, 30)).toEqual({ screens: [shot(20), gone(21)], screenCount: 3 });
  });

  it("受信数より大きいscreenCountはResultの失敗を返す", () => {
    const queue = receive(ScreenQueue.make(), [gone(0)]);
    expect(Result.isFailure(ScreenQueue.consume(queue, diff({ screenCount: 2 }), 10))).toBe(true);
    expect(ScreenQueue.select(queue, 10)).toEqual({ screens: [gone(0)], screenCount: 1 });
  });

  it("freshのないdiffは未消費の画面を取り除かない", () => {
    const queue = receive(ScreenQueue.make(), [shot(0)]);
    const next = Result.getOrThrow(ScreenQueue.consume(queue, diff({ screenCount: 1 }, false), 10));
    expect(ScreenQueue.select(next, 10)).toEqual({ screens: [shot(0)], screenCount: 1 });
  });

  it("消費は再選択せずログに添えた画像を10秒の起点にする", () => {
    const queue = receive(ScreenQueue.make(), [shot(0), shot(5)]);
    const next = Result.getOrThrow(ScreenQueue.consume(queue, diff({ screens: [shot(5)], screenCount: 2 }), 6));
    const received = ScreenQueue.receive(next, shot(12), false);
    expect(ScreenQueue.select(received, 13)).toEqual({ screenCount: 3 });
  });

  describe("10秒の間隔・持ち越し・共有終了", () => {
    const sentFirst = () => consume(receive(ScreenQueue.make(), [shot(0)]), 1);

    it("前に添えた画像から10秒未満の画像を添えない", () => {
      const queue = receive(sentFirst(), [shot(5)]);
      expect(ScreenQueue.select(queue, 6)).toEqual({ screenCount: 2 });
    });

    it("前に添えた画像からちょうど10秒の画像を添える", () => {
      const queue = receive(sentFirst(), [shot(10)]);
      expect(ScreenQueue.select(queue, 15)).toEqual({ screens: [shot(10)], screenCount: 2 });
    });

    it("10秒未満の変化は最新1件だけを持ち越し、途中の画像を捨てる", () => {
      const queue = receive(sentFirst(), [shot(4), shot(8)]);
      expect(ScreenQueue.select(queue, 9)).toEqual({ screenCount: 3 });
      const next = consume(queue, 9);
      expect(ScreenQueue.select(next, 30)).toEqual({ screens: [shot(8)], screenCount: 3 });
      expect(ScreenQueue.select(consume(next, 30), 40)).toEqual({ screenCount: 3 });
    });

    it("持ち越しは10秒が過ぎるまで添えず、添えた後は再び選ばない", () => {
      let queue = consume(receive(sentFirst(), [shot(8)]), 9);
      expect(ScreenQueue.select(queue, 9.5)).toEqual({ screenCount: 2 });
      queue = consume(queue, 9.5);
      expect(ScreenQueue.select(queue, 10)).toEqual({ screens: [shot(8)], screenCount: 2 });
      expect(ScreenQueue.select(consume(queue, 10), 11)).toEqual({ screenCount: 2 });
    });

    it("共有終了は10秒以内でも添える", () => {
      const queue = receive(sentFirst(), [gone(3)]);
      expect(ScreenQueue.select(queue, 4)).toEqual({ screens: [gone(3)], screenCount: 2 });
    });

    it("共有終了が続いても10秒の起点は最後に添えた画像のまま保つ", () => {
      let queue = sentFirst();
      for (const start of [2, 3, 5]) queue = consume(receive(queue, [gone(start)]), start + 0.5);
      queue = receive(queue, [shot(8)]);
      expect(ScreenQueue.select(queue, 9)).toEqual({ screenCount: 5 });
      expect(ScreenQueue.select(consume(queue, 9), 10)).toEqual({ screens: [shot(8)], screenCount: 5 });
      const afterEnd = consume(receive(sentFirst(), [gone(5)]), 6);
      expect(ScreenQueue.select(receive(afterEnd, [shot(12)]), 13)).toEqual({ screens: [shot(12)], screenCount: 3 });
    });

    it("同じ回でも直前に添えた画像から10秒以上の候補を選んでから3件に切る", () => {
      const sparse = receive(ScreenQueue.make(), [0, 10, 25].map(shot));
      expect(ScreenQueue.select(sparse, 30)).toEqual({ screens: [0, 10, 25].map(shot), screenCount: 3 });
      const dense = receive(ScreenQueue.make(), [1, 2, 3, 15, 30, 45].map(shot));
      expect(ScreenQueue.select(dense, 50)).toEqual({ screens: [15, 30, 45].map(shot), screenCount: 6 });
    });

    it("持ち越した画像より後に共有終了が来たら画像を捨てて終了だけを添える", () => {
      const held = consume(receive(sentFirst(), [shot(4)]), 5);
      const queue = receive(held, [gone(6)]);
      expect(ScreenQueue.select(queue, 7)).toEqual({ screens: [gone(6)], screenCount: 3 });
      expect(ScreenQueue.select(consume(queue, 7), 30)).toEqual({ screenCount: 3 });
    });

    it("画像を添えないにすると既存の持ち越しも新しい画像も「なし」も選ばない", () => {
      const held = consume(receive(sentFirst(), [shot(8)]), 9);
      const disabled = ScreenQueue.skipImages(held);
      expect(ScreenQueue.select(disabled, 20)).toEqual({ screenCount: 2 });
      const next = receive(disabled, [shot(30), gone(31)]);
      expect(ScreenQueue.select(next, 40)).toEqual({ screenCount: 4 });
      expect(ScreenQueue.select(consume(next, 40), 100)).toEqual({ screenCount: 4 });
    });
  });

  for (const pausedReceive of [false, true]) {
    it(`${pausedReceive ? "停止中に受信した" : "一時停止の印を付けた"}画面は到着順によらず最大startまで上限なしで選ぶ`, () => {
      let queue = receive(ScreenQueue.make(), [0, 50, 10, 20, 30, 40].map(shot), pausedReceive);
      if (!pausedReceive) queue = ScreenQueue.markPaused(queue);
      expect(ScreenQueue.select(queue, 40)).toEqual({ screens: [0, 10, 20, 30, 40].map(shot), screenCount: 6 });
      queue = consume(queue, 40);
      queue = receive(queue, [60, 70, 80].map(shot));
      expect(ScreenQueue.select(queue, 80)).toEqual({ screens: [50, 60, 70, 80].map(shot), screenCount: 9 });
      queue = consume(queue, 80);
      queue = receive(queue, [90, 100, 110, 120].map(shot));
      expect(ScreenQueue.select(queue, 130)).toEqual({ screens: [100, 110, 120].map(shot), screenCount: 13 });
    });
  }

  it("残っている画面が無いときの一時停止では上限を外さない", () => {
    const queue = receive(ScreenQueue.markPaused(ScreenQueue.make()), [0, 10, 20, 30].map(shot));
    expect(ScreenQueue.select(queue, 40)).toEqual({ screens: [10, 20, 30].map(shot), screenCount: 4 });
  });
});
