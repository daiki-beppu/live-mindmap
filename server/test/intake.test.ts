import { describe, expect, it } from "vitest";
import {
  CONFIGURATION_CHANGE_WINDOW_MS,
  decideIntakeRestart,
  formatIntakeStatus,
  HELPER_EXIT_CONFIGURATION_CHANGED,
  MAX_CONFIGURATION_CHANGES,
  MAX_CONSECUTIVE_FAILURES,
  RESTART_WINDOW_MS,
  STDERR_TAIL_LINES,
  tailLines,
} from "../src/core/intake.ts";

// 起動し直しの上限の判断（Issue #161 の決定: 「60 秒以内に終わったら続けて失敗したと数え、3 回続いたら諦める。
// 60 秒より長く動いてから終わったら数え直す」）。Issue（構成の変化）で、ヘルパーの終了コード 75（シグナルなし）の終了は
// 失敗に数えず、別の歯止め（60 秒に 10 回を超えたら諦める）で数える。それ以外の止まり方（コード・シグナル）は今までどおり。
// 60 秒を実際に待つと検証できないので、純粋関数の境界テストにする（実装ガイドラインの方針）。
const NOW = 1_000_000;
const CRASH = { code: 1, signal: null } as const;
const CONFIG_CHANGE = { code: HELPER_EXIT_CONFIGURATION_CHANGED, signal: null } as const;

describe("decideIntakeRestart（起動し直しの上限）", () => {
  it("定数: 60 秒以内・3 回続いたら諦める", () => {
    expect(RESTART_WINDOW_MS).toBe(60_000);
    expect(MAX_CONSECUTIVE_FAILURES).toBe(3);
  });

  it("定数: 構成の変化は終了コード 75、60 秒に 10 回を超えたら諦める", () => {
    expect(HELPER_EXIT_CONFIGURATION_CHANGED).toBe(75);
    expect(CONFIGURATION_CHANGE_WINDOW_MS).toBe(60_000);
    expect(MAX_CONFIGURATION_CHANGES).toBe(10);
  });

  it("ちょうど RESTART_WINDOW_MS で終わった（境界）のは、失敗として数える", () => {
    expect(decideIntakeRestart({ failures: 0, configurationChanges: [], ranMs: RESTART_WINDOW_MS, exit: CRASH, now: NOW })).toEqual({
      failures: 1,
      configurationChanges: [],
      action: "restart",
    });
  });

  it("RESTART_WINDOW_MS を 1ms でも超えて動いてから終わったのは、失敗を数え直す（0 に戻る）", () => {
    expect(decideIntakeRestart({ failures: 2, configurationChanges: [], ranMs: RESTART_WINDOW_MS + 1, exit: CRASH, now: NOW })).toEqual({
      failures: 0,
      configurationChanges: [],
      action: "restart",
    });
  });

  it("失敗が 1 回目・2 回目は起動し直す", () => {
    expect(decideIntakeRestart({ failures: 0, configurationChanges: [], ranMs: 100, exit: CRASH, now: NOW })).toEqual({
      failures: 1,
      configurationChanges: [],
      action: "restart",
    });
    expect(decideIntakeRestart({ failures: 1, configurationChanges: [], ranMs: 100, exit: CRASH, now: NOW })).toEqual({
      failures: 2,
      configurationChanges: [],
      action: "restart",
    });
  });

  it("失敗が 3 回続くと諦める（止まった状態にする。理由は failures）", () => {
    expect(decideIntakeRestart({ failures: 2, configurationChanges: [], ranMs: 100, exit: CRASH, now: NOW })).toEqual({
      failures: 3,
      configurationChanges: [],
      action: "giveup",
      reason: "failures",
    });
  });

  it("長く動いた後に失敗が続いても、数え直しているので 1 回だけでは諦めない", () => {
    const afterLongRun = decideIntakeRestart({ failures: 0, configurationChanges: [], ranMs: RESTART_WINDOW_MS + 5_000, exit: CRASH, now: NOW });
    expect(afterLongRun).toEqual({ failures: 0, configurationChanges: [], action: "restart" });
    expect(
      decideIntakeRestart({ failures: afterLongRun.failures, configurationChanges: afterLongRun.configurationChanges, ranMs: 100, exit: CRASH, now: NOW }),
    ).toEqual({ failures: 1, configurationChanges: [], action: "restart" });
  });

  it("コード 1 とシグナルの終了は、同じ ranMs なら同じ判断になる（75 以外の止まり方は区別しない）", () => {
    const byCode = decideIntakeRestart({ failures: 1, configurationChanges: [], ranMs: 500, exit: CRASH, now: NOW });
    const bySignal = decideIntakeRestart({ failures: 1, configurationChanges: [], ranMs: 500, exit: { code: null, signal: "SIGKILL" }, now: NOW });
    expect(byCode).toEqual(bySignal);
  });
});

describe("decideIntakeRestart（構成の変化による終了: 終了コード 75）", () => {
  it("failures を増やさずに起動し直す（failures: 2 のまま restart）。終わった時刻を記録する", () => {
    expect(decideIntakeRestart({ failures: 2, configurationChanges: [], ranMs: 500, exit: CONFIG_CHANGE, now: NOW })).toEqual({
      failures: 2,
      configurationChanges: [NOW],
      action: "restart",
    });
  });

  it("failures が 2 のとき 75 が来ても諦めない（3 回目の失敗に数えない）", () => {
    const decision = decideIntakeRestart({ failures: MAX_CONSECUTIVE_FAILURES - 1, configurationChanges: [], ranMs: 100, exit: CONFIG_CHANGE, now: NOW });
    expect(decision.action).toBe("restart");
    expect(decision.failures).toBe(MAX_CONSECUTIVE_FAILURES - 1);
  });

  it("RESTART_WINDOW_MS を超えて動いてから終わったときは、今までどおり failures を 0 に戻す", () => {
    expect(decideIntakeRestart({ failures: 2, configurationChanges: [], ranMs: RESTART_WINDOW_MS + 1, exit: CONFIG_CHANGE, now: NOW })).toEqual({
      failures: 0,
      configurationChanges: [NOW],
      action: "restart",
    });
  });

  it("ちょうど RESTART_WINDOW_MS で終わったときは failures を 0 に戻さない（境界は失敗側と同じ向き）", () => {
    expect(decideIntakeRestart({ failures: 2, configurationChanges: [], ranMs: RESTART_WINDOW_MS, exit: CONFIG_CHANGE, now: NOW }).failures).toBe(2);
  });

  it("窓の中に 9 件ある状態での 10 回目は起動し直す", () => {
    const previous = Array.from({ length: MAX_CONFIGURATION_CHANGES - 1 }, (_, i) => NOW - 1_000 * (i + 1));
    const decision = decideIntakeRestart({ failures: 0, configurationChanges: previous, ranMs: 500, exit: CONFIG_CHANGE, now: NOW });
    expect(decision.action).toBe("restart");
    expect(decision.configurationChanges).toHaveLength(MAX_CONFIGURATION_CHANGES);
  });

  it("窓の中に 10 件ある状態での 11 回目は諦める（理由は configuration-changes）。failures は増やさない", () => {
    const previous = Array.from({ length: MAX_CONFIGURATION_CHANGES }, (_, i) => NOW - 1_000 * (i + 1));
    const decision = decideIntakeRestart({ failures: 1, configurationChanges: previous, ranMs: 500, exit: CONFIG_CHANGE, now: NOW });
    expect(decision).toEqual({
      failures: 1,
      configurationChanges: [...previous, NOW],
      action: "giveup",
      reason: "configuration-changes",
    });
  });

  it("窓の境界: ちょうど 60 000 ms 前の記録は数え、60 001 ms 前の記録は除かれる", () => {
    const atBoundary = Array.from({ length: MAX_CONFIGURATION_CHANGES }, () => NOW - CONFIGURATION_CHANGE_WINDOW_MS);
    expect(decideIntakeRestart({ failures: 0, configurationChanges: atBoundary, ranMs: 500, exit: CONFIG_CHANGE, now: NOW })).toMatchObject({
      action: "giveup",
      reason: "configuration-changes",
    });

    const outside = Array.from({ length: MAX_CONFIGURATION_CHANGES }, () => NOW - CONFIGURATION_CHANGE_WINDOW_MS - 1);
    expect(decideIntakeRestart({ failures: 0, configurationChanges: outside, ranMs: 500, exit: CONFIG_CHANGE, now: NOW })).toEqual({
      failures: 0,
      configurationChanges: [NOW],
      action: "restart",
    });
  });

  it("窓が進めば数え直す: 古い記録が窓の外に出た分だけ除かれ、新しい記録は残る", () => {
    const old = Array.from({ length: 8 }, (_, i) => NOW - 70_000 - i);
    const recent = [NOW - 5_000, NOW - 1_000];
    const decision = decideIntakeRestart({ failures: 0, configurationChanges: [...old, ...recent], ranMs: 500, exit: CONFIG_CHANGE, now: NOW });
    expect(decision).toEqual({ failures: 0, configurationChanges: [...recent, NOW], action: "restart" });
  });

  it("入力の配列を書き換えない", () => {
    const input = [NOW - 70_000, NOW - 1_000];
    decideIntakeRestart({ failures: 0, configurationChanges: input, ranMs: 500, exit: CONFIG_CHANGE, now: NOW });
    expect(input).toEqual([NOW - 70_000, NOW - 1_000]);
  });
});

describe("decideIntakeRestart（75 以外の終了は構成の変化に数えない）", () => {
  it("コード 1 の終了は configurationChanges に足さない（窓の外の記録だけが除かれる）", () => {
    const decision = decideIntakeRestart({
      failures: 0,
      configurationChanges: [NOW - CONFIGURATION_CHANGE_WINDOW_MS - 1, NOW - 1_000],
      ranMs: 100,
      exit: CRASH,
      now: NOW,
    });
    expect(decision).toEqual({ failures: 1, configurationChanges: [NOW - 1_000], action: "restart" });
  });

  it("構成の変化が溜まっていても、コード 1 は今までどおり 3 回目で諦める（理由は failures）", () => {
    const previous = Array.from({ length: MAX_CONFIGURATION_CHANGES }, (_, i) => NOW - 1_000 * (i + 1));
    expect(decideIntakeRestart({ failures: 2, configurationChanges: previous, ranMs: 100, exit: CRASH, now: NOW })).toEqual({
      failures: 3,
      configurationChanges: previous,
      action: "giveup",
      reason: "failures",
    });
  });

  it("構成の変化の記録が 10 件ちょうどあるとき、コード 1 の 1 回目では諦めない（歯止めの理由で止めない）", () => {
    const previous = Array.from({ length: MAX_CONFIGURATION_CHANGES }, (_, i) => NOW - 1_000 * (i + 1));
    expect(decideIntakeRestart({ failures: 0, configurationChanges: previous, ranMs: 100, exit: CRASH, now: NOW }).action).toBe("restart");
  });

  it("コード 75 でもシグナルが入っているものは、構成の変化に数えず失敗に数える", () => {
    expect(decideIntakeRestart({ failures: 0, configurationChanges: [], ranMs: 100, exit: { code: 75, signal: "SIGKILL" }, now: NOW })).toEqual({
      failures: 1,
      configurationChanges: [],
      action: "restart",
    });
  });

  it("コードが null（シグナル終了）は失敗に数える", () => {
    expect(decideIntakeRestart({ failures: 2, configurationChanges: [], ranMs: 100, exit: { code: null, signal: "SIGSEGV" }, now: NOW })).toMatchObject({
      failures: 3,
      action: "giveup",
      reason: "failures",
    });
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

// cli status の標準出力（段 3 以前は server.heavy.test.ts が CLI 経由で固定していた文面。値の組み立ては Sessions.status が担い、文面はここで固定する）
describe("formatIntakeStatus（cli status の標準出力）", () => {
  it("セッションなしは状態の一言だけ", () => {
    expect(formatIntakeStatus({ status: "none" })).toBe("セッションなし\n");
  });

  it("動いているときは、状態・セッションのフォルダ・起動し直した回数を出し、途切れの時刻は出さない", () => {
    const out = formatIntakeStatus({ status: "running", dir: "/tmp/s", restarts: 0 });
    expect(out).toContain("動いている");
    expect(out).toContain("/tmp/s");
    expect(out).toContain("起動し直した回数: 0");
    expect(out).not.toContain("最後の途切れの時刻");
  });

  it("止まったときは、最後の途切れの時刻を値として出す", () => {
    const out = formatIntakeStatus({ status: "stopped", dir: "/tmp/s", restarts: 0, lastInterruptedAt: "2026-01-02T03:04:05.678Z" });
    expect(out).toContain("止まった");
    expect(out).toContain("起動し直した回数: 0");
    expect(out).toContain("最後の途切れの時刻: 2026-01-02T03:04:05.678Z");
  });
});
