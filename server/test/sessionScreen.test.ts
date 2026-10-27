import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { DiffEvent, LogEvent, makeSession, ROOT_ID, restoreSession, restoreState, type DiffInput, type DiffOutput, type Remark, type ScreenChange } from "../src/core/index.ts";
import { gatedScripted } from "./fixtures/batches.ts";
import { collectLog, forbiddenUpdater, logLayer, updaterLayer, type UpdateFailure } from "./fixtures/sessionLayers.ts";

// 共有画面の変化を受ける口（Session.pushScreen）と、更新器・ログへの受け渡し。
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

// held: 差分更新にまだ渡していない発言を 1 件持たせて開く（images は既定のまま）（ログから復元したたまり）。次の push で、held と新しい発言が 1 回の呼び出しにまとまって渡る
const setup = Effect.fn("setup")(function* (options: { images?: boolean; fail?: (callIndex: number) => boolean; held?: Remark } = {}) {
  const calls: DiffInput[] = [];
  const events: LogEvent[] = [];
  const written: Written[] = [];
  const reads: string[] = [];
  // block.on の間に呼ばれた差分更新は、終わらないまま止まる（発言が「渡したが反映していない」状態で残る）
  const block = { on: false };
  const update = (input: DiffInput): Effect.Effect<DiffOutput, UpdateFailure> =>
    Effect.suspend(() => {
      calls.push(input);
      if (block.on) return Effect.never;
      return options.fail?.(calls.length - 1) ? Effect.fail({ _tag: "UpdateFailed", message: "失敗" }) : Effect.succeed({ ops: [] });
    });
  const layer = Layer.merge(updaterLayer(update), collectLog(events, written, reads));
  const settings = { title: "定例", ...("images" in options ? { images: options.images } : {}) };
  const session = options.held
    ? yield* restoreSession([{ type: "start", title: "定例" }, { type: "remark", remark: options.held }]).pipe(Effect.provide(layer))
    : yield* makeSession(settings).pipe(Effect.provide(layer));
  // 発言を 1 件流して、差分更新を 1 回起こす（呼び出し中でなければ、発言 1 件ですぐ呼ばれる）
  const call = Effect.fn("call")(function* (end: number) {
    yield* session.push(remark(end));
    yield* session.idle;
  });
  const diffs = () => events.filter((e): e is Extract<LogEvent, { type: "diff" }> => e.type === "diff");
  const screenLines = () => events.filter((e): e is Extract<LogEvent, { type: "screen" }> => e.type === "screen");
  return { session, calls, events, written, reads, call, diffs, screenLines, block };
});

const startsOf = (input: DiffInput) => input.screens?.map((s) => s.start);
const skippedReason = "差分更新には渡さない（モデルが画像を読まない）";

describe("モデルが画像を読まないセッション（Issue #665）", () => {
  it.effect.each([false, true])("images:false は画面を添えず、発言の更新と保存を続ける（初回失敗: %s）", (failFirst) =>
    Effect.gen(function* () {
      const { session, calls, written, reads, screenLines, call, diffs } = yield* setup({ images: false, fail: (i) => failFirst && i === 0 });
      const first = shot(1, "first");
      const next = shot(10, "next");
      yield* session.pushScreen(first);
      yield* session.pushScreen(none(2));
      yield* call(9);
      yield* session.pushScreen(next);
      yield* call(19);
      yield* call(29);

      expect(calls.map((input) => input.fresh.map((r) => r.end))).toEqual([[9], [19], [29]]);
      expect(written.map((w) => w.bytes)).toEqual([first.image!.bytes, next.image!.bytes]);
      expect(screenLines()).toEqual([
        { type: "screen", start: 1, image: written[0]!.file },
        { type: "screen", start: 2, image: null },
        { type: "screen", start: 10, image: written[1]!.file },
      ]);
      for (const input of calls) {
        expect.soft("screens" in input).toBe(false);
      }
      expect.soft(reads).toEqual([]);
      expect(diffs()).toHaveLength(3);
      for (const diff of diffs()) expect.soft("screens" in diff.input).toBe(false);
      expect(diffs()[0]!.error !== undefined).toBe(failFirst);
      expect(diffs()[1]!.error).toBeUndefined();
      expect(diffs()[2]!.error).toBeUndefined();
    }));

  it.effect("images:false の理由は screen-off と別の行に残る", () =>
    Effect.gen(function* () {
      const { session, events } = yield* setup({ images: false });
      yield* session.pushScreenOff({ start: 0, reason: "指定" });
      const notifications = events.filter((e) => "reason" in e && String(e.reason) === skippedReason);
      expect(notifications).toHaveLength(1);
      expect(notifications[0]!.type).not.toBe("screen-off");
      expect(events.filter((e) => e.type === "screen-off")).toEqual([{ type: "screen-off", start: 0, reason: "指定" }]);
    }));

  it.effect("添付を省く理由の行を JSON から decode・restoreSession してもマップと発言を復元できる", () =>
    Effect.gen(function* () {
      const original = yield* setup({ images: false });
      yield* original.session.pushScreen(shot(1));
      yield* original.call(9);
      // 呼び出しが終わらないうちの発言は、ログに remark の行だけが残り、反映されない
      original.block.on = true;
      const pending = remark(20);
      yield* original.session.push(pending);
      const notifications = original.events.filter((e) => "reason" in e && String(e.reason) === skippedReason);
      expect(notifications).toHaveLength(1);
      const lines: unknown[] = original.events.map((e) => JSON.parse(JSON.stringify(e)));
      const events: LogEvent[] = [];
      const written: Written[] = [];
      const reads: string[] = [];
      const layer = Layer.merge(forbiddenUpdater, collectLog(events, written, reads));
      const decoded = yield* Effect.forEach(lines, (line) => Schema.decodeUnknownEffect(LogEvent)(line));
      expect(decoded).toContainEqual(notifications[0]);
      const restored = yield* restoreSession(decoded).pipe(Effect.provide(layer));
      expect(yield* restored.snapshot).toEqual(yield* original.session.snapshot);
      expect(yield* restored.exportJson).toEqual(yield* original.session.exportJson);
      expect(yield* restored.unreflectedRemarks).toEqual([pending]);
      expect((yield* restoreState(decoded)).remarks).toEqual([...original.calls[0]!.fresh, pending]);
      expect(events).toEqual([]);
      expect(written).toEqual([]);
      expect(reads).toEqual([]);
    }));

  it.effect("明示した images:true は新規画面を従来どおり添える", () =>
    Effect.gen(function* () {
      const { session, calls, events, call } = yield* setup({ images: true });
      const first = shot(1);
      const next = shot(11);
      yield* session.pushScreen(first);
      yield* call(9);
      yield* session.pushScreen(next);
      yield* call(19);
      expect(calls).toHaveLength(2);
      expect(calls[0]!.screens).toEqual([{ start: 1, image: { id: "0001.0.jpg", bytes: first.image!.bytes } }]);
      expect(calls[1]!.screens).toEqual([{ start: 11, image: { id: "0011.0.jpg", bytes: next.image!.bytes } }]);
      expect(events.filter((e) => "reason" in e && String(e.reason) === skippedReason)).toEqual([]);
    }));
});

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
      yield* session.push(remark(5)); // 発言 1 件ですぐ差分更新が呼ばれ、diff の行が続く
      yield* session.pushScreenOff({ start: 3, reason: "許可なし" });
      expect(events.map((e) => e.type)).toEqual(["start", "screen", "screen-off", "remark", "diff", "screen-off"]);
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
      yield* plain.call(9);
      const withOff = yield* setup();
      yield* withOff.session.pushScreenOff({ start: 0, reason: "指定" });
      yield* withOff.session.pushScreenOff({ start: 4, reason: "許可なし" });
      yield* withOff.call(9);
      expect(withOff.calls).toHaveLength(1);
      // 発言の id はテストの採番が進むので、id を除いて比べる
      const withoutIds = (input: DiffInput) => ({ ...input, fresh: input.fresh.map(({ id: _id, ...rest }) => rest), recent: input.recent });
      expect(withoutIds(withOff.calls[0]!)).toEqual(withoutIds(plain.calls[0]!));
      expect("screens" in withOff.calls[0]!).toBe(false);
      // ログの diff の input も、screens・screenCount が付かず、同じ項目を持つ（発言の id は採番が進むので値は比べない）
      expect(Object.keys(withOff.diffs()[0]!.input).sort()).toEqual(Object.keys(plain.diffs()[0]!.input).sort());
      expect("screenCount" in withOff.diffs()[0]!.input).toBe(false);
    }));
});

describe("画像のバイト列の保持", () => {
  it.effect("発言のないまま画面の変化が続いても、画像は読み戻さない（バイト列を持ち続けない）。添えるときに、選んだ 3 件だけ読む", () =>
    Effect.gen(function* () {
      const { session, calls, reads, written, call } = yield* setup();
      for (const t of [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]) yield* session.pushScreen(shot(t));
      expect(reads).toEqual([]);
      expect(written).toHaveLength(10);
      yield* call(101);
      expect(reads).toEqual(["0080.0.jpg", "0090.0.jpg", "0100.0.jpg"]);
      expect(calls[0]!.screens).toEqual([80, 90, 100].map((t, i) => ({ start: t, image: { id: reads[i], bytes: bytes(`bytes:s${t}`) } })));
    }));

  it.effect("同じ時刻の画像 2 件は別のファイル名で保存され、添付時もその名前で読み戻される", () =>
    Effect.gen(function* () {
      const { session, calls, reads, written, call } = yield* setup();
      yield* session.pushScreen(shot(10, "a"));
      yield* session.pushScreen(shot(10, "b"));
      yield* call(11); // 同じ時刻の b は 10 秒未満なので持ち越す
      yield* call(21);
      expect(written.map((w) => w.file)).toEqual(["0010.0.jpg", "0010.0-2.jpg"]);
      expect(reads).toEqual(["0010.0.jpg", "0010.0-2.jpg"]);
      expect(calls[0]!.screens!.map((s) => s.image && new TextDecoder().decode(s.image.bytes))).toEqual(["bytes:a"]);
      expect(calls[1]!.screens!.map((s) => s.image && new TextDecoder().decode(s.image.bytes))).toEqual(["bytes:b"]);
    }));

  it.effect("既に使った名前の画像を、別の画像として読み戻さない（0010.0.jpg への書き込みは 1 回だけ）", () =>
    Effect.gen(function* () {
      const { session, calls, written, call } = yield* setup();
      yield* session.pushScreen(shot(10, "a"));
      yield* session.pushScreen(shot(10, "b"));
      yield* call(11);
      yield* call(21);
      expect(written.filter((w) => w.file === "0010.0.jpg")).toHaveLength(1);
      const [a] = calls[0]!.screens!;
      const [b] = calls[1]!.screens!;
      expect(b!.image!.bytes).not.toEqual(a!.image!.bytes);
    }));
});

describe("差分更新への共有画面の配線", () => {
  it.effect("選んだ画面が更新器にはファイル名idとバイト列で、diffには同じ並びのファイル参照で渡る", () =>
    Effect.gen(function* () {
      const { session, calls, call, diffs } = yield* setup();
      yield* session.pushScreen(shot(20));
      yield* session.pushScreen(shot(5));
      yield* session.pushScreen(none(7));
      yield* session.pushScreen(shot(35));
      yield* call(20);
      expect(calls[0]!.screens).toEqual([
        { start: 5, image: { id: "0005.0.jpg", bytes: bytes("bytes:s5") } },
        { start: 7, image: null },
        { start: 20, image: { id: "0020.0.jpg", bytes: bytes("bytes:s20") } },
      ]);
      expect(diffs()[0]!.input.screens).toEqual([
        { start: 5, image: "0005.0.jpg" },
        { start: 7, image: null },
        { start: 20, image: "0020.0.jpg" },
      ]);
      expect(diffs()[0]!.input.screenCount).toBe(4);
    }));

  it.effect.each([false, true])("呼び出し中に届いた締め切り以下の画面と発言は、結末の後の1回にまとまって渡る（初回失敗: %s）", (failFirst) =>
    Effect.gen(function* () {
      const { calls, update, replies } = gatedScripted(failFirst ? { _tag: "UpdateFailed", message: "失敗" } : [], []);
      const events: LogEvent[] = [];
      const session = yield* makeSession({ title: "定例" }).pipe(Effect.provide(Layer.merge(updaterLayer(update), collectLog(events))));
      yield* session.pushScreen(shot(0));
      yield* session.push(remark(30));
      expect(calls.map(startsOf)).toEqual([[0]]);
      yield* session.pushScreen(shot(10));
      yield* session.push(remark(31));
      yield* session.pushScreen(shot(20));
      yield* session.pushScreen(none(21));
      yield* session.push(remark(41));
      expect(calls).toHaveLength(1); // 呼び出し中は重ならない
      replies[0]!();
      const deadline = Date.now() + 5000;
      while (calls.length < 2) {
        if (Date.now() > deadline) throw new Error("後着の画面を添える2回目の差分更新が期限内に始まらなかった");
        yield* Effect.yieldNow;
      }
      expect(calls[1]!.fresh.map((x) => x.end)).toEqual([31, 41]);
      expect(startsOf(calls[1]!)).toEqual([10, 20, 21]);
      replies[1]!();
      yield* session.idle;
      expect(calls).toHaveLength(2);
      const diffs = events.filter((e) => e.type === "diff");
      expect(diffs.map((e) => e.input.screenCount)).toEqual([1, 4]);
      expect(diffs.map((e) => e.input.screens)).toEqual([
        [{ start: 0, image: "0000.0.jpg" }],
        [{ start: 10, image: "0010.0.jpg" }, { start: 20, image: "0020.0.jpg" }, { start: 21, image: null }],
      ]);
      expect(diffs[0]!.error !== undefined).toBe(failFirst);
    }));

  it.effect("end の最大値は新しい発言の中の最大（先頭の発言が最大とは限らない）", () =>
    Effect.gen(function* () {
      // 復元したたまりの発言（end 20）と新しい発言（end 12）が 1 回の呼び出しにまとまる
      const { session, calls, call } = yield* setup({ held: remark(20) });
      yield* session.pushScreen(shot(15));
      yield* call(12); // end の最大は 20（2 つ目の end は 12）
      expect(calls[0]!.fresh.map((x) => x.end)).toEqual([20, 12]);
      expect(startsOf(calls[0]!)).toEqual([15]);
    }));

  it.effect("変化を 1 度も受けていないセッションは、今までと同じ入力（screens のキーが無い）", () =>
    Effect.gen(function* () {
      const { calls, call, diffs } = yield* setup();
      yield* call(9);
      expect(calls).toHaveLength(1);
      expect("screens" in calls[0]!).toBe(false);
      expect("screens" in diffs()[0]!.input).toBe(false);
    }));

  it.effect("差分更新が失敗した回の画面も処理済み（次の呼び出しに再び載せない）。失敗の diff の入力には添えた画面が残る", () =>
    Effect.gen(function* () {
      const { session, calls, call, diffs } = yield* setup({ fail: (i) => i === 0 });
      yield* session.pushScreen(shot(1));
      yield* call(9);
      yield* call(19);
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
      const r1 = remark(9);
      yield* session.pushScreen(shot(1));
      yield* session.push(r1);
      yield* session.idle;
      const diffs = () => events.filter((e): e is Extract<LogEvent, { type: "diff" }> => e.type === "diff");
      expect(diffs()).toHaveLength(1);
      expect(diffs()[0]!.error).toMatch(/^defect: /);
      expect(diffs()[0]!.input.fresh).toEqual([r1.id]);
      expect(diffs()[0]!.input.screens).toEqual([{ start: 1, image: "0001.0.jpg" }]);
      expect(yield* session.unreflectedRemarks).toEqual([]);
      expect(calls).toHaveLength(0);

      yield* session.push(remark(19));
      yield* session.idle;
      expect(calls).toHaveLength(1);
      expect("screens" in calls[0]!).toBe(false);
      expect(diffs()).toHaveLength(2);
      expect(diffs()[1]!.error).toBeUndefined();
    }));

  it.effect("画面はノードの根拠にならない（マップの形は変わらず、差分更新へ渡す map は今までどおり）", () =>
    Effect.gen(function* () {
      const { session, calls, call } = yield* setup();
      yield* session.pushScreen(shot(1));
      yield* call(9);
      const snapshot = yield* session.snapshot;
      expect(snapshot.nodes.map((n) => n.id)).toEqual([ROOT_ID]);
      expect(Object.keys(calls[0]!).sort()).toEqual(["fresh", "map", "recent", "screens"]);
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

  it.effect("vocab の行を挟んでも、復元した状態は挟まないログと変わらない。直した発言は raw があっても text のまま戻り、補正をかけ直さない", () =>
    Effect.gen(function* () {
      const diff = { type: "diff", input: { recent: [], fresh: ["r1"], nodeCount: 0 }, ops: [], dropped: [] };
      const vocab = { type: "vocab", words: [{ surface: "港南店", romaji: "kounanten", source: "user" }] };
      const corrected = {
        type: "remark",
        remark: { id: "r1", track: "相手", start: 0, end: 5, text: "港南店に行きます" },
        raw: "江南店に行きます",
        words: [{ surface: "江南", romaji: "kounan", location: 0, length: 2 }],
      };
      yield* Schema.decodeUnknownEffect(LogEvent)(vocab);
      const plain = yield* restoreState([start, corrected, diff]);
      const withVocab = yield* restoreState([start, vocab, corrected, diff]);
      expect(withVocab.remarks).toEqual(plain.remarks);
      expect(withVocab.remarks[0]?.text).toBe("港南店に行きます");
      expect(withVocab.round).toBe(plain.round);
      expect(withVocab.map).toEqual(plain.map);
      expect(withVocab.known).toEqual(plain.known);
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

// Issue #643: 画面の文字（OCR の行）。pushScreen の 2 番目の引数で渡した lines は screen の行にだけ残り、差分更新の入力（DiffInput.screens）には載らない
describe("共有画面の文字（lines）", () => {
  const start = { type: "start", title: "定例" };
  it.effect("lines を渡した pushScreen は screen の行に lines を残す。空の配列は空のまま残り、渡さなければ lines のキーは無い", () =>
    Effect.gen(function* () {
      const { session, screenLines } = yield* setup();
      yield* session.pushScreen(shot(1), ["港南店", "Zendesk"]);
      yield* session.pushScreen(shot(2), []);
      yield* session.pushScreen(shot(3));
      yield* session.pushScreen(none(4));

      const lines = screenLines();
      expect(lines.map((l) => l.start)).toEqual([1, 2, 3, 4]);
      expect((lines[0] as { lines?: unknown }).lines).toEqual(["港南店", "Zendesk"]);
      expect((lines[1] as { lines?: unknown }).lines).toEqual([]);
      expect("lines" in lines[2]!).toBe(false);
      expect("lines" in lines[3]!).toBe(false);
    }));

  it.effect("差分更新の入力の screens は画像だけ。lines の文字は DiffInput のどこにも載らない（モデルには画像だけを渡す）", () =>
    Effect.gen(function* () {
      const { session, calls, call } = yield* setup();
      yield* session.pushScreen(shot(1, "first"), ["港南店", "Zendesk"]);
      yield* call(9);

      expect(calls).toHaveLength(1);
      expect(calls[0]!.screens?.map((s) => s.start)).toEqual([1]);
      expect(Object.keys(calls[0]!.screens![0]!).sort()).toEqual(["image", "start"]);
      const serialized = JSON.stringify(calls[0], (_key, value) => (value instanceof Uint8Array ? "<bytes>" : value));
      expect(serialized).not.toContain("港南店");
      expect(serialized).not.toContain("Zendesk");
    }));

  it.effect("lines つきの screen の行も、lines の無い古い screen の行も LogEvent として decode でき、restoreState で戻しても壊れた行にならない", () =>
    Effect.gen(function* () {
      const diff = { type: "diff", input: { recent: [], fresh: ["r1"], nodeCount: 0 }, ops: [], dropped: [] };
      const r1 = { type: "remark", remark: { id: "r1", track: "相手", start: 0, end: 5, text: "発言" } };
      const withLines = { type: "screen", start: 1, image: "0001.0.jpg", lines: ["港南店"] };
      const old = { type: "screen", start: 2, image: "0002.0.jpg" };
      yield* Schema.decodeUnknownEffect(LogEvent)(withLines);
      yield* Schema.decodeUnknownEffect(LogEvent)(old);
      const plain = yield* restoreState([start, r1, diff]);
      const restored = yield* restoreState([start, withLines, old, r1, diff]);
      expect(restored.remarks).toEqual(plain.remarks);
      expect(restored.map).toEqual(plain.map);
    }));

  it.effect("vocab の行は出どころ screen も decode できる", () =>
    Effect.gen(function* () {
      yield* Schema.decodeUnknownEffect(LogEvent)({ type: "vocab", words: [{ surface: "港南店", romaji: "kounanten", source: "screen" }, { surface: "Zendesk", romaji: null, source: "screen" }] });
    }));
});
