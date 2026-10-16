import { describe, expect, it } from "vitest";
import { parseSilenceDetect, speechLines } from "../bench/speechEnds.ts";

const MIN_SPEECH = 0.2;

describe("speechLines（無音区間の列 → 行の時刻）", () => {
  it("無音の始まりが行の end になり、無音の終わりが次の行の start になる", () => {
    expect(
      speechLines([{ start: 3.0, end: 4.0 }, { start: 7.5, end: 8.2 }], 10, MIN_SPEECH),
    ).toEqual([{ start: 0, end: 3.0 }, { start: 4.0, end: 7.5 }, { start: 8.2, end: 10 }]);
  });

  it("先頭と末尾の無音からは行を作らない（end 0 の行も、末尾の無音より後ろの行も無い）", () => {
    expect(
      speechLines([{ start: 0, end: 1.5 }, { start: 6.0, end: 7.0 }, { start: 9.0 }], 10, MIN_SPEECH),
    ).toEqual([{ start: 1.5, end: 6.0 }, { start: 7.0, end: 9.0 }]);
  });

  it("録音の終わりまで続く無音（end が長さ以上）の後ろにも行を作らない", () => {
    expect(speechLines([{ start: 4.0, end: 10 }], 10, MIN_SPEECH)).toEqual([{ start: 0, end: 4.0 }]);
  });

  it("短すぎる話している区間（雑音の一瞬）は行にしない", () => {
    expect(
      speechLines([{ start: 2.0, end: 5.0 }, { start: 5.1, end: 6.0 }], 10, MIN_SPEECH),
    ).toEqual([{ start: 0, end: 2.0 }, { start: 6.0, end: 10 }]);
  });

  it("無音が無ければ全体が 1 行、長さ 0 なら行は無い", () => {
    expect(speechLines([], 4, MIN_SPEECH)).toEqual([{ start: 0, end: 4 }]);
    expect(speechLines([], 0, MIN_SPEECH)).toEqual([]);
  });

  it("各行は start と end だけを持つ（--lines の形）", () => {
    for (const line of speechLines([{ start: 3, end: 4 }], 10, MIN_SPEECH)) {
      expect(Object.keys(line).sort()).toEqual(["end", "start"]);
    }
  });
});

describe("parseSilenceDetect（ffmpeg の stderr）", () => {
  const stderr = [
    "  Duration: 00:01:05.50, start: 0.000000, bitrate: 256 kb/s",
    "[silencedetect @ 0x1] silence_start: 3.25",
    "[silencedetect @ 0x1] silence_end: 4.5 | silence_duration: 1.25",
    "[silencedetect @ 0x1] silence_start: 60.125",
    "size=N/A time=00:01:05.50 bitrate=N/A",
  ].join("\n");

  it("無音区間の列と録音の長さを読み、末尾の silence_start は end なしで残す", () => {
    expect(parseSilenceDetect(stderr)).toEqual({
      duration: 65.5,
      silences: [{ start: 3.25, end: 4.5 }, { start: 60.125 }],
    });
  });

  it("Duration が無ければ長さは undefined（空の長さとして扱わない）", () => {
    expect(parseSilenceDetect("[silencedetect @ 0x1] silence_start: 1\n").duration).toBeUndefined();
  });
});
