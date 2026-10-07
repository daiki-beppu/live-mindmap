import { describe, expect, it } from "vitest";
import { INITIAL_VIEWING, reduceViewing, type CameraCommand, type ViewingEvent, type ViewingState, type VisibleTree } from "../src/viewing.ts";

const tree = (currentTopic: string | undefined): VisibleTree => ({
  ids: ["root", "n1", "n2"],
  targets: { root: { x: 0, y: 0 }, n1: { x: 200, y: 0 }, n2: { x: 200, y: 80 } },
  currentTopic,
});
const plainEscape: ViewingEvent = { type: "escape", meta: false, ctrl: false, alt: false };
const moved: ViewingEvent = { type: "userMoved" };
const reflect: ViewingEvent = { type: "reflect" };

// 同じ状態を出来事の列でつなぐ。
const run = (events: [ViewingEvent, VisibleTree][], from: ViewingState = INITIAL_VIEWING) => {
  let state = from;
  const commands: CameraCommand[] = [];
  for (const [event, t] of events) {
    const out = reduceViewing(state, event, t);
    state = out.state;
    commands.push(out.camera);
  }
  return { state, commands };
};

describe("reduceViewing: 人が動かすと自動のカメラが止まる", () => {
  it("最初は自動で、人が動かすと止まり（hold）、そのときの議題を覚える", () => {
    expect(INITIAL_VIEWING).toEqual({ mode: "auto" });
    const out = reduceViewing(INITIAL_VIEWING, moved, tree("n1"));
    expect(out.state).toEqual({ mode: "manual", topic: "n1" });
    expect(out.camera).toEqual({ type: "hold" });
  });

  it("止まっている間にまた動かしても止まったまま（議題は動かした時点の今の議題）", () => {
    const { state, commands } = run([[moved, tree("n1")], [moved, tree("n1")]]);
    expect(state).toEqual({ mode: "manual", topic: "n1" });
    expect(commands).toEqual([{ type: "hold" }, { type: "hold" }]);
  });

  it("自動のままの反映は、今までどおり自動で寄せる（follow）", () => {
    const out = reduceViewing(INITIAL_VIEWING, reflect, tree("n1"));
    expect(out.state).toEqual({ mode: "auto" });
    expect(out.camera).toEqual({ type: "follow" });
  });
});

describe("reduceViewing: 反映と Esc での戻り", () => {
  it("今の議題が変わらない反映では、止まったまま（hold）。何度届いても戻らない", () => {
    const { state, commands } = run([[moved, tree("n1")], [reflect, tree("n1")], [reflect, tree("n1")]]);
    expect(state).toEqual({ mode: "manual", topic: "n1" });
    expect(commands).toEqual([{ type: "hold" }, { type: "hold" }, { type: "hold" }]);
  });

  it("止まっている間に今の議題が変わる反映で、自動に戻り、寄せ直す（refocus）", () => {
    const { state, commands } = run([[moved, tree("n1")], [reflect, tree("n1")], [reflect, tree("n2")]]);
    expect(state).toEqual({ mode: "auto" });
    expect(commands).toEqual([{ type: "hold" }, { type: "hold" }, { type: "refocus" }]);
  });

  it("今の議題がなくなる反映も、議題が変わったとして自動に戻る", () => {
    const { state, commands } = run([[moved, tree("n1")], [reflect, tree(undefined)]]);
    expect(state).toEqual({ mode: "auto" });
    expect(commands).toEqual([{ type: "hold" }, { type: "refocus" }]);
  });

  it("止まっている間の修飾なしの Esc で、自動に戻り、寄せ直す（refocus）", () => {
    const { state, commands } = run([[moved, tree("n1")], [plainEscape, tree("n1")]]);
    expect(state).toEqual({ mode: "auto" });
    expect(commands).toEqual([{ type: "hold" }, { type: "refocus" }]);
  });

  it("戻った後はまた動かせば止まり、同じ議題の反映では戻らない（戻りは1回きりではない）", () => {
    const { state } = run([[moved, tree("n1")], [plainEscape, tree("n1")], [moved, tree("n1")], [reflect, tree("n1")]]);
    expect(state).toEqual({ mode: "manual", topic: "n1" });
  });

  it("自動のときの Esc は何も変えず、自動で寄せる（follow）", () => {
    const out = reduceViewing(INITIAL_VIEWING, plainEscape, tree("n1"));
    expect(out.state).toEqual({ mode: "auto" });
    expect(out.camera).toEqual({ type: "follow" });
  });
});

describe("reduceViewing: ⌘・Ctrl・Option 付きの Esc は無視する", () => {
  const modifiers: [string, ViewingEvent][] = [
    ["meta", { type: "escape", meta: true, ctrl: false, alt: false }],
    ["ctrl", { type: "escape", meta: false, ctrl: true, alt: false }],
    ["alt", { type: "escape", meta: false, ctrl: false, alt: true }],
  ];

  for (const [name, event] of modifiers) {
    it(`${name} 付きの Esc では止まったまま（hold）。同じ状態から修飾なしの Esc なら戻る`, () => {
      const stopped = run([[moved, tree("n1")]]).state;
      const ignored = reduceViewing(stopped, event, tree("n1"));
      expect(ignored.state).toEqual({ mode: "manual", topic: "n1" });
      expect(ignored.camera).toEqual({ type: "hold" });
      // 対照: ガードがないと、この状態からは戻ってしまう
      const accepted = reduceViewing(stopped, plainEscape, tree("n1"));
      expect(accepted.state).toEqual({ mode: "auto" });
      expect(accepted.camera).toEqual({ type: "refocus" });
    });

    it(`${name} 付きの Esc は、自動のとき何も変えない（follow）`, () => {
      const out = reduceViewing(INITIAL_VIEWING, event, tree("n1"));
      expect(out.state).toEqual({ mode: "auto" });
      expect(out.camera).toEqual({ type: "follow" });
    });
  }

  it("無視した後も、議題が変わる反映では戻る（無視で状態が壊れない）", () => {
    const { state, commands } = run([[moved, tree("n1")], [modifiers[0]![1], tree("n1")], [reflect, tree("n2")]]);
    expect(state).toEqual({ mode: "auto" });
    expect(commands).toEqual([{ type: "hold" }, { type: "hold" }, { type: "refocus" }]);
  });
});

describe("reduceViewing: 純粋な関数", () => {
  it("入力の状態と木を書き換えず、新しいオブジェクトを返す", () => {
    const state: ViewingState = Object.freeze({ mode: "manual", topic: "n1" });
    const t = tree("n2");
    const snapshot = JSON.stringify(t);
    const out = reduceViewing(state, reflect, t);
    expect(out.state).not.toBe(state);
    expect(state).toEqual({ mode: "manual", topic: "n1" });
    expect(JSON.stringify(t)).toBe(snapshot);
    const first = reduceViewing(INITIAL_VIEWING, moved, tree("n1"));
    expect(first.state).not.toBe(INITIAL_VIEWING);
    expect(INITIAL_VIEWING).toEqual({ mode: "auto" });
  });

  it("同じ入力なら同じ出力", () => {
    const state: ViewingState = { mode: "manual", topic: "n1" };
    expect(reduceViewing(state, reflect, tree("n2"))).toEqual(reduceViewing(state, reflect, tree("n2")));
  });
});

type Key = Extract<ViewingEvent, { type: "key" }>["key"];
const key = (k: Key, mods: Partial<{ meta: boolean; ctrl: boolean; alt: boolean }> = {}): ViewingEvent => ({
  type: "key",
  key: k,
  meta: false,
  ctrl: false,
  alt: false,
  ...mods,
});

describe("reduceViewing: キーは人の操作として止め、各指示を出す", () => {
  const cases: [Key, CameraCommand][] = [
    ["=", { type: "zoomBy", factor: 1.25 }],
    ["-", { type: "zoomBy", factor: 1 / 1.25 }],
    ["0", { type: "zoomTo", zoom: 1 }],
    ["Shift+ArrowRight", { type: "pan", dx: 1, dy: 0 }],
    ["Shift+ArrowLeft", { type: "pan", dx: -1, dy: 0 }],
    ["Shift+ArrowDown", { type: "pan", dx: 0, dy: 1 }],
    ["Shift+ArrowUp", { type: "pan", dx: 0, dy: -1 }],
  ];

  for (const [k, command] of cases) {
    it(`${k}: 自動から止まり（議題を覚える）、${command.type} を出す`, () => {
      const out = reduceViewing(INITIAL_VIEWING, key(k), tree("n1"));
      expect(out.state).toEqual({ mode: "manual", topic: "n1" });
      expect(out.camera).toEqual(command);
    });

    it(`${k}: 止まっている間は、その時点の今の議題で止まったまま`, () => {
      const out = reduceViewing({ mode: "manual", topic: "n1" }, key(k), tree("n2"));
      expect(out.state).toEqual({ mode: "manual", topic: "n2" });
      expect(out.camera).toEqual(command);
    });

    it(`${k}: 全体を見ている間に押しても止まった状態になる`, () => {
      const overview = run([[key("F"), tree("n1")]]).state;
      expect(overview.mode).toBe("overview");
      const out = reduceViewing(overview, key(k), tree("n1"));
      expect(out.state).toEqual({ mode: "manual", topic: "n1" });
      expect(out.camera).toEqual(command);
    });
  }
});

describe("reduceViewing: ⌘・Ctrl・Option 付きのキーは無視する", () => {
  const keys: Key[] = ["=", "-", "0", "F", "Shift+ArrowRight"];
  const mods: [string, Partial<{ meta: boolean; ctrl: boolean; alt: boolean }>][] = [
    ["meta", { meta: true }],
    ["ctrl", { ctrl: true }],
    ["alt", { alt: true }],
  ];

  for (const k of keys) {
    for (const [name, m] of mods) {
      it(`${name} 付きの ${k}: 自動では何も変えず follow`, () => {
        const out = reduceViewing(INITIAL_VIEWING, key(k, m), tree("n1"));
        expect(out.state).toEqual({ mode: "auto" });
        expect(out.camera).toEqual({ type: "follow" });
      });

      it(`${name} 付きの ${k}: 止まっている間は変えず hold。修飾なしなら変わる（対照）`, () => {
        const stopped: ViewingState = { mode: "manual", topic: "n1" };
        const ignored = reduceViewing(stopped, key(k, m), tree("n2"));
        expect(ignored.state).toEqual(stopped);
        expect(ignored.camera).toEqual({ type: "hold" });
        expect(reduceViewing(stopped, key(k), tree("n2")).camera).not.toEqual({ type: "hold" });
      });
    }
  }

  it("全体を見ている間の修飾付きの F は無視し、状態を変えず hold", () => {
    const overview = run([[key("F"), tree("n1")]]).state;
    const out = reduceViewing(overview, key("F", { meta: true }), tree("n1"));
    expect(out.state).toEqual(overview);
    expect(out.camera).toEqual({ type: "hold" });
  });
});

describe("reduceViewing: F で全体を見て、もう一度押すと全体を見る前に戻る", () => {
  it("自動で F を押すと全体を見る状態になり、全体を収める（fitAll）", () => {
    const out = reduceViewing(INITIAL_VIEWING, key("F"), tree("n1"));
    expect(out.state.mode).toBe("overview");
    expect(out.camera).toEqual({ type: "fitAll" });
  });

  it("自動 → F → F で自動に戻り、今の議題へ寄せ直す（refocus）", () => {
    const { state, commands } = run([[key("F"), tree("n1")], [key("F"), tree("n1")]]);
    expect(state).toEqual({ mode: "auto" });
    expect(commands).toEqual([{ type: "fitAll" }, { type: "refocus" }]);
  });

  it("人 → F → F で、止めた時点の議題の人の状態に戻り、前の倍率・位置へ戻す（restore）", () => {
    const { state, commands } = run([[key("F"), tree("n2")], [key("F"), tree("n2")]], { mode: "manual", topic: "n1" });
    expect(state).toEqual({ mode: "manual", topic: "n1" });
    expect(commands).toEqual([{ type: "fitAll" }, { type: "restore" }]);
  });

  it("戻った後にまた F を押せば、また全体を見る（1回きりではない）", () => {
    const { state, commands } = run([[key("F"), tree("n1")], [key("F"), tree("n1")], [key("F"), tree("n1")]]);
    expect(state.mode).toBe("overview");
    expect(commands.at(-1)).toEqual({ type: "fitAll" });
  });
});

describe("reduceViewing: 全体を見ている間の反映・Esc", () => {
  const overviewOf = (from: ViewingState = INITIAL_VIEWING) => run([[key("F"), tree("n1")]], from).state;

  it("議題が同じままの反映では全体を見たまま、収め直す（fitAll）。何度届いても戻らない", () => {
    const { state, commands } = run([[reflect, tree("n1")], [reflect, tree("n1")]], overviewOf());
    expect(state.mode).toBe("overview");
    expect(commands).toEqual([{ type: "fitAll" }, { type: "fitAll" }]);
  });

  it("今の議題が変わる反映で、自動に戻り寄せ直す（refocus）。前が人でも自動", () => {
    for (const from of [INITIAL_VIEWING, { mode: "manual", topic: "n1" } as ViewingState]) {
      const out = reduceViewing(overviewOf(from), reflect, tree("n2"));
      expect(out.state).toEqual({ mode: "auto" });
      expect(out.camera).toEqual({ type: "refocus" });
    }
  });

  it("今の議題がなくなる反映も、議題が変わったとして自動に戻る", () => {
    const out = reduceViewing(overviewOf(), reflect, tree(undefined));
    expect(out.state).toEqual({ mode: "auto" });
    expect(out.camera).toEqual({ type: "refocus" });
  });

  it("修飾なしの Esc で自動に戻り、寄せ直す（refocus）。前が人でも自動", () => {
    for (const from of [INITIAL_VIEWING, { mode: "manual", topic: "n1" } as ViewingState]) {
      const out = reduceViewing(overviewOf(from), plainEscape, tree("n1"));
      expect(out.state).toEqual({ mode: "auto" });
      expect(out.camera).toEqual({ type: "refocus" });
    }
  });

  it("修飾付きの Esc は無視し、全体を見たまま hold", () => {
    const overview = overviewOf();
    const out = reduceViewing(overview, { type: "escape", meta: true, ctrl: false, alt: false }, tree("n1"));
    expect(out.state).toEqual(overview);
    expect(out.camera).toEqual({ type: "hold" });
  });

  it("人が動かすと止まった状態になり、動かさない（hold）", () => {
    const out = reduceViewing(overviewOf(), moved, tree("n1"));
    expect(out.state).toEqual({ mode: "manual", topic: "n1" });
    expect(out.camera).toEqual({ type: "hold" });
  });
});

describe("reduceViewing: キーでも入力を書き換えない", () => {
  it("全体を見る状態から F を押しても、入力の状態と木は変わらない", () => {
    const overview = run([[key("F"), tree("n1")]], { mode: "manual", topic: "n1" }).state;
    const frozen = structuredClone(overview);
    const t = tree("n1");
    const snapshot = JSON.stringify(t);
    reduceViewing(overview, key("F"), t);
    expect(overview).toEqual(frozen);
    expect(JSON.stringify(t)).toBe(snapshot);
  });
});

const dot = (id: string): ViewingEvent => ({ type: "edgeDot", id });

describe("reduceViewing: 縁の点を押すと、そのノードへ寄り、人の状態のままになる", () => {
  it("止めているとき、そのノードへ寄る指示（focusNode）が出て、止めたまま（議題は今の議題）", () => {
    const out = reduceViewing({ mode: "manual", topic: "n1" }, dot("n2"), tree("n1"));
    expect(out.camera).toEqual({ type: "focusNode", id: "n2" });
    expect(out.state).toEqual({ mode: "manual", topic: "n1" });
  });

  it("全体を見ているときに押しても、止めた状態になり、そのノードへ寄る", () => {
    const overview = run([[key("F"), tree("n1")]]).state;
    expect(overview.mode).toBe("overview");
    const out = reduceViewing(overview, dot("n2"), tree("n1"));
    expect(out.camera).toEqual({ type: "focusNode", id: "n2" });
    expect(out.state).toEqual({ mode: "manual", topic: "n1" });
  });

  it("寄った後、議題が同じ反映が届いても止めたまま動かさない（hold）。議題が変われば自動に戻る（対照）", () => {
    const { state, commands } = run([[dot("n2"), tree("n1")], [reflect, tree("n1")], [reflect, tree("n1")]], { mode: "manual", topic: "n1" });
    expect(state).toEqual({ mode: "manual", topic: "n1" });
    expect(commands).toEqual([{ type: "focusNode", id: "n2" }, { type: "hold" }, { type: "hold" }]);
    const changed = run([[dot("n2"), tree("n1")], [reflect, tree("n2")]], { mode: "manual", topic: "n1" });
    expect(changed.state).toEqual({ mode: "auto" });
    expect(changed.commands[1]).toEqual({ type: "refocus" });
  });

  it("見えていないノードの点は、状態を変えず動かさない（hold）。見えているノードなら寄る（対照）", () => {
    const manual: ViewingState = { mode: "manual", topic: "n1" };
    const gone = reduceViewing(manual, dot("gone"), tree("n1"));
    expect(gone.state).toEqual(manual);
    expect(gone.camera).toEqual({ type: "hold" });
    expect(reduceViewing(manual, dot("n2"), tree("n1")).camera).toEqual({ type: "focusNode", id: "n2" });
  });

  it("入力の状態と木を書き換えず、同じ入力なら同じ出力", () => {
    const state: ViewingState = Object.freeze({ mode: "manual", topic: "n1" });
    const t = tree("n1");
    const snapshot = JSON.stringify(t);
    const out = reduceViewing(state, dot("n2"), t);
    expect(out.state).toEqual({ mode: "manual", topic: "n1" });
    expect(out.camera).toEqual({ type: "focusNode", id: "n2" });
    expect(state).toEqual({ mode: "manual", topic: "n1" });
    expect(JSON.stringify(t)).toBe(snapshot);
    expect(reduceViewing(state, dot("n2"), t)).toEqual(out);
  });
});

describe("reduceViewing: ? のキー一覧の開閉", () => {
  const help = (over: Partial<{ meta: boolean; ctrl: boolean; alt: boolean }> = {}): ViewingEvent => ({ type: "keyList", meta: false, ctrl: false, alt: false, ...over });
  const manual: ViewingState = { mode: "manual", topic: "n1" };
  const overview: ViewingState = { mode: "overview", topic: "n1", before: { mode: "manual", topic: "n1" } };
  const open = (s: ViewingState): ViewingState => ({ ...s, keyList: true });

  it.each([
    ["自動", INITIAL_VIEWING, "follow"],
    ["manual", manual, "hold"],
    ["overview", overview, "hold"],
  ] as const)("%s のとき ? で開き、カメラの状態は変えず何もしない指示。もう一度で閉じて元の状態に戻る", (_name, from, cmd) => {
    const opened = reduceViewing(from, help(), tree("n1"));
    expect(opened.state).toEqual(open(from));
    expect(opened.camera).toEqual({ type: cmd });
    const closed = reduceViewing(opened.state, help(), tree("n1"));
    expect(closed.state).toEqual(from);
    expect("keyList" in closed.state).toBe(false);
    expect(closed.camera).toEqual({ type: cmd });
  });

  it.each(["meta", "ctrl", "alt"] as const)("%s 付きの ? は無視する（閉じていても開いていても状態は同じ）", (mod) => {
    const closedOut = reduceViewing(manual, help({ [mod]: true }), tree("n1"));
    expect(closedOut.state).toEqual(manual);
    expect(closedOut.camera).toEqual({ type: "hold" });
    const openState = open(manual);
    const openOut = reduceViewing(openState, help({ [mod]: true }), tree("n1"));
    expect(openOut.state).toEqual(openState);
    expect(openOut.camera).toEqual({ type: "hold" });
    expect(reduceViewing(INITIAL_VIEWING, help({ [mod]: true }), tree("n1"))).toEqual({ state: INITIAL_VIEWING, camera: { type: "follow" } });
  });

  it("開いている間の Esc は一覧を閉じるだけ（manual のまま・hold）。次の Esc で自動に戻り refocus", () => {
    const first = reduceViewing(open(manual), plainEscape, tree("n1"));
    expect(first.state).toEqual(manual);
    expect("keyList" in first.state).toBe(false);
    expect(first.camera).toEqual({ type: "hold" });
    const second = reduceViewing(first.state, plainEscape, tree("n1"));
    expect(second.state).toEqual({ mode: "auto" });
    expect(second.camera).toEqual({ type: "refocus" });
  });

  it("overview で開いている間の Esc も閉じるだけ。次の Esc で自動に戻る", () => {
    const first = reduceViewing(open(overview), plainEscape, tree("n1"));
    expect(first.state).toEqual(overview);
    expect(first.camera).toEqual({ type: "hold" });
    expect(reduceViewing(first.state, plainEscape, tree("n1"))).toEqual({ state: { mode: "auto" }, camera: { type: "refocus" } });
  });

  it("自動で開いている間の Esc は閉じるだけ（follow）", () => {
    const out = reduceViewing(open(INITIAL_VIEWING), plainEscape, tree("n1"));
    expect(out.state).toEqual({ mode: "auto" });
    expect("keyList" in out.state).toBe(false);
    expect(out.camera).toEqual({ type: "follow" });
  });

  it("修飾キー付きの Esc では閉じない", () => {
    for (const mod of ["meta", "ctrl", "alt"] as const) {
      const out = reduceViewing(open(manual), { ...plainEscape, [mod]: true }, tree("n1"));
      expect(out.state).toEqual(open(manual));
      expect(out.camera).toEqual({ type: "hold" });
    }
  });

  it("開いたままになる: 同じ議題の反映・議題が変わる反映・人の操作・キー・縁の点", () => {
    const base = open(manual);
    expect(reduceViewing(base, reflect, tree("n1"))).toEqual({ state: base, camera: { type: "hold" } });
    const changed = reduceViewing(base, reflect, tree("n2"));
    expect(changed.state).toEqual(open(INITIAL_VIEWING));
    expect(changed.camera).toEqual({ type: "refocus" });
    expect(reduceViewing(open(INITIAL_VIEWING), moved, tree("n1")).state).toEqual(open(manual));
    expect(reduceViewing(base, { type: "key", key: "=", meta: false, ctrl: false, alt: false }, tree("n1")).state).toEqual(base);
    expect(reduceViewing(base, { type: "edgeDot", id: "n2" }, tree("n1")).state).toEqual(base);
  });

  it("開いたまま F → F で戻っても、開いたまま。全体を見る前の状態（before）に keyList は入らない", () => {
    const f: ViewingEvent = { type: "key", key: "F", meta: false, ctrl: false, alt: false };
    const toOverview = reduceViewing(open(manual), f, tree("n1"));
    expect(toOverview.state).toEqual(open({ mode: "overview", topic: "n1", before: { mode: "manual", topic: "n1" } }));
    const back = reduceViewing(toOverview.state, f, tree("n1"));
    expect(back.state).toEqual(open(manual));
    expect(back.camera).toEqual({ type: "restore" });
  });

  it("閉じた後の F → F では、before に古い開閉が戻らない", () => {
    const f: ViewingEvent = { type: "key", key: "F", meta: false, ctrl: false, alt: false };
    const { state } = run([[help(), tree("n1")], [f, tree("n1")], [help(), tree("n1")], [f, tree("n1")]], manual);
    expect(state).toEqual(manual);
    expect("keyList" in state).toBe(false);
  });

  it("入力の状態を書き換えない", () => {
    const state: ViewingState = Object.freeze({ mode: "manual", topic: "n1" });
    const out = reduceViewing(state, help(), tree("n1"));
    expect(out.state).toEqual(open(manual));
    expect(state).toEqual({ mode: "manual", topic: "n1" });
    const frozenOpen: ViewingState = Object.freeze({ mode: "manual", topic: "n1", keyList: true });
    expect(reduceViewing(frozenOpen, plainEscape, tree("n1")).state).toEqual(manual);
    expect(frozenOpen).toEqual(open(manual));
  });
});
