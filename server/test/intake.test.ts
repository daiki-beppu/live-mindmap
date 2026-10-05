import { describe, expect, it } from "vitest";
import { decideIntakeRestart, MAX_CONSECUTIVE_FAILURES, RESTART_WINDOW_MS, STDERR_TAIL_LINES, tailLines } from "../src/core/intake.ts";

// 起動し直しの上限の判断（Issue #161 の決定: 「60 秒以内に終わったら続けて失敗したと数え、3 回続いたら諦める。
// 60 秒より長く動いてから終わったら数え直す。止まり方（コード／シグナル）で分岐しない」）。
// 60 秒を実際に待つと検証できないので、純粋関数の境界テストにする（実装ガイドラインの方針）。
describe("decideIntakeRestart（起動し直しの上限）", () => {
  it("定数: 60 秒以内・3 回続いたら諦める", () => {
    expect(RESTART_WINDOW_MS).toBe(60_000);
    expect(MAX_CONSECUTIVE_FAILURES).toBe(3);
  });

  it("ちょうど RESTART_WINDOW_MS で終わった（境界）のは、失敗として数える", () => {
    expect(decideIntakeRestart({ failures: 0, ranMs: RESTART_WINDOW_MS })).toEqual({ failures: 1, action: "restart" });
  });

  it("RESTART_WINDOW_MS を 1ms でも超えて動いてから終わったのは、失敗を数え直す（0 に戻る）", () => {
    expect(decideIntakeRestart({ failures: 2, ranMs: RESTART_WINDOW_MS + 1 })).toEqual({ failures: 0, action: "restart" });
  });

  it("失敗が 1 回目・2 回目は起動し直す", () => {
    expect(decideIntakeRestart({ failures: 0, ranMs: 100 })).toEqual({ failures: 1, action: "restart" });
    expect(decideIntakeRestart({ failures: 1, ranMs: 100 })).toEqual({ failures: 2, action: "restart" });
  });

  it("失敗が 3 回続くと諦める（止まった状態にする）", () => {
    expect(decideIntakeRestart({ failures: 2, ranMs: 100 })).toEqual({ failures: 3, action: "giveup" });
  });

  it("長く動いた後に失敗が続いても、数え直しているので 1 回だけでは諦めない", () => {
    const afterLongRun = decideIntakeRestart({ failures: 0, ranMs: RESTART_WINDOW_MS + 5_000 });
    expect(afterLongRun).toEqual({ failures: 0, action: "restart" });
    expect(decideIntakeRestart({ failures: afterLongRun.failures, ranMs: 100 })).toEqual({ failures: 1, action: "restart" });
  });

  it("終了がコードでもシグナルでも、同じ ranMs なら同じ判断になる（止まり方で分岐しない）", () => {
    const byCode = decideIntakeRestart({ failures: 1, ranMs: 500 });
    const bySignal = decideIntakeRestart({ failures: 1, ranMs: 500 });
    expect(byCode).toEqual(bySignal);
  });
});

// 「ヘルパーが止まった」ログ・標準エラーに載せる stderr の末尾数行（order.md:76 が「末尾数行」と指定。行数は開放）
describe("tailLines（標準エラーの末尾）", () => {
  it("定数として末尾の行数が決まっている", () => {
    expect(STDERR_TAIL_LINES).toBeGreaterThan(0);
  });

  it("行数が STDERR_TAIL_LINES 以下なら、全部をそのまま返す", () => {
    const text = Array.from({ length: STDERR_TAIL_LINES - 1 }, (_, i) => `line${i}`).join("\n");
    expect(tailLines(text, STDERR_TAIL_LINES)).toEqual(text.split("\n"));
  });

  it("行数が超えていれば、末尾の n 行だけを順序どおりに返す", () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line${i}`);
    expect(tailLines(lines.join("\n"), 3)).toEqual(["line7", "line8", "line9"]);
  });

  it("末尾の改行による空行は数に入れない", () => {
    const lines = Array.from({ length: 5 }, (_, i) => `line${i}`);
    expect(tailLines(lines.join("\n") + "\n", 3)).toEqual(["line2", "line3", "line4"]);
  });

  it("空文字は空の配列になる", () => {
    expect(tailLines("", 5)).toEqual([]);
  });
});
