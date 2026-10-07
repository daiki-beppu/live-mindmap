import { describe, expect, it } from "vitest";
import { initialPlayback, PLAYBACK_RATES, playbackReducer, type PlaybackEvent, type PlaybackState } from "../src/reviewPlayback.ts";

// 見返しの再生の状態（純粋な reducer）。時刻の元（rAF や音声の currentTime）は知らず、経過の秒だけを受け取る。
const ctx = { duration: 100, reflectionTimes: [10, 40, 70], rates: [10, 30, 60, 120] };
const run = (state: PlaybackState, ...events: PlaybackEvent[]) => events.reduce((s, e) => playbackReducer(s, e, ctx), state);
const start = initialPlayback(ctx.duration);

describe("初めの状態", () => {
  it("会議の長さの時点で止まっていて、速さは 30 倍", () => {
    expect(start).toEqual({ time: 100, playing: false, rate: 30 });
  });
});

describe("▶（toggle）と時間の経過（elapsed）", () => {
  it("▶ で進める状態になり、経過した秒の 30 倍だけ時刻が進む。もう一度押すと止まり、その後の経過では進まない", () => {
    const playing = run(run(start, { type: "seek", time: 0 }), { type: "toggle" });
    expect(playing.playing).toBe(true);
    expect(run(playing, { type: "elapsed", seconds: 0.5 }).time).toBe(15);
    const paused = run(playing, { type: "elapsed", seconds: 1 }, { type: "toggle" });
    expect(paused).toMatchObject({ time: 30, playing: false });
    expect(run(paused, { type: "elapsed", seconds: 1 }).time).toBe(30);
  });

  it("止まっている間の経過では時刻が動かない", () => {
    const s = run(start, { type: "seek", time: 20 });
    expect(run(s, { type: "elapsed", seconds: 1 })).toEqual(s);
  });

  it("会議の長さに着いたら、そこで止まる（超えない）", () => {
    const s = run(start, { type: "seek", time: 90 }, { type: "toggle" }, { type: "elapsed", seconds: 1 });
    expect(s).toMatchObject({ time: 100, playing: false });
  });

  it("最後まで行った（ended）で、会議の長さで止まる", () => {
    const s = run(start, { type: "seek", time: 50 }, { type: "toggle" }, { type: "ended" });
    expect(s).toMatchObject({ time: 100, playing: false });
  });

  it("最後の時点で ▶ を押すと、0 秒に戻ってから進める", () => {
    const s = run(start, { type: "toggle" });
    expect(s).toMatchObject({ time: 0, playing: true });
    expect(run(s, { type: "elapsed", seconds: 1 }).time).toBe(30);
  });

  it("途中の時点で止まっていて ▶ を押したときは、その時刻から進める", () => {
    expect(run(start, { type: "seek", time: 33 }, { type: "toggle" })).toMatchObject({ time: 33, playing: true });
  });
});

describe("シーク（seek）", () => {
  it("その時刻へ移り、止まっていれば止まったまま", () => {
    expect(run(start, { type: "seek", time: 25 })).toMatchObject({ time: 25, playing: false });
  });

  it("範囲の外は 0〜会議の長さに収める", () => {
    expect(run(start, { type: "seek", time: -5 }).time).toBe(0);
    expect(run(start, { type: "seek", time: 500 }).time).toBe(100);
  });

  it("進めている最中にシークしても止めず、移った時刻から進め続ける", () => {
    const s = run(start, { type: "seek", time: 0 }, { type: "toggle" }, { type: "elapsed", seconds: 1 }, { type: "seek", time: 60 });
    expect(s).toMatchObject({ time: 60, playing: true });
    expect(run(s, { type: "elapsed", seconds: 1 }).time).toBe(90);
  });
});

describe("反映 1 つ戻る・進む（prev / next）", () => {
  it("戻るは t より小さい反映の時刻の最大へ、進むは t より大きい最小へ移る", () => {
    const at = (t: number) => run(start, { type: "seek", time: t });
    expect(run(at(50), { type: "prev" }).time).toBe(40);
    expect(run(at(50), { type: "next" }).time).toBe(70);
    expect(run(at(40), { type: "prev" }).time).toBe(10); // ちょうどの時刻は「小さい」に入らない
    expect(run(at(40), { type: "next" }).time).toBe(70);
  });

  it("前後に反映の時刻が無ければ、動かない（状態も変わらない）", () => {
    const first = run(start, { type: "seek", time: 10 });
    expect(run(first, { type: "prev" })).toEqual(first);
    expect(run(start, { type: "next" })).toEqual(start); // 100 より大きい反映は無い
    const early = run(start, { type: "seek", time: 5 });
    expect(run(early, { type: "prev" })).toEqual(early);
  });

  it("反映の時刻が 1 つも無ければ、動かない", () => {
    const empty = { duration: 100, reflectionTimes: [] as number[], rates: [10, 30, 60, 120] };
    const s = playbackReducer(start, { type: "prev" }, empty);
    expect(s).toEqual(start);
    expect(playbackReducer(start, { type: "next" }, empty)).toEqual(start);
  });

  it("進めている最中に戻る・進むをしても止めず、移った時刻から進め続ける", () => {
    const s = run(start, { type: "seek", time: 50 }, { type: "toggle" });
    const back = run(s, { type: "prev" });
    expect(back).toMatchObject({ time: 40, playing: true });
    const fwd = run(back, { type: "next" });
    expect(fwd).toMatchObject({ time: 70, playing: true });
    expect(run(fwd, { type: "elapsed", seconds: 1 }).time).toBe(100);
  });
});

describe("入力の状態を書き換えない", () => {
  it("reducer は新しい状態を返し、渡した状態を変えない", () => {
    const before = { ...start };
    playbackReducer(start, { type: "toggle" }, ctx);
    expect(start).toEqual(before);
  });
});

describe("速さの並びと既定", () => {
  it("音声なしの並びは 10・30・60・120 倍で、既定は 30 倍。既定は引数で変えられる", () => {
    expect([...PLAYBACK_RATES]).toEqual([10, 30, 60, 120]);
    expect(initialPlayback(100).rate).toBe(30);
    expect(initialPlayback(100, 1)).toEqual({ time: 100, playing: false, rate: 1 });
  });
});

describe("速さを選ぶ（setRate）", () => {
  it("並びの中の値を選ぶと速さだけが変わり、時刻と進めているかどうかは変わらない", () => {
    const stopped = run(start, { type: "seek", time: 25 });
    expect(run(stopped, { type: "setRate", rate: 60 })).toEqual({ time: 25, playing: false, rate: 60 });
    const playing = run(start, { type: "seek", time: 25 }, { type: "toggle" });
    expect(run(playing, { type: "setRate", rate: 10 })).toEqual({ time: 25, playing: true, rate: 10 });
  });

  it("並びの外の値は選べず、状態は変わらない（並びの中の値なら変わる）", () => {
    const s = run(start, { type: "seek", time: 25 });
    expect(run(s, { type: "setRate", rate: 120 }).rate).toBe(120);
    expect(run(s, { type: "setRate", rate: 45 })).toEqual(s);
  });
});

describe("速さの 1 段ずつの上げ下げ（slower / faster）", () => {
  it("1 段上げると次の値、1 段下げると前の値になる", () => {
    expect(run(start, { type: "faster" }).rate).toBe(60);
    expect(run(start, { type: "faster" }, { type: "faster" }).rate).toBe(120);
    expect(run(start, { type: "slower" }).rate).toBe(10);
  });

  it("端では止まり、回り込まない（状態も変わらない）", () => {
    const top = run(start, { type: "faster" }, { type: "faster" });
    expect(top.rate).toBe(120);
    expect(run(top, { type: "faster" })).toEqual(top);
    const bottom = run(start, { type: "slower" });
    expect(bottom.rate).toBe(10);
    expect(run(bottom, { type: "slower" })).toEqual(bottom);
  });

  it("上げ下げでも時刻と進めているかどうかは変わらない", () => {
    const s = run(start, { type: "seek", time: 33 }, { type: "toggle" });
    expect(run(s, { type: "faster" })).toEqual({ time: 33, playing: true, rate: 60 });
    expect(run(s, { type: "slower" })).toEqual({ time: 33, playing: true, rate: 10 });
  });
});

describe("選んだ速さでの経過（elapsed）", () => {
  it("同じ状態のまま速さを変えると、その後の経過の進み方が変わる", () => {
    const playing = run(start, { type: "seek", time: 0 }, { type: "toggle" });
    expect(run(playing, { type: "elapsed", seconds: 1 }).time).toBe(30);
    expect(run(playing, { type: "setRate", rate: 60 }, { type: "elapsed", seconds: 1 }).time).toBe(60);
    expect(run(playing, { type: "setRate", rate: 10 }, { type: "elapsed", seconds: 1 }).time).toBe(10);
    expect(run(playing, { type: "faster" }, { type: "elapsed", seconds: 0.5 }).time).toBe(30);
  });

  it("進めている最中に速さを変えると、それまでの時刻から新しい速さで進む", () => {
    const s = run(start, { type: "seek", time: 0 }, { type: "toggle" }, { type: "elapsed", seconds: 1 }, { type: "setRate", rate: 10 });
    expect(s.time).toBe(30);
    expect(run(s, { type: "elapsed", seconds: 1 }).time).toBe(40);
  });
});

describe("版ごとに渡す速さの並び", () => {
  it("別の並びの context では、その並びで上げ下げと経過が働く", () => {
    const audio = { duration: 100, reflectionTimes: [] as number[], rates: [0.5, 1, 1.5, 2] };
    const step = (s: PlaybackState, ...events: PlaybackEvent[]) => events.reduce((x, e) => playbackReducer(x, e, audio), s);
    const s = step(initialPlayback(100, 1), { type: "seek", time: 0 }, { type: "toggle" }, { type: "faster" });
    expect(s.rate).toBe(1.5);
    expect(step(s, { type: "elapsed", seconds: 2 }).time).toBe(3);
    expect(step(s, { type: "setRate", rate: 30 })).toEqual(s); // 音声なしの並びの値は、この並びに無い
  });
});

// 音声つきの版。時刻の元は <audio> の currentTime だけで、通知（audioTime）が画面の時刻を決める。速さは 1 倍だけ（並び [1]）
describe("音声の時刻の通知（audioTime）", () => {
  const audioCtx = { duration: 100, reflectionTimes: [10, 40, 70], rates: [1] };
  const audioStart = initialPlayback(audioCtx.duration, 1);
  const step = (state: PlaybackState, ...events: PlaybackEvent[]) => events.reduce((s, e) => playbackReducer(s, e, audioCtx), state);

  it("進めている間は、通知された currentTime がそのまま画面の時刻になる（前の時刻や速さからは計算しない）", () => {
    const playing = step(audioStart, { type: "seek", time: 5 }, { type: "toggle" });
    expect(step(playing, { type: "audioTime", time: 5.25 })).toMatchObject({ time: 5.25, playing: true });
    // 前の通知から飛んだ値でも、その値になる（足し算ではない）
    expect(step(playing, { type: "audioTime", time: 5.25 }, { type: "audioTime", time: 42 }).time).toBe(42);
    expect(step(playing, { type: "audioTime", time: 3 }).time).toBe(3);
  });

  it("止まっている間の通知では、時刻も状態も変わらない", () => {
    const paused = step(audioStart, { type: "seek", time: 20 });
    expect(step(paused, { type: "audioTime", time: 50 })).toEqual(paused);
    // 止めた直後に届いた通知で、止めた時刻から戻らない
    const stopped = step(paused, { type: "toggle" }, { type: "audioTime", time: 21 }, { type: "toggle" });
    expect(step(stopped, { type: "audioTime", time: 20.5 })).toEqual(stopped);
  });

  it("会議の長さ以上の通知（録音が会議より長いとき）では、会議の長さで止まる。最後の時点を超えない", () => {
    const playing = step(audioStart, { type: "seek", time: 90 }, { type: "toggle" });
    expect(step(playing, { type: "audioTime", time: 100 })).toMatchObject({ time: 100, playing: false });
    expect(step(playing, { type: "audioTime", time: 130 })).toMatchObject({ time: 100, playing: false });
    expect(step(playing, { type: "audioTime", time: 99.9 })).toMatchObject({ time: 99.9, playing: true });
  });

  it("負の通知は 0 に収める", () => {
    const playing = step(audioStart, { type: "seek", time: 10 }, { type: "toggle" });
    expect(step(playing, { type: "audioTime", time: -1 }).time).toBe(0);
  });

  it("速さは使わない。同じ通知なら、どの速さの状態でも同じ時刻になる", () => {
    const playing = step(audioStart, { type: "seek", time: 0 }, { type: "toggle" });
    expect(step({ ...playing, rate: 30 }, { type: "audioTime", time: 2 }).time).toBe(2);
    expect(step(playing, { type: "audioTime", time: 2 }).time).toBe(2);
  });

  it("同じ状態の上で、▶ → 通知 → シーク → 通知 → 反映を進める → 通知 → 止める → 通知、と続けても、時刻は常に直近の操作か通知に従う", () => {
    let state = step(audioStart, { type: "seek", time: 0 });
    state = step(state, { type: "toggle" });
    expect(state).toMatchObject({ time: 0, playing: true });
    state = step(state, { type: "audioTime", time: 3 });
    expect(state.time).toBe(3);
    state = step(state, { type: "seek", time: 60 }); // シークは行き先の時刻になり、進めたまま
    expect(state).toMatchObject({ time: 60, playing: true });
    state = step(state, { type: "audioTime", time: 60.5 }); // 音声が新しい時刻から鳴り、通知が続く
    expect(state.time).toBe(60.5);
    state = step(state, { type: "next" }); // 反映 1 つ進む: 今の通知の時刻の次の反映（70）が行き先
    expect(state).toMatchObject({ time: 70, playing: true });
    state = step(state, { type: "audioTime", time: 70.25 });
    expect(state.time).toBe(70.25);
    state = step(state, { type: "prev" }); // 戻る: 70.25 より小さい反映の最大（70）
    expect(state.time).toBe(70);
    state = step(state, { type: "toggle" }, { type: "audioTime", time: 71 });
    expect(state).toMatchObject({ time: 70, playing: false });
  });

  it("最後の時点で ▶ を押すと 0 秒に戻ってから進め、その後の通知で進む。通知が最後に届いたら止まり、もう一度 ▶ で 0 から", () => {
    let state = step(audioStart, { type: "toggle" });
    expect(state).toMatchObject({ time: 0, playing: true });
    state = step(state, { type: "audioTime", time: 0.5 });
    expect(state.time).toBe(0.5);
    state = step(state, { type: "audioTime", time: 100 });
    expect(state).toMatchObject({ time: 100, playing: false });
    expect(step(state, { type: "toggle" })).toMatchObject({ time: 0, playing: true });
  });

  it("音声つきで進めているとき、最後まで行った（ended）で会議の長さに止まる", () => {
    const state = step(audioStart, { type: "seek", time: 50 }, { type: "toggle" }, { type: "audioTime", time: 99 }, { type: "ended" });
    expect(state).toMatchObject({ time: 100, playing: false });
  });

  it("止まっている間のシーク・反映の移動は、通知を待たずに行き先の時刻になる（音声はその時刻へ書き込まれる）", () => {
    const paused = step(audioStart, { type: "seek", time: 55 });
    expect(paused).toMatchObject({ time: 55, playing: false });
    expect(step(paused, { type: "prev" }).time).toBe(40);
    expect(step(paused, { type: "next" }).time).toBe(70);
  });

  it("入力の状態を書き換えない", () => {
    const playing = step(audioStart, { type: "seek", time: 5 }, { type: "toggle" });
    const before = { ...playing };
    playbackReducer(playing, { type: "audioTime", time: 9 }, audioCtx);
    expect(playing).toEqual(before);
  });
});

describe("音声つきの速さの並び [1]（0.5〜2 倍は後の段）", () => {
  const audioCtx = { duration: 100, reflectionTimes: [] as number[], rates: [1] };
  const step = (state: PlaybackState, ...events: PlaybackEvent[]) => events.reduce((s, e) => playbackReducer(s, e, audioCtx), state);

  it("setRate・faster・slower では状態が変わらず、速さは 1 倍のまま", () => {
    const playing = step(initialPlayback(100, 1), { type: "seek", time: 20 }, { type: "toggle" });
    expect(playing.rate).toBe(1);
    expect(step(playing, { type: "faster" })).toEqual(playing);
    expect(step(playing, { type: "slower" })).toEqual(playing);
    expect(step(playing, { type: "setRate", rate: 2 })).toEqual(playing);
    expect(step(playing, { type: "setRate", rate: 30 })).toEqual(playing);
  });
});
