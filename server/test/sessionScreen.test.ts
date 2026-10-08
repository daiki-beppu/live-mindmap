import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { DiffEvent, makeSession, ROOT_ID, restoreState, type DiffInput, type DiffOutput, type LogEvent, type Remark, type ScreenChange } from "../src/core/index.ts";
import { collectLog, logLayer, updaterLayer, type UpdateFailure } from "./fixtures/sessionLayers.ts";

// 共有画面の変化を受ける口（Session.pushScreen）と、差分更新の呼び出しに添える画面の選び方（core の規則）。
// ファイルには書かない（ADR 0003）: 画像は SessionLog.writeScreen にバイト列で渡し、ログには { start, image: ファイル名 | null } を書く。

const bytes = (s: string) => new TextEncoder().encode(s);
const shot = (start: number, id = `s${start}`): ScreenChange => ({ start, image: { id, bytes: bytes(`bytes:${id}`) } });
const none = (start: number): ScreenChange => ({ start, image: null });

let seq = 0;
const remark = (end: number): Remark => {
  seq++;
  return { id: `r${seq}`, track: "相手", start: end - 1, end, text: "発言" };
};

type Written = { file: string; bytes: Uint8Array };

const setup = Effect.fn("setup")(function* (options: { fail?: (callIndex: number) => boolean } = {}) {
  const calls: DiffInput[] = [];
  const events: LogEvent[] = [];
  const written: Written[] = [];
  const reads: string[] = [];
  const update = (input: DiffInput): Effect.Effect<DiffOutput, UpdateFailure> =>
    Effect.suspend(() => {
      calls.push(input);
      return options.fail?.(calls.length - 1) ? Effect.fail({ _tag: "UpdateFailed", message: "失敗" }) : Effect.succeed({ ops: [] });
    });
  const session = yield* makeSession({ title: "定例" }).pipe(Effect.provide(Layer.merge(updaterLayer(update), collectLog(events, written, reads))));
  // 発言を 2 つ流して、差分更新を 1 回起こす（end の最大は後ろの発言）
  const call = Effect.fn("call")(function* (...ends: [number, number]) {
    yield* session.push(remark(ends[0]));
    yield* session.push(remark(ends[1]));
    yield* session.idle;
  });
  const diffs = () => events.filter((e): e is Extract<LogEvent, { type: "diff" }> => e.type === "diff");
  const screenLines = () => events.filter((e): e is Extract<LogEvent, { type: "screen" }> => e.type === "screen");
  return { session, calls, events, written, reads, call, diffs, screenLines };
});

const startsOf = (input: DiffInput) => input.screens?.map((s) => s.start);

describe("Session.pushScreen", () => {
  it.effect("変化を受けるだけで差分更新を呼ばない。呼び出しの区切りは発言で決まる", () =>
    Effect.gen(function* () {
      const { session, calls, diffs } = yield* setup();
      yield* session.pushScreen(shot(1));
      yield* session.pushScreen(none(2));
      yield* session.pushScreen(shot(3));
      yield* session.idle;
      yield* session.flush;
      expect(calls).toEqual([]);
      expect(diffs()).toEqual([]);
    }));

  it.effect("変化 1 件ごとに screen の行を書き、画像はファイル名で参照する。バイト列は writeScreen に同じものを渡す。「なし」は image: null でファイルを書かない", () =>
    Effect.gen(function* () {
      const { session, screenLines, written } = yield* setup();
      const first = shot(754.2, "slide-a");
      yield* session.pushScreen(first);
      yield* session.pushScreen(none(800));
      expect(screenLines()).toEqual([
        { type: "screen", start: 754.2, image: "0754.2.jpg" },
        { type: "screen", start: 800, image: null },
      ]);
      expect(written).toHaveLength(1);
      expect(written[0]!.file).toBe("0754.2.jpg");
      expect(written[0]!.bytes).toEqual(first.image!.bytes);
    }));

  it.effect("同じ時刻の変化が重なっても、画像のファイル名は区別され、行のファイル名と書いたファイルが対応する", () =>
    Effect.gen(function* () {
      const { session, screenLines, written } = yield* setup();
      const a = shot(10, "a");
      const b = shot(10, "b");
      yield* session.pushScreen(a);
      yield* session.pushScreen(b);
      const [lineA, lineB] = screenLines();
      expect(lineA!.image).toBe("0010.0.jpg"); // 最初の 1 件は時刻だけの名前
      expect(lineB!.image).toMatch(/\.jpg$/);
      expect(lineB!.image).not.toBe(lineA!.image);
      expect(written.map((w) => w.file)).toEqual([lineA!.image, lineB!.image]);
      expect(written[0]!.bytes).toEqual(a.image!.bytes);
      expect(written[1]!.bytes).toEqual(b.image!.bytes);
    }));
});

describe("Session.pushScreenOff", () => {
  it.effect("受け取った start と reason をそのままログに 1 行書く。指定も許可なしも同じ口を通る", () =>
    Effect.gen(function* () {
      const { session, events } = yield* setup();
      yield* session.pushScreenOff({ start: 0, reason: "指定" });
      yield* session.pushScreenOff({ start: 7.5, reason: "許可なし" });
      expect(events.filter((e) => e.type === "screen-off")).toEqual([
        { type: "screen-off", start: 0, reason: "指定" },
        { type: "screen-off", start: 7.5, reason: "許可なし" },
      ]);
    }));

  it.effect("ログの行は他の行と同じく受け取った順に書く（screen・発言と入り交じっても順序が保たれる）", () =>
    Effect.gen(function* () {
      const { session, events } = yield* setup();
      yield* session.pushScreen(none(1));
      yield* session.pushScreenOff({ start: 2, reason: "許可なし" });
      yield* session.push(remark(5));
      yield* session.pushScreenOff({ start: 3, reason: "許可なし" });
      expect(events.map((e) => e.type)).toEqual(["start", "screen", "screen-off", "remark", "screen-off"]);
    }));

  it.effect("差分更新を呼ばず、画像を書かず、読み戻さない", () =>
    Effect.gen(function* () {
      const { session, calls, written, reads, diffs } = yield* setup();
      yield* session.pushScreenOff({ start: 1, reason: "許可なし" });
      yield* session.idle;
      yield* session.flush;
      expect(calls).toEqual([]);
      expect(diffs()).toEqual([]);
      expect(written).toEqual([]);
      expect(reads).toEqual([]);
    }));

  it.effect("差分更新の入力は screen-off を使わない口と同じ。添える画面（screens）も screenCount も増えない", () =>
    Effect.gen(function* () {
      const plain = yield* setup();
      yield* plain.call(8, 9);
      const withOff = yield* setup();
      yield* withOff.session.pushScreenOff({ start: 0, reason: "指定" });
      yield* withOff.session.pushScreenOff({ start: 4, reason: "許可なし" });
      yield* withOff.call(8, 9);
      expect(withOff.calls).toHaveLength(1);
      // 発言の id はテストの採番が進むので、id を除いて比べる
      const withoutIds = (input: DiffInput) => ({ ...input, fresh: input.fresh.map(({ id: _id, ...rest }) => rest), recent: input.recent });
      expect(withoutIds(withOff.calls[0]!)).toEqual(withoutIds(plain.calls[0]!));
      expect("screens" in withOff.calls[0]!).toBe(false);
      // ログの diff の input も、screens・screenCount が付かず、同じ項目を持つ（発言の id は採番が進むので値は比べない）
      expect(Object.keys(withOff.diffs()[0]!.input).sort()).toEqual(Object.keys(plain.diffs()[0]!.input).sort());
      expect("screenCount" in withOff.diffs()[0]!.input).toBe(false);
    }));

  it.effect("前に添えた画面（previousScreens）の送り直しの対象に混ざらない", () =>
    Effect.gen(function* () {
      const { session, calls, call } = yield* setup();
      yield* session.pushScreen(shot(1));
      yield* call(8, 9);
      yield* session.pushScreenOff({ start: 10, reason: "許可なし" });
      yield* call(18, 19);
      expect(calls).toHaveLength(2);
      expect(calls[1]!.previousScreens?.map((s) => s.start)).toEqual([1]);
      expect(startsOf(calls[1]!) ?? []).toEqual([]);
    }));
});

describe("画像のバイト列の保持", () => {
  it.effect("発言のないまま画面の変化が続いても、画像は読み戻さない（バイト列を持ち続けない）。添えるときに、選んだ 3 件だけ読む", () =>
    Effect.gen(function* () {
      const { session, calls, reads, written, call } = yield* setup();
      for (const t of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) yield* session.pushScreen(shot(t));
      expect(reads).toEqual([]);
      expect(written).toHaveLength(10);
      yield* call(10, 11);
      expect(reads).toEqual(["0008.0.jpg", "0009.0.jpg", "0010.0.jpg"]);
      expect(calls[0]!.screens).toEqual([8, 9, 10].map((t) => ({ start: t, image: { id: `s${t}`, bytes: bytes(`bytes:s${t}`) } })));
    }));

  it.effect("同じ時刻の画像 2 件は別のファイル名で保存され、添付時もその名前で読み戻される", () =>
    Effect.gen(function* () {
      const { session, calls, reads, written, call } = yield* setup();
      yield* session.pushScreen(shot(10, "a"));
      yield* session.pushScreen(shot(10, "b"));
      yield* call(10, 11);
      expect(written.map((w) => w.file)).toEqual(["0010.0.jpg", "0010.0-2.jpg"]);
      expect(reads).toEqual(["0010.0.jpg", "0010.0-2.jpg"]);
      expect(calls[0]!.screens!.map((s) => s.image && new TextDecoder().decode(s.image.bytes))).toEqual(["bytes:a", "bytes:b"]);
    }));

  it.effect("既に使った名前の画像を、別の画像として読み戻さない（0010.0.jpg への書き込みは 1 回だけ）", () =>
    Effect.gen(function* () {
      const { session, calls, written, call } = yield* setup();
      yield* session.pushScreen(shot(10, "a"));
      yield* session.pushScreen(shot(10, "b"));
      yield* call(10, 11);
      expect(written.filter((w) => w.file === "0010.0.jpg")).toHaveLength(1);
      const [a, b] = calls[0]!.screens!;
      expect(b!.image!.bytes).not.toEqual(a!.image!.bytes);
    }));
});

describe("差分更新に添える画面の選び方", () => {
  it.effect("映り始めた時刻が新しい発言の end の最大値以下のものを、時刻順に添える。後に映り始めたものは次の呼び出しへ回す（境界は含む）", () =>
    Effect.gen(function* () {
      const { session, calls, call, diffs } = yield* setup();
      // 呼び出しの end の最大は 9。9 ちょうどは添える。9.5 は後
      yield* session.pushScreen(shot(9));
      yield* session.pushScreen(shot(5)); // 受け取った順ではなく時刻順に添える
      yield* session.pushScreen(shot(9.5));
      yield* call(8, 9);
      expect(startsOf(calls[0]!)).toEqual([5, 9]);
      expect(calls[0]!.screens![0]!.image).toEqual({ id: "s5", bytes: bytes("bytes:s5") });
      expect(diffs()[0]!.input.screens).toEqual([
        { start: 5, image: "0005.0.jpg" },
        { start: 9, image: "0009.0.jpg" },
      ]);

      yield* call(19, 20);
      expect(startsOf(calls[1]!)).toEqual([9.5]);
      expect(diffs()[1]!.input.screens).toEqual([{ start: 9.5, image: "0009.5.jpg" }]);
    }));

  it.effect("end の最大値は新しい発言の中の最大（先頭の発言が最大とは限らない）", () =>
    Effect.gen(function* () {
      const { session, calls, call } = yield* setup();
      yield* session.pushScreen(shot(15));
      yield* call(20, 12); // end の最大は 20（2 つ目の end は 12）
      expect(startsOf(calls[0]!)).toEqual([15]);
    }));

  it.effect("該当が無い呼び出しには画面を添えない（入力にも log の input にも screens のキーが無い）", () =>
    Effect.gen(function* () {
      const { session, calls, call, diffs } = yield* setup();
      yield* session.pushScreen(shot(50)); // まだ映り始めていない
      yield* call(8, 9);
      // 否定のテストなので、呼び出しが実際に起きたことを先に確かめる
      expect(calls).toHaveLength(1);
      expect("screens" in calls[0]!).toBe(false);
      expect("screens" in diffs()[0]!.input).toBe(false);
    }));

  it.effect("変化を 1 度も受けていないセッションは、今までと同じ入力（screens のキーが無い）", () =>
    Effect.gen(function* () {
      const { calls, call, diffs } = yield* setup();
      yield* call(8, 9);
      expect(calls).toHaveLength(1);
      expect("screens" in calls[0]!).toBe(false);
      expect("screens" in diffs()[0]!.input).toBe(false);
    }));

  it.effect("4 件以上たまっていれば新しい 3 件だけ添える（時刻順）。添えなかった古いものは次の呼び出しに戻らない", () =>
    Effect.gen(function* () {
      const { session, calls, call, diffs } = yield* setup();
      for (const t of [1, 2, 3, 4, 5]) yield* session.pushScreen(shot(t));
      yield* call(8, 9);
      expect(startsOf(calls[0]!)).toEqual([3, 4, 5]);
      expect(diffs()[0]!.input.screens).toHaveLength(3);

      yield* call(18, 19);
      expect(calls).toHaveLength(2);
      expect("screens" in calls[1]!).toBe(false);
    }));

  it.effect("ちょうど 3 件ならすべて添える。「なし」も 1 件に数える", () =>
    Effect.gen(function* () {
      const { session, calls, call, diffs } = yield* setup();
      yield* session.pushScreen(shot(1));
      yield* session.pushScreen(none(2));
      yield* session.pushScreen(shot(3));
      yield* call(8, 9);
      expect(startsOf(calls[0]!)).toEqual([1, 2, 3]);
      expect(calls[0]!.screens![1]!.image).toBeNull();
      expect(diffs()[0]!.input.screens).toEqual([
        { start: 1, image: "0001.0.jpg" },
        { start: 2, image: null },
        { start: 3, image: "0003.0.jpg" },
      ]);
    }));

  it.effect("添えた画面は同じ呼び出しで 1 度だけ。次の呼び出しには、その後に受けた変化だけが載る", () =>
    Effect.gen(function* () {
      const { session, calls, call } = yield* setup();
      yield* session.pushScreen(shot(1));
      yield* call(8, 9);
      yield* session.pushScreen(shot(10));
      yield* call(18, 19);
      expect(startsOf(calls[0]!)).toEqual([1]);
      expect(startsOf(calls[1]!)).toEqual([10]);
    }));

  it.effect("差分更新が失敗した回の画面も処理済み（次の呼び出しに再び載せない）。失敗の diff の入力には添えた画面が残る", () =>
    Effect.gen(function* () {
      const { session, calls, call, diffs } = yield* setup({ fail: (i) => i === 0 });
      yield* session.pushScreen(shot(1));
      yield* call(8, 9);
      yield* call(18, 19);
      expect(calls).toHaveLength(2);
      expect(diffs()[0]!.error).toBeDefined();
      expect(diffs()[0]!.input.screens).toEqual([{ start: 1, image: "0001.0.jpg" }]);
      expect("screens" in calls[1]!).toBe(false);
    }));

  it.effect("添える画像の読み戻しが defect になっても、update の失敗と同じく処理済みにして次の呼び出しへ進む", () =>
    Effect.gen(function* () {
      const calls: DiffInput[] = [];
      const events: LogEvent[] = [];
      const update = (input: DiffInput): Effect.Effect<DiffOutput, UpdateFailure> =>
        Effect.sync(() => {
          calls.push(input);
          return { ops: [] };
        });
      const layer = Layer.merge(
        updaterLayer(update),
        logLayer(
          (event) => Effect.sync(() => void events.push(event)),
          () => Effect.void,
          () => Effect.die(new Error("読めない")),
        ),
      );
      const session = yield* makeSession({ title: "定例" }).pipe(Effect.provide(layer));
      const r1 = remark(8);
      const r2 = remark(9);
      yield* session.pushScreen(shot(1));
      yield* session.push(r1);
      yield* session.push(r2);
      yield* session.idle;
      const diffs = () => events.filter((e): e is Extract<LogEvent, { type: "diff" }> => e.type === "diff");
      expect(diffs()).toHaveLength(1);
      expect(diffs()[0]!.error).toMatch(/^defect: /);
      expect(diffs()[0]!.input.fresh).toEqual([r1.id, r2.id]);
      expect(diffs()[0]!.input.screens).toEqual([{ start: 1, image: "0001.0.jpg" }]);
      expect(yield* session.unreflectedRemarks).toEqual([]);
      expect(calls).toHaveLength(0);

      yield* session.push(remark(18));
      yield* session.push(remark(19));
      yield* session.idle;
      expect(calls).toHaveLength(1);
      expect("screens" in calls[0]!).toBe(false);
      // 読めなかった画面は「最後に添えた」に数えるが、送り直しからは外し、続きの呼び出しを失敗させない
      expect("previousScreens" in calls[0]!).toBe(false);
      expect(diffs()).toHaveLength(2);
      expect(diffs()[1]!.error).toBeUndefined();
    }));

  it.effect("画面はノードの根拠にならない（マップの形は変わらず、差分更新へ渡す map は今までどおり）", () =>
    Effect.gen(function* () {
      const { session, calls, call } = yield* setup();
      yield* session.pushScreen(shot(1));
      yield* call(8, 9);
      const snapshot = yield* session.snapshot;
      expect(snapshot.nodes.map((n) => n.id)).toEqual([ROOT_ID]);
      expect(Object.keys(calls[0]!).sort()).toEqual(["fresh", "map", "recent", "screens"]);
    }));
});

describe("開き直しのために送り直す、最後に添えた 2 件（DiffInput.previousScreens）", () => {
  const previousStarts = (input: DiffInput) => input.previousScreens?.map((s) => s.start);

  it.effect("最初の呼び出しには付かない（キーごと無い）。次の呼び出しには、前の呼び出しで添えた画面が、バイト列つきで載る", () =>
    Effect.gen(function* () {
      const { session, calls, call } = yield* setup();
      const a = shot(1, "a");
      yield* session.pushScreen(a);
      yield* call(8, 9);
      yield* call(18, 19);
      expect("previousScreens" in calls[0]!).toBe(false);
      expect(calls[1]!.previousScreens).toEqual([a]);
      expect("screens" in calls[1]!).toBe(false); // 新しく添える画面とは別のキー
    }));

  it.effect("最後に添えた 2 件を、呼び出しをまたいで数える（古い方から押し出す）。添える画面が無い呼び出しにも載る", () =>
    Effect.gen(function* () {
      const { session, calls, call } = yield* setup();
      yield* session.pushScreen(shot(1));
      yield* call(8, 9);
      yield* session.pushScreen(none(10));
      yield* call(18, 19);
      yield* call(28, 29); // 添える画面なし
      yield* session.pushScreen(shot(30));
      yield* call(38, 39);
      yield* call(48, 49);
      expect(calls.map(previousStarts)).toEqual([undefined, [1], [1, 10], [1, 10], [10, 30]]);
      expect(calls[1]!.previousScreens![0]!.image!.bytes).toEqual(bytes("bytes:s1"));
    }));

  it.effect("1 回の呼び出しで 3 件添えたら、次の送り直しはその中の新しい 2 件。「なし」も 1 件に数える", () =>
    Effect.gen(function* () {
      const { session, calls, call } = yield* setup();
      yield* session.pushScreen(shot(1));
      yield* session.pushScreen(shot(2));
      yield* session.pushScreen(none(3));
      yield* call(8, 9);
      yield* call(18, 19);
      expect(previousStarts(calls[1]!)).toEqual([2, 3]);
      expect(calls[1]!.previousScreens![1]!.image).toBeNull();
    }));

  it.effect("失敗した呼び出しで選んだ画面も「添えた」ものに数える", () =>
    Effect.gen(function* () {
      const { session, calls, call } = yield* setup({ fail: (i) => i === 1 });
      yield* session.pushScreen(shot(1));
      yield* call(8, 9);
      yield* session.pushScreen(shot(10));
      yield* call(18, 19); // 失敗
      yield* call(28, 29);
      expect(previousStarts(calls[2]!)).toEqual([1, 10]);
    }));

  it.effect("送り直す画面はログに書かない: diff の input に previousScreens は無く、screens は新しく添えた画面だけ", () =>
    Effect.gen(function* () {
      const { session, call, diffs } = yield* setup();
      yield* session.pushScreen(shot(1));
      yield* call(8, 9);
      yield* session.pushScreen(shot(10));
      yield* call(18, 19);
      yield* call(28, 29);
      expect(diffs().map((d) => d.input.screens)).toEqual([[{ start: 1, image: "0001.0.jpg" }], [{ start: 10, image: "0010.0.jpg" }], undefined]);
      expect(diffs().some((d) => "previousScreens" in d.input)).toBe(false);
    }));

  it.effect("共有画面が一度も無いセッションの入力に previousScreens は付かない", () =>
    Effect.gen(function* () {
      const { calls, call } = yield* setup();
      yield* call(8, 9);
      yield* call(18, 19);
      expect(calls.some((c) => "previousScreens" in c)).toBe(false);
    }));
});

describe("ログの読み戻し（共有画面のないログは今までどおり読める）", () => {
  const start = { type: "start", title: "定例" };
  const r1 = { type: "remark", remark: { id: "r1", track: "相手", start: 0, end: 5, text: "決めます" } };

  it.effect("diff の input.screens は省略できるキー。無いログも、{ start, image } の列があるログも decode できる", () =>
    Effect.gen(function* () {
      const base = { type: "diff", input: { recent: [], fresh: ["r1"], nodeCount: 0 }, ops: [], dropped: [] };
      const withScreens = { ...base, input: { ...base.input, screens: [{ start: 1, image: "0001.0.jpg" }, { start: 2, image: null }] } };
      const decoded = yield* Schema.decodeUnknownEffect(DiffEvent)(withScreens);
      expect(decoded.input.screens).toEqual([{ start: 1, image: "0001.0.jpg" }, { start: 2, image: null }]);
      expect("screens" in (yield* Schema.decodeUnknownEffect(DiffEvent)(base)).input).toBe(false);
      const without = yield* restoreState([start, r1, base]);
      const withShots = yield* restoreState([start, r1, withScreens]);
      expect(withShots.round).toBe(without.round);
      expect(withShots.known).toEqual(without.known);
    }));

  it.effect("screen の行を読んでも、round・発言・マップは変わらない", () =>
    Effect.gen(function* () {
      const diff = { type: "diff", input: { recent: [], fresh: ["r1"], nodeCount: 0 }, ops: [], dropped: [] };
      const plain = yield* restoreState([start, r1, diff]);
      const withScreenLines = yield* restoreState([
        start,
        { type: "screen", start: 1, image: "0001.0.jpg" },
        r1,
        { type: "screen", start: 2, image: null },
        diff,
      ]);
      expect(withScreenLines.round).toBe(plain.round);
      expect(withScreenLines.remarks).toEqual(plain.remarks);
      expect(withScreenLines.map).toEqual(plain.map);
    }));

  it.effect("screen-off の行を挟んでも、復元した状態は挟まないログと変わらず、restoreSession できる", () =>
    Effect.gen(function* () {
      const diff = { type: "diff", input: { recent: [], fresh: ["r1"], nodeCount: 0 }, ops: [], dropped: [] };
      const off = (reason: string, at: number) => ({ type: "screen-off", start: at, reason });
      const plain = yield* restoreState([start, r1, diff]);
      const withOff = yield* restoreState([start, off("指定", 0), r1, off("許可なし", 3), diff]);
      expect(withOff.round).toBe(plain.round);
      expect(withOff.remarks).toEqual(plain.remarks);
      expect(withOff.map).toEqual(plain.map);
      expect(withOff.known).toEqual(plain.known);
    }));

  it.effect("pushScreenOff で書いた行を含むログを restoreState で戻しても、壊れた行にならない", () =>
    Effect.gen(function* () {
      const { session, events } = yield* setup();
      yield* session.pushScreenOff({ start: 0, reason: "指定" });
      yield* session.push(remark(5));
      yield* session.pushScreenOff({ start: 2, reason: "許可なし" });
      yield* session.idle;
      const lines = [{ type: "start", title: "定例" }, ...events];
      const restored = yield* restoreState(lines);
      expect(restored.remarks).toHaveLength(1);
    }));
});
