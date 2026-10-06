// 途中結果（partial）が一定時間更新されなければ、最後の本文・区間で発言にする規則（Issue #99、調査 #97。
// 参照実装は bench/sttLatency.ts の settleVolatile、lateFinal: "discard"）。
// 時刻は呼び出し側が渡す（ミリ秒）。タイマーは持たない（中核は実行環境に依存しない。ADR 0003）。
import type { HelperPartial } from "./live.ts";
import { createRemarkGate } from "./remarkGate.ts";
import type { Remark } from "./session.ts";

export const SETTLE_QUIET_MS = 1000;

// ID は呼び出し側が push の直前に振る（捨てた確定結果が番号を消費しない）
export type SettledRemark = Omit<Remark, "id">;

const EPSILON = 1e-6;

type Utterance = { track: Remark["track"]; start: number; end: number; text: string; lastAt: number; state: "open" | "emitted" | "consumed" };

const keyOf = (track: string, start: number) => `${track}\u0000${start}`;
// 途中結果の区間は確定結果の区間と端がずれるので、発話の区間の中央が確定結果の区間に入るかで覆いを決める
const midpoint = (u: Utterance) => (u.start + u.end) / 2;
const toRemark = (u: Utterance): SettledRemark => ({ track: u.track, start: u.start, end: u.end, text: u.text });

export function createRemarkSettler(quietMs: number = SETTLE_QUIET_MS) {
  const utterances: Utterance[] = []; // 作った順。覆われて使い終わったもの（consumed）は除く
  const latest = new Map<string, Utterance>(); // 同じトラック・start で、更新を受け付けられる発話
  const gate = createRemarkGate(); // 出す直前の関所（Issue #186）。settler の寿命にわたって「直前に出した発言」を持つ

  const release = (u: Utterance) => {
    u.state = "emitted";
    if (latest.get(keyOf(u.track, u.start)) === u) latest.delete(keyOf(u.track, u.start));
    return toRemark(u);
  };

  // release 済みの発言を、出す順に 1 件ずつ関所へ通す。関所で落とした発言も release の副作用（state="emitted"）は保つ
  const passGate = (rs: SettledRemark[]): SettledRemark[] =>
    rs.flatMap((r) => {
      const passed = gate.pass(r);
      return passed === undefined ? [] : [passed];
    });

  return {
    // 途中結果。自分は、ヘルパーの重複判定（確定結果にだけ行う）を通らないので、発言にしない
    partial(p: HelperPartial, now: number): void {
      if (p.track === "自分") return;
      const key = keyOf(p.track, p.start);
      const current = latest.get(key);
      if (current && current.state === "open" && now - current.lastAt <= quietMs) {
        current.end = p.end;
        current.text = p.text;
        current.lastAt = now;
        return;
      }
      const next: Utterance = { track: p.track, start: p.start, end: p.end, text: p.text, lastAt: now, state: "open" };
      utterances.push(next);
      latest.set(key, next);
    },

    // 確定結果。返すのは、発言として出すもの
    final(r: SettledRemark, now: number): SettledRemark[] {
      if (r.track === "自分") return [r];
      const covered = utterances.filter((u) => u.track === r.track && midpoint(u) >= r.start - EPSILON && midpoint(u) <= r.end + EPSILON);
      const alreadyOut = covered.some((u) => u.state === "emitted" || (u.state === "open" && u.lastAt + quietMs < now));
      const pending = covered.filter((u) => u.state === "open");
      const out = alreadyOut ? pending.map(release) : [r];
      for (const u of covered) {
        u.state = "consumed";
        if (latest.get(keyOf(u.track, u.start)) === u) latest.delete(keyOf(u.track, u.start));
      }
      for (let i = utterances.length - 1; i >= 0; i--) if (utterances[i]!.state === "consumed") utterances.splice(i, 1);
      return passGate(out);
    },

    // T 経った発話を出す
    due(now: number): SettledRemark[] {
      return passGate(utterances.filter((u) => u.state === "open" && u.lastAt + quietMs <= now).map(release));
    },

    // 次に出す時刻。なければ undefined
    nextDue(): number | undefined {
      let min: number | undefined;
      for (const u of utterances) if (u.state === "open" && (min === undefined || u.lastAt + quietMs < min)) min = u.lastAt + quietMs;
      return min;
    },

    // 停止時。まだ出ていない発話をすべて出す
    drain(): SettledRemark[] {
      return passGate(utterances.filter((u) => u.state === "open").map(release));
    },
  };
}
