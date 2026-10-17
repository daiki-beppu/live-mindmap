import { Option } from "effect";
import { Command, expect as expectScene, given, Mount, scene, selector, tap } from "foldkit/scene";
import { describe, expect, it } from "vitest";
import { Message as MapSurfaceMessage } from "../src/app/mapSurface/message.ts";
import { SlideCaptions } from "../src/app/sessionLayout/mount.ts";
import { ObserveMapSurface } from "../src/app/mapSurface/mount.ts";
import { PauseAudio } from "../src/app/review/command.ts";
import { makeContext } from "../src/app/review/context.ts";
import { init, type Model, makeUpdate, makeView, snapshotOf } from "../src/app/review/main.ts";
import { Message } from "../src/app/review/message.ts";
import { ObserveAudio, ObserveSeekPointer } from "../src/app/review/mount.ts";
import { foldView } from "../src/folding.ts";
import { settle, TOOLTIPS_AUDIO, TOOLTIPS_PLAIN, tooltipMounts } from "./reviewHarness.ts";

// 見返しの録音つきの時刻の同期（Issue #824）の Scene。<audio> の Mount を Mount.resolve で解き、受けた時刻のマップが表示面に出ることを見る。
// 比べる相手は、既存の純粋な関数 foldView が、その時刻の Snapshot から返すノード（#823 の Scene と同じ）

const remark = (id: string, end: number, text: string) => ({ at: "x", type: "remark", remark: { id, track: "相手", start: end - 5, end, text } });
const add = (ref: string, parent: string, kind: string, text: string, evidence: string[]) => ({ op: "add", ref, parent, kind, text, evidence });
const diff = (fresh: string[], ops: unknown[]) => ({ at: "x", type: "diff", input: { recent: [], fresh, nodeCount: 0 }, ops, dropped: [] });
const events = [
  { at: "a", type: "start", title: "定例" },
  remark("r1", 10, "採用の話をします。"),
  diff(["r1"], [add("t1", "root", "議題", "採用", ["r1"])]),
  remark("r2", 30, "予算です。"),
  diff(["r2"], [add("t2", "root", "議題", "予算", ["r2"]), add("p1", "t2", "論点", "上限をどうするか", ["r2"])]),
];

const URL = "blob:review-audio";
const audioContext = makeContext(events, { maybeAudioUrl: Option.some(URL) });
const plainContext = makeContext(events);
const audioApp = { update: makeUpdate(audioContext), view: makeView(audioContext) };
const plainApp = { update: makeUpdate(plainContext), view: makeView(plainContext) };
const playingAt = (time: number): Model => {
  const start = init(audioContext);
  return { ...start, playback: { ...start.playback, time, playing: true } };
};
const stoppedAt = (time: number): Model => ({ ...playingAt(time), playback: { ...playingAt(time).playback, playing: false } });
const expectedIds = (time: number): string[] => foldView(snapshotOf(audioContext, stoppedAt(time)), new Set(), null, new Set(), new Set()).nodes.map((n) => n.id);
const measuredAll = (time: number) => Mount.resolve(ObserveMapSurface, MapSurfaceMessage.MeasuredMapSurface({ width: 800, height: 600, nodeHeights: Object.fromEntries(expectedIds(time).map((id) => [id, 40])) }));
const renderedIds = (html: { children?: unknown }): string[] => {
  type V = { data?: { attrs?: Record<string, unknown> }; children?: Array<V | string> };
  const walk = (v: V): string[] => [...(typeof v.data?.attrs?.["data-node-id"] === "string" ? [v.data.attrs["data-node-id"] as string] : []), ...(v.children ?? []).flatMap((c) => (typeof c === "string" ? [] : walk(c)))];
  return walk(html as V);
};

describe("見返しの Scene: 録音つきの <audio> と Mount", () => {
  it("録音つきは <audio> を 1 つ描き、src に録音の URL を持ち、ObserveAudio と ObserveMapSurface の Mount がある（操作の行の Mount も加わる）", () => {
    scene(
      audioApp,
      given(stoppedAt(10)),
      Mount.expectExact(ObserveMapSurface, SlideCaptions, ObserveAudio, ObserveSeekPointer, ...tooltipMounts(TOOLTIPS_AUDIO)),
      expectScene(selector("audio")).toHaveAttr("src", URL),
      measuredAll(10),
      Mount.resolve(ObserveAudio, Message.UpdatedAudioTime({ time: 10 })),
      settle,
    );
  });

  it("録音なしは <audio> を描かず、ObserveAudio の Mount も無い（あるのは 表示面・シークバーのポインタ・ツールチップ）", () => {
    scene(
      plainApp,
      given(init(plainContext)),
      Mount.expectExact(ObserveMapSurface, SlideCaptions, ObserveSeekPointer, ...tooltipMounts(TOOLTIPS_PLAIN)),
      expectScene(selector("audio")).toBeAbsent(),
      measuredAll(30),
      settle,
    );
  });
});

describe("見返しの Scene: 時刻の同期（Mount.resolve で <audio> の時刻を渡す）", () => {
  it("再生中に時刻 10 を受けると、時刻 10 のマップのノードだけが描かれる（受ける前は時刻 5 のマップ）", () => {
    expect(expectedIds(10)).not.toEqual(expectedIds(5));
    scene(
      audioApp,
      given(playingAt(5)),
      tap((simulation) => expect(renderedIds(simulation.html).sort()).toEqual(expectedIds(5).sort())),
      Mount.resolve(ObserveAudio, Message.UpdatedAudioTime({ time: 10 })),
      tap((simulation) => expect(renderedIds(simulation.html).sort()).toEqual(expectedIds(10).sort())),
      measuredAll(10),
      settle,
    );
  });

  it("再生中に会議の長さを超えた時刻を受けると、時刻 30 のマップになり、<audio> を止める Command が出て解ける", () => {
    scene(
      audioApp,
      given(playingAt(5)),
      Mount.resolve(ObserveAudio, Message.UpdatedAudioTime({ time: 35 })),
      tap((simulation) => {
        expect(renderedIds(simulation.html).sort()).toEqual(expectedIds(30).sort());
        expect(simulation.commands.map((c) => c.name)).toEqual(["PauseAudio"]);
      }),
      Command.resolve(PauseAudio, Message.CompletedPauseAudio()),
      measuredAll(30),
      settle,
    );
  });

  it("再生中に終わり（ended）を受けると、時刻 30 のマップになる", () => {
    scene(
      audioApp,
      given(playingAt(5)),
      Mount.resolve(ObserveAudio, Message.EndedAudio()),
      tap((simulation) => {
        expect(renderedIds(simulation.html).sort()).toEqual(expectedIds(30).sort());
        expect(simulation.commands).toEqual([]);
      }),
      measuredAll(30),
      settle,
    );
  });

  it("止まっている間に受けた時刻は無視され、描かれるマップは変わらない", () => {
    scene(
      audioApp,
      given(stoppedAt(10)),
      Mount.resolve(ObserveAudio, Message.UpdatedAudioTime({ time: 30 })),
      tap((simulation) => expect(renderedIds(simulation.html).sort()).toEqual(expectedIds(10).sort())),
      measuredAll(10),
      settle,
    );
  });
});
