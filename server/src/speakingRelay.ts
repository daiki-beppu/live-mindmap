// いま話している文字（SpeakingFrame）をブラウザへ送る。途中結果は頻繁に届くので、トラックごとに間引く。
// タイマーを使うので Node 層に置く（中核は実行環境のタイマーを使わない。ADR 0003）。
import { speakingText, type Remark, type SpeakingFrame, type Track } from "./core/index.ts";

export const SPEAKING_INTERVAL_MS = 300; // トラックごとに、この時間に 1 回まで送る
const TRACKS: Track[] = ["相手", "自分"];

export type SpeakingRelayOptions = {
  unreflected: () => Remark[]; // 送る時点の、マップに反映前の発言
  send: (frame: SpeakingFrame) => void;
};

type TrackState = { partial: string; lastSent: number | undefined; timer: NodeJS.Timeout | undefined };

export function createSpeakingRelay({ unreflected, send }: SpeakingRelayOptions) {
  const state: Record<Track, TrackState> = {
    相手: { partial: "", lastSent: undefined, timer: undefined },
    自分: { partial: "", lastSent: undefined, timer: undefined },
  };
  let stopped = false;

  // 送る時点の最新の状態から文字を作って送る（予約した時点の値は使わない）
  function flush(track: Track) {
    const s = state[track];
    clearTimeout(s.timer);
    s.timer = undefined;
    s.lastSent = Date.now();
    send({ type: "speaking", track, text: speakingText(unreflected(), track, s.partial) });
  }

  return {
    // 途中結果。重複の印つきなら、そのトラックの途中結果は空として扱う。
    // 予約中ならそのまま待つ（予約が送るとき、最新の値を使う）。
    partial(track: Track, text: string, duplicate: boolean) {
      if (stopped) return;
      const s = state[track];
      s.partial = duplicate ? "" : text;
      if (s.timer !== undefined) return;
      const wait = s.lastSent === undefined ? 0 : s.lastSent + SPEAKING_INTERVAL_MS -Date.now();
      if (wait <= 0) flush(track);
      else s.timer = setTimeout(() => flush(track), wait);
    },
    // 確定した発言が届いた。そのトラックの途中結果は終わったので空にして、すぐ送る
    remark(track: Track) {
      if (stopped) return;
      state[track].partial = "";
      flush(track);
    },
    // 反映が終わったなど、未反映の発言が変わったとき、両トラックをすぐ送る
    flushAll() {
      if (stopped) return;
      for (const track of TRACKS) flush(track);
    },
    // 予約をすべて取り消し、両トラックの空の frame を送る。以後は何も送らない
    stop() {
      if (stopped) return;
      stopped = true;
      for (const track of TRACKS) {
        const s = state[track];
        clearTimeout(s.timer);
        s.timer = undefined;
        s.partial = "";
        send({ type: "speaking", track, text: "" });
      }
    },
  };
}
