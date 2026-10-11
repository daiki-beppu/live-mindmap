import { Effect, Fiber, Option, Stream } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PauseAudio, PlayAudio, REVIEW_AUDIO_ID, SeekAudio, WriteAudioSettings } from "../src/app/review/command.ts";
import { makeContext } from "../src/app/review/context.ts";
import { init } from "../src/app/review/main.ts";
import { Message } from "../src/app/review/message.ts";
import { ObserveAudio } from "../src/app/review/mount.ts";
import { makeSubscriptions } from "../src/app/review/subscription.ts";
import { initialPlayback } from "../src/reviewPlayback.ts";

// DOM が無い unit 環境で、<audio> に書く Command・Mount の中身・Subscription の開く条件を偽の要素で確かめる（Issue #824）。
// 実ブラウザの <audio> そのものは未確認

class FakeAudio extends EventTarget {
  paused = true;
  currentTime = 0;
  muted = false;
  volume = 1;
  playbackRate = 5;
  defaultPlaybackRate = 5;
  preservesPitch = false;
  playImpl: () => Promise<void> = () => Promise.resolve();
  pauseCalls = 0;
  play() { return this.playImpl(); }
  pause() { this.pauseCalls += 1; }
}

let audio: FakeAudio | null;
beforeEach(() => {
  audio = new FakeAudio();
  vi.stubGlobal("document", { getElementById: (id: string) => (id === REVIEW_AUDIO_ID ? audio : null) });
});
afterEach(() => vi.unstubAllGlobals());

const run = <A>(command: { effect: Effect.Effect<A, never, never> }) => Effect.runPromise(command.effect);

describe("Command が <audio> に書く中身", () => {
  it("PlayAudio は play() を呼び、成功なら SucceededPlayAudio", async () => {
    const play = vi.fn(() => Promise.resolve());
    audio!.playImpl = play;
    expect(await run(PlayAudio())).toEqual(Message.SucceededPlayAudio());
    expect(play).toHaveBeenCalledOnce();
  });
  it("PlayAudio の AbortError は isAborted:true、それ以外の失敗は false", async () => {
    audio!.playImpl = () => Promise.reject(new DOMException("interrupted", "AbortError"));
    expect(await run(PlayAudio())).toEqual(Message.FailedPlayAudio({ isAborted: true }));
    audio!.playImpl = () => Promise.reject(new DOMException("blocked", "NotAllowedError"));
    expect(await run(PlayAudio())).toEqual(Message.FailedPlayAudio({ isAborted: false }));
  });
  it("PlayAudio は <audio> が無いとき isAborted:false の失敗を返す", async () => {
    audio = null;
    expect(await run(PlayAudio())).toEqual(Message.FailedPlayAudio({ isAborted: false }));
  });
  it("PauseAudio は pause() を呼ぶ。<audio> が無くても完了する", async () => {
    expect(await run(PauseAudio())).toEqual(Message.CompletedPauseAudio());
    expect(audio!.pauseCalls).toBe(1);
    audio = null;
    expect(await run(PauseAudio())).toEqual(Message.CompletedPauseAudio());
  });
  it("SeekAudio は currentTime に書く。<audio> が無くても完了する", async () => {
    expect(await run(SeekAudio({ time: 12.5 }))).toEqual(Message.CompletedSeekAudio());
    expect(audio!.currentTime).toBe(12.5);
    audio = null;
    expect(await run(SeekAudio({ time: 1 }))).toEqual(Message.CompletedSeekAudio());
  });
  it("WriteAudioSettings は preservesPitch・defaultPlaybackRate・playbackRate・muted・volume を書く", async () => {
    expect(await run(WriteAudioSettings({ rate: 1.5, muted: true, volume: 0.25 }))).toEqual(Message.CompletedWriteAudioSettings());
    expect(audio).toMatchObject({ preservesPitch: true, defaultPlaybackRate: 1.5, playbackRate: 1.5, muted: true, volume: 0.25 });
  });
});

describe("ObserveAudio（Mount）の中身", () => {
  const frames: Array<() => void> = [];
  const cancelled: number[] = [];
  beforeEach(() => {
    frames.length = 0;
    cancelled.length = 0;
    vi.stubGlobal("requestAnimationFrame", (cb: () => void) => (frames.push(cb), frames.length));
    vi.stubGlobal("cancelAnimationFrame", (id: number) => { cancelled.push(id); });
  });

  const flush = () => new Promise((r) => setTimeout(r, 0));

  // Stream を購読して Message を集める。close は購読を中断して release を走らせる
  const observe = async () => {
    const got: Array<{ _tag: string; time?: number }> = [];
    const stream = (ObserveAudio() as unknown as { f: (element: unknown, viewStateChanges: unknown) => Stream.Stream<{ _tag: string; time?: number }> }).f(audio, Stream.empty);
    const fiber = Effect.runFork(Stream.runForEach(stream, (m) => Effect.sync(() => { got.push(m); })));
    await new Promise((r) => setTimeout(r, 0));
    return { got, close: () => Effect.runPromise(Fiber.interrupt(fiber)) };
  };

  it("timeupdate で currentTime を UpdatedAudioTime にする", async () => {
    const { got } = await observe();
    audio!.currentTime = 7;
    audio!.dispatchEvent(new Event("timeupdate"));
    await flush();
    expect(got).toEqual([Message.UpdatedAudioTime({ time: 7 })]);
  });
  it("play で毎フレームの読み取りを始め、pause で止める", async () => {
    const { got } = await observe();
    expect(frames).toHaveLength(0);
    audio!.dispatchEvent(new Event("play"));
    expect(frames).toHaveLength(1);
    audio!.currentTime = 3;
    frames[0]!();
    await flush();
    expect(got).toEqual([Message.UpdatedAudioTime({ time: 3 })]);
    expect(frames).toHaveLength(2);
    audio!.dispatchEvent(new Event("pause"));
    expect(cancelled).toEqual([2]);
  });
  it("ended は読み取りを止め、EndedAudio を出す", async () => {
    const { got } = await observe();
    audio!.dispatchEvent(new Event("play"));
    audio!.dispatchEvent(new Event("ended"));
    expect(cancelled).toEqual([1]);
    await flush();
    expect(got).toEqual([Message.EndedAudio()]);
  });
  it("すでに鳴っている要素なら、最初から毎フレームの読み取りを始める", async () => {
    audio!.paused = false;
    await observe();
    expect(frames).toHaveLength(1);
  });
  it("release でリスナーと rAF を外す", async () => {
    const { got, close } = await observe();
    audio!.dispatchEvent(new Event("play"));
    await close();
    expect(cancelled).toEqual([1]);
    audio!.dispatchEvent(new Event("timeupdate"));
    audio!.dispatchEvent(new Event("ended"));
    await flush();
    expect(got).toEqual([]);
  });
});

describe("makeSubscriptions の時計は再生中かつ録音なしのときだけ開く", () => {
  const events = [{ at: "a", type: "start", title: "定例" }];
  const model = (context: ReturnType<typeof makeContext>, playing: boolean) => {
    const start = init(context);
    return { ...start, playback: { ...initialPlayback(30), playing } };
  };
  const isActive = (context: ReturnType<typeof makeContext>, playing: boolean) => {
    const plain = makeContext(events);
    return makeSubscriptions(context).frame.modelToDependencies(model(plain, playing)).isActive;
  };
  it("録音なしで再生中なら開く", () => expect(isActive(makeContext(events), true)).toBe(true));
  it("録音なしでも止まっていれば閉じる", () => expect(isActive(makeContext(events), false)).toBe(false));
  it("録音つきなら再生中でも閉じる（時刻は <audio> から受ける）", () => expect(isActive(makeContext(events, { maybeAudioUrl: Option.some("blob:a") }), true)).toBe(false));
});
