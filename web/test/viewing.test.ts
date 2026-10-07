import { describe, expect, it } from "vitest";
import { INITIAL_VIEWING, nextCameraOrder, reduceViewing, type CameraCommand, type CameraOrder, type ViewingEvent, type ViewingState, type VisibleTree } from "../src/viewing.ts";

const tree = (currentTopic: string | undefined): VisibleTree => ({
  ids: ["root", "n1", "n2"],
  targets: { root: { x: 0, y: 0 }, n1: { x: 200, y: 0 }, n2: { x: 200, y: 80 } },
  parents: { root: null, n1: "root", n2: "root" },
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

const idle: ViewingEvent = { type: "idle" };
const timeMoved: ViewingEvent = { type: "timeMoved" };
const bothEvents: [string, ViewingEvent][] = [["触らずに 10 秒たった", idle], ["時刻を動かした", timeMoved]];

// 見返し（"review"）かライブかを渡して、出来事の列を同じ状態につなぐ。
const runIn = (scope: "live" | "review", events: [ViewingEvent, VisibleTree][], from: ViewingState = INITIAL_VIEWING) => {
  let state = from;
  const commands: CameraCommand[] = [];
  for (const [event, t] of events) {
    const out = reduceViewing(state, event, t, scope);
    state = out.state;
    commands.push(out.camera);
  }
  return { state, commands };
};

const manualN1: ViewingState = { mode: "manual", topic: "n1" };
const overviewFrom = (from: ViewingState) => run([[key("F"), tree("n1")]], from).state;

describe("reduceViewing: 見返しでは、触らずに 10 秒たつか時刻を動かすと自動に戻る", () => {
  for (const [name, event] of bothEvents) {
    it(`見返しで止めているとき、${name}と自動に戻り、寄せ直す（refocus）`, () => {
      const out = reduceViewing(manualN1, event, tree("n1"), "review");
      expect(out.state).toEqual({ mode: "auto" });
      expect(out.camera).toEqual({ type: "refocus" });
    });
  }

  it("見返しで全体を見ているとき、時刻を動かすと自動に戻り、寄せ直す。前が自動でも人でも同じ", () => {
    for (const from of [INITIAL_VIEWING, manualN1]) {
      const overview = overviewFrom(from);
      expect(overview.mode).toBe("overview");
      const out = reduceViewing(overview, timeMoved, tree("n1"), "review");
      expect(out.state).toEqual({ mode: "auto" });
      expect(out.camera).toEqual({ type: "refocus" });
    }
  });

  it("見返しで全体を見ているとき、触らずに 10 秒たっても何も変えない（hold）。対照として時刻なら戻る", () => {
    const overview = overviewFrom(INITIAL_VIEWING);
    const out = reduceViewing(overview, idle, tree("n1"), "review");
    expect(out.state).toEqual(overview);
    expect(out.camera).toEqual({ type: "hold" });
    expect(reduceViewing(overview, timeMoved, tree("n1"), "review").state).toEqual({ mode: "auto" });
  });

  it("止まる → 触らず戻る → また止まる → 時刻で戻る（戻りは1回きりではない）", () => {
    const { state, commands } = runIn("review", [[moved, tree("n1")], [idle, tree("n1")], [moved, tree("n1")], [timeMoved, tree("n1")]]);
    expect(state).toEqual({ mode: "auto" });
    expect(commands).toEqual([{ type: "hold" }, { type: "refocus" }, { type: "hold" }, { type: "refocus" }]);
  });

  it("戻った後に人が動かすと、また止まる", () => {
    const { state } = runIn("review", [[moved, tree("n1")], [timeMoved, tree("n1")], [moved, tree("n1")]]);
    expect(state).toEqual({ mode: "manual", topic: "n1" });
  });
});

describe("reduceViewing: ライブでは時間でも時刻でも戻らない", () => {
  const states: [string, ViewingState][] = [
    ["止めている", manualN1],
    ["全体を見ている", overviewFrom(INITIAL_VIEWING)],
  ];
  for (const [eventName, event] of bothEvents) {
    for (const [stateName, from] of states) {
      it(`${stateName}とき、${eventName}でも変えず hold（scope 省略・"live" 明示とも）。見返しなら戻る（対照）`, () => {
        const omitted = reduceViewing(from, event, tree("n1"));
        const explicit = reduceViewing(from, event, tree("n1"), "live");
        for (const out of [omitted, explicit]) {
          expect(out.state).toEqual(from);
          expect(out.camera).toEqual({ type: "hold" });
        }
        if (!(stateName === "全体を見ている" && event.type === "idle")) {
          expect(reduceViewing(from, event, tree("n1"), "review").state).toEqual({ mode: "auto" });
        }
      });
    }
  }
});

describe("reduceViewing: 自動のときは、2 つの出来事で何も変わらない", () => {
  for (const scope of ["live", "review"] as const) {
    for (const [name, event] of bothEvents) {
      it(`${scope}: ${name}でも自動のまま、自動で寄せる（follow）`, () => {
        const out = reduceViewing(INITIAL_VIEWING, event, tree("n1"), scope);
        expect(out.state).toEqual({ mode: "auto" });
        expect(out.camera).toEqual({ type: "follow" });
      });
    }
  }
});

describe("reduceViewing: 新しい出来事でも入力を書き換えない", () => {
  it("止めている状態に適用しても、入力の状態と木は変わらず、同じ入力なら同じ出力", () => {
    for (const [, event] of bothEvents) {
      const state: ViewingState = Object.freeze({ mode: "manual", topic: "n1" });
      const t = tree("n1");
      const snapshot = JSON.stringify(t);
      const out = reduceViewing(state, event, t, "review");
      expect(state).toEqual({ mode: "manual", topic: "n1" });
      expect(JSON.stringify(t)).toBe(snapshot);
      expect(reduceViewing(state, event, t, "review")).toEqual(out);
    }
  });
});

// SessionView.dispatch と同じく、出来事の列を reduceViewing に通し、指示を nextCameraOrder で積む。
// shownSeqAfter が true の出来事の後は、描画された（shownSeq が今の番号になる）ものとして扱う
const stackOrders = (
  events: { event: ViewingEvent; tree: VisibleTree; renderedAfter?: boolean }[],
  from: ViewingState,
  scope: "live" | "review" = "review",
) => {
  let state = from;
  let order: CameraOrder = { command: { type: "follow" }, seq: 0 };
  let shownSeq = 0;
  for (const { event, tree: t, renderedAfter } of events) {
    const out = reduceViewing(state, event, t, scope);
    state = out.state;
    order = nextCameraOrder(order, out.camera, shownSeq);
    if (renderedAfter) shownSeq = order.seq;
  }
  return { state, order };
};

describe("nextCameraOrder: 同じ更新内で、まだ描画されていない refocus を follow で上書きしない", () => {
  const refocusThenTimeMoved = (from: ViewingState, renderedBetween: boolean) =>
    stackOrders(
      [
        { event: reflect, tree: tree("n2"), renderedAfter: renderedBetween },
        { event: timeMoved, tree: tree("n2") },
      ],
      from,
    );
  const timeMovedThenReflect = (from: ViewingState, renderedBetween: boolean) =>
    stackOrders(
      [
        { event: timeMoved, tree: tree("n2"), renderedAfter: renderedBetween },
        { event: reflect, tree: tree("n2") },
      ],
      from,
    );

  for (const [name, from] of [["manual", manualN1], ["overview", overviewFrom(manualN1)]] as const) {
    it(`見返しの ${name} で議題が変わる反映の後に時刻が動いても、refocus が保たれる`, () => {
      const out = refocusThenTimeMoved(from, false);
      expect(out.state).toEqual({ mode: "auto" });
      expect(out.order).toEqual({ command: { type: "refocus" }, seq: 1 });
    });

    it(`見返しの ${name} で時刻が動いた後に議題が変わる反映が来ても、refocus が保たれる`, () => {
      const out = timeMovedThenReflect(from, false);
      expect(out.order.command).toEqual({ type: "refocus" });
    });

    it(`間に描画をはさむと、後の follow が通常どおり置き換える（${name}）`, () => {
      expect(refocusThenTimeMoved(from, true).order).toEqual({ command: { type: "follow" }, seq: 2 });
    });
  }

  it("反映を伴わない時刻操作は、止めているとき refocus、自動のとき follow になる", () => {
    expect(stackOrders([{ event: timeMoved, tree: tree("n1") }], manualN1).order).toEqual({ command: { type: "refocus" }, seq: 1 });
    expect(stackOrders([{ event: timeMoved, tree: tree("n1") }], INITIAL_VIEWING).order).toEqual({ command: { type: "follow" }, seq: 1 });
  });

  it("描画前の refocus の後でも、follow 以外（人が動かす）は置き換える。timeMoved は refocus を保つ", () => {
    const moved1 = stackOrders([{ event: reflect, tree: tree("n2") }, { event: moved, tree: tree("n2") }], manualN1);
    expect(moved1.order).toEqual({ command: { type: "hold" }, seq: 2 });
    const kept = stackOrders([{ event: reflect, tree: tree("n2") }, { event: timeMoved, tree: tree("n2") }], manualN1);
    expect(kept.order).toEqual({ command: { type: "refocus" }, seq: 1 });
  });

  it("ライブでは、議題が変わらない限り時刻の出来事で指示が増えても状態は変わらない", () => {
    const out = stackOrders([{ event: timeMoved, tree: tree("n1") }], manualN1, "live");
    expect(out.state).toEqual(manualN1);
    expect(out.order.command).toEqual({ type: "hold" });
  });
});

describe("reduceViewing: E で右の列、C で字幕を出し入れする（カメラの状態とは独立）", () => {
  const toggle = (type: "side" | "captions", over: Partial<{ meta: boolean; ctrl: boolean; alt: boolean }> = {}): ViewingEvent => ({ type, meta: false, ctrl: false, alt: false, ...over });
  const manual: ViewingState = { mode: "manual", topic: "n1" };
  const overview: ViewingState = { mode: "overview", topic: "n1", before: { mode: "manual", topic: "n1" } };
  const cameras = [
    ["自動", INITIAL_VIEWING],
    ["manual", manual],
    ["overview", overview],
  ] as const;
  const FLAG = { side: "sideHidden", captions: "captionsHidden" } as const;
  const hidden = (s: ViewingState, type: "side" | "captions"): ViewingState => ({ ...s, [FLAG[type]]: true });

  it("初めは両方とも出している（隠す印を持たない）", () => {
    expect("sideHidden" in INITIAL_VIEWING).toBe(false);
    expect("captionsHidden" in INITIAL_VIEWING).toBe(false);
  });

  for (const type of ["side", "captions"] as const) {
    it.each(cameras)(`${type}: %s のとき、押すと隠れ、もう一度で出て元の状態に戻る（印が残らない）`, (_name, from) => {
      const hide = reduceViewing(from, toggle(type), tree("n1"));
      expect(hide.state).toEqual(hidden(from, type));
      const show = reduceViewing(hide.state, toggle(type), tree("n1"));
      expect(show.state).toEqual(from);
      expect(FLAG[type] in show.state).toBe(false);
    });

    it.each(["meta", "ctrl", "alt"] as const)(`${type}: %s 付きでは、出ていても隠れていても状態を変えない`, (mod) => {
      for (const [, from] of cameras) {
        expect(reduceViewing(from, toggle(type, { [mod]: true }), tree("n1")).state).toEqual(from);
        const h = hidden(from, type);
        expect(reduceViewing(h, toggle(type, { [mod]: true }), tree("n1")).state).toEqual(h);
      }
    });
  }

  it("E と C は互いの出し入れに触らない", () => {
    const sideHidden = reduceViewing(manual, toggle("side"), tree("n1")).state;
    const both = reduceViewing(sideHidden, toggle("captions"), tree("n1")).state;
    expect(both).toEqual({ ...manual, sideHidden: true, captionsHidden: true });
    expect(reduceViewing(both, toggle("side"), tree("n1")).state).toEqual({ ...manual, captionsHidden: true });
    expect(reduceViewing(both, toggle("captions"), tree("n1")).state).toEqual({ ...manual, sideHidden: true });
  });

  it("キー一覧を開いたままでも、開閉は変えずに出し入れできる", () => {
    const opened: ViewingState = { ...manual, keyList: true };
    expect(reduceViewing(opened, toggle("side"), tree("n1")).state).toEqual({ ...opened, sideHidden: true });
    expect(reduceViewing(opened, toggle("captions"), tree("n1")).state).toEqual({ ...opened, captionsHidden: true });
  });

  it("キー一覧の開閉と Esc は、隠している印を変えない", () => {
    const h: ViewingState = { ...manual, sideHidden: true, captionsHidden: true };
    const help: ViewingEvent = { type: "keyList", meta: false, ctrl: false, alt: false };
    const opened = reduceViewing(h, help, tree("n1")).state;
    expect(opened).toEqual({ ...h, keyList: true });
    expect(reduceViewing(opened, help, tree("n1")).state).toEqual(h);
    expect(reduceViewing(opened, plainEscape, tree("n1")).state).toEqual(h);
  });

  it("Esc（manual なら自動へ戻る Esc も、修飾付きも）では出し入れが変わらない", () => {
    for (const [, from] of cameras) {
      const h: ViewingState = { ...from, sideHidden: true, captionsHidden: true };
      const out = reduceViewing(h, plainEscape, tree("n1"));
      expect(out.state.sideHidden).toBe(true);
      expect(out.state.captionsHidden).toBe(true);
      const mod = reduceViewing(h, { ...plainEscape, meta: true }, tree("n1"));
      expect(mod.state).toEqual(h);
    }
    expect(reduceViewing({ ...manual, sideHidden: true }, plainEscape, tree("n1")).state).toEqual({ mode: "auto", sideHidden: true });
  });

  it("カメラの状態を変える出来事（人の操作・反映・縁の点・キー・見返しの idle / timeMoved）でも出し入れは変わらない", () => {
    const h = (s: ViewingState): ViewingState => ({ ...s, sideHidden: true, captionsHidden: true });
    const keep = (state: ViewingState, event: ViewingEvent, t: VisibleTree, scope: "live" | "review" = "live") => {
      const out = reduceViewing(state, event, t, scope).state;
      expect(out.sideHidden).toBe(true);
      expect(out.captionsHidden).toBe(true);
      return out;
    };
    keep(h(INITIAL_VIEWING), moved, tree("n1"));
    keep(h(INITIAL_VIEWING), reflect, tree("n1"));
    keep(h(manual), reflect, tree("n2")); // 議題が変わって自動へ戻る
    keep(h(manual), { type: "edgeDot", id: "n2" }, tree("n1"));
    keep(h(INITIAL_VIEWING), { type: "key", key: "=", meta: false, ctrl: false, alt: false }, tree("n1"));
    keep(h(manual), { type: "idle" }, tree("n1"), "review");
    keep(h(manual), { type: "timeMoved" }, tree("n1"), "review");
    keep(h(overview), { type: "timeMoved" }, tree("n1"), "review");
  });

  it("隠したまま F → F で戻っても隠したまま。全体を見る前の状態（before）に印は入らず、戻った後に古い印が復活しない", () => {
    const f: ViewingEvent = { type: "key", key: "F", meta: false, ctrl: false, alt: false };
    const start: ViewingState = { ...manual, sideHidden: true };
    const toOverview = reduceViewing(start, f, tree("n1")).state;
    expect(toOverview).toEqual({ mode: "overview", topic: "n1", before: { mode: "manual", topic: "n1" }, sideHidden: true });
    expect(reduceViewing(toOverview, f, tree("n1")).state).toEqual(start);
    // 全体を見ている間に出し直してから戻ると、出た状態で戻る
    const shownAgain = reduceViewing(toOverview, toggle("side"), tree("n1")).state;
    expect(reduceViewing(shownAgain, f, tree("n1")).state).toEqual(manual);
  });

  it.each(cameras)("E / C はカメラの状態（%s）を変えない", (_name, from) => {
    for (const type of ["side", "captions"] as const) {
      const out = reduceViewing(from, toggle(type), tree("n1")).state;
      const { sideHidden: _s, captionsHidden: _c, ...camera } = out;
      expect(camera).toEqual(from);
    }
  });

  it.each(cameras)("E は %s のとき、寄せ直す指示（follow・refocus・fitAll）を出さず、列で切れる分だけずらす指示（shiftIntoView）を出す。出す・隠すの両方で同じ", (_name, from) => {
    const hide = reduceViewing(from, toggle("side"), tree("n1"));
    expect(hide.camera).toEqual({ type: "shiftIntoView" });
    const show = reduceViewing(hide.state, toggle("side"), tree("n1"));
    expect(show.camera).toEqual({ type: "shiftIntoView" });
    for (const c of [hide.camera, show.camera]) expect(["follow", "refocus", "fitAll"]).not.toContain(c.type);
  });

  it.each([
    ["自動", INITIAL_VIEWING, "follow"],
    ["manual", manual, "hold"],
    ["overview", overview, "hold"],
  ] as const)("C は %s のとき、マップの大きさが変わらないので何もしない指示（%s の既定）。寄せ直す指示は出さない", (_name, from, cmd) => {
    const out = reduceViewing(from, toggle("captions"), tree("n1"));
    expect(out.camera).toEqual({ type: cmd });
    expect(["refocus", "fitAll", "shiftIntoView"]).not.toContain(out.camera.type);
  });

  it.each(["meta", "ctrl", "alt"] as const)("%s 付きの E は列を動かさないので、ずらす指示も寄せ直す指示も出さない", (mod) => {
    for (const [, from] of cameras) {
      const out = reduceViewing(from, toggle("side", { [mod]: true }), tree("n1"));
      expect(["follow", "hold"]).toContain(out.camera.type);
    }
  });

  it("入力の状態を書き換えない", () => {
    for (const type of ["side", "captions"] as const) {
      const state: ViewingState = Object.freeze({ mode: "manual", topic: "n1" });
      const out = reduceViewing(state, toggle(type), tree("n1"));
      expect(state).toEqual({ mode: "manual", topic: "n1" });
      expect(out.state).toEqual(hidden(manual, type));
      const frozenHidden: ViewingState = Object.freeze({ mode: "manual", topic: "n1", [FLAG[type]]: true });
      expect(reduceViewing(frozenHidden, toggle(type), tree("n1")).state).toEqual(manual);
      expect(frozenHidden).toEqual(hidden(manual, type));
    }
  });
});

// 矢印での選択用の木。深さ 2 の同じ段は y 順に A1(0) < A2(100) < B1(200) で、A1・A2 は A の子、B1 は B の子（親をまたぐ）。
// 子への移りは y の近さで決まる: root(150) の子は B(200) が A(0) より近く、A(80) の子は A2(100) が A1(0) より近い
const arrowTree = (currentTopic: string | undefined, over: Partial<VisibleTree> = {}): VisibleTree => ({
  ids: ["root", "A", "B", "A1", "A2", "B1"],
  targets: {
    root: { x: 0, y: 150 },
    A: { x: 200, y: 80 },
    B: { x: 200, y: 200 },
    A1: { x: 400, y: 0 },
    A2: { x: 400, y: 100 },
    B1: { x: 400, y: 200 },
  },
  parents: { root: null, A: "root", B: "root", A1: "A", A2: "A", B1: "B" },
  currentTopic,
  ...over,
});
const arrow = (dir: "left" | "right" | "up" | "down", mods: Partial<{ meta: boolean; ctrl: boolean; alt: boolean }> = {}): ViewingEvent => ({
  type: "arrow",
  dir,
  meta: false,
  ctrl: false,
  alt: false,
  ...mods,
});
const click = (id: string): ViewingEvent => ({ type: "select", id });
const selectionOf = (s: ViewingState) => s.selection;
// 選んだ状態を、カメラの状態を指定して作る（byKey は選び方）
const selected = (id: string, byKey: boolean, camera: ViewingState = INITIAL_VIEWING): ViewingState => ({ ...camera, selection: { id, byKey } });

describe("reduceViewing: 矢印の移り先（見せるノードの中で、目標の位置で測る）", () => {
  it.each([
    ["A2", "down", "B1"],
    ["B1", "up", "A2"],
    ["A1", "down", "A2"],
    ["A2", "up", "A1"],
    ["A", "down", "B"],
    ["B", "up", "A"],
  ] as const)("%s で %s を押すと同じ深さの %s へ（親をまたぐ）", (from, dir, to) => {
    const out = reduceViewing(selected(from, true), arrow(dir), arrowTree("A"));
    expect(selectionOf(out.state)).toEqual({ id: to, byKey: true });
  });

  it.each([
    ["A1", "up"],
    ["B1", "down"],
    ["A", "up"],
    ["B", "down"],
  ] as const)("端の %s で %s を押しても動かない（回り込まない）", (from, dir) => {
    const out = reduceViewing(selected(from, true), arrow(dir), arrowTree("A"));
    expect(selectionOf(out.state)).toEqual({ id: from, byKey: true });
  });

  it("同じ深さが 1 つだけのルートは、上下で動かない", () => {
    for (const dir of ["up", "down"] as const) {
      expect(selectionOf(reduceViewing(selected("root", true), arrow(dir), arrowTree("A")).state)?.id).toBe("root");
    }
  });

  it("→ は、子のうち目標の位置の y が今のノードに一番近い子へ（先頭の子ではない）", () => {
    expect(selectionOf(reduceViewing(selected("root", true), arrow("right"), arrowTree("A")).state)?.id).toBe("B"); // root(150): A は 150、B は 50
    expect(selectionOf(reduceViewing(selected("A", true), arrow("right"), arrowTree("A")).state)?.id).toBe("A2"); // A(80): A1 は 80、A2 は 20
    expect(selectionOf(reduceViewing(selected("B", true), arrow("right"), arrowTree("A")).state)?.id).toBe("B1");
  });

  it("→ は、見せるノードにない子（畳んだ中）には入らない。子が見えなければ動かない", () => {
    const t = arrowTree("A", { ids: ["root", "A", "B"] });
    expect(selectionOf(reduceViewing(selected("A", true), arrow("right"), t).state)?.id).toBe("A");
  });

  it("← は親へ。ルートでは動かない", () => {
    expect(selectionOf(reduceViewing(selected("A2", true), arrow("left"), arrowTree("A")).state)?.id).toBe("A");
    expect(selectionOf(reduceViewing(selected("A", true), arrow("left"), arrowTree("A")).state)?.id).toBe("root");
    expect(selectionOf(reduceViewing(selected("root", true), arrow("left"), arrowTree("A")).state)?.id).toBe("root");
  });

  it("端で動かないときも、キーで選んだこと（byKey）とカメラの停止は同じ", () => {
    const out = reduceViewing(selected("A1", false), arrow("up"), arrowTree("A"));
    expect(out.state).toEqual({ mode: "manual", topic: "A", selection: { id: "A1", byKey: true } });
    expect(out.camera).toEqual({ type: "revealNode", id: "A1" });
  });
});

describe("reduceViewing: 選んでいないとき、または選んだノードが見えないときの矢印は、今の議題を選ぶだけ", () => {
  it.each(["left", "right", "up", "down"] as const)("未選択で %s を押すと、その向きには動かず今の議題を選ぶ", (dir) => {
    const out = reduceViewing(INITIAL_VIEWING, arrow(dir), arrowTree("A2"));
    expect(selectionOf(out.state)).toEqual({ id: "A2", byKey: true });
    expect(out.camera).toEqual({ type: "revealNode", id: "A2" });
  });

  it("今の議題が無ければ、ルートを選ぶ", () => {
    for (const dir of ["left", "right", "up", "down"] as const) {
      expect(selectionOf(reduceViewing(INITIAL_VIEWING, arrow(dir), arrowTree(undefined)).state)).toEqual({ id: "root", byKey: true });
    }
  });

  it("今の議題が見せるノードに無いときも、ルートを選ぶ", () => {
    expect(selectionOf(reduceViewing(INITIAL_VIEWING, arrow("down"), arrowTree("gone")).state)?.id).toBe("root");
  });

  it("選んだノードが見せるノードに無い（消えた・畳んだ中）ときも、動かず今の議題を選ぶ", () => {
    const out = reduceViewing(selected("gone", false), arrow("right"), arrowTree("A2"));
    expect(selectionOf(out.state)).toEqual({ id: "A2", byKey: true });
    expect(out.camera).toEqual({ type: "revealNode", id: "A2" });
    const hiddenChild = arrowTree("B", { ids: ["root", "A", "B", "B1"] });
    expect(selectionOf(reduceViewing(selected("A1", true), arrow("up"), hiddenChild).state)?.id).toBe("B");
  });

  it("ルートが今の議題でなく、選んだノードが見えないとき、ルートではなく今の議題を選ぶ", () => {
    expect(selectionOf(reduceViewing(selected("gone", true), arrow("left"), arrowTree("B1")).state)?.id).toBe("B1");
  });

  it("選べるノードが何もないときは、何も変えない", () => {
    const empty: VisibleTree = { ids: [], targets: {}, parents: {}, currentTopic: undefined };
    const out = reduceViewing(INITIAL_VIEWING, arrow("down"), empty);
    expect(out.state).toEqual({ mode: "auto" });
    expect(out.camera).toEqual({ type: "follow" });
  });
});

describe("reduceViewing: ⌘・Ctrl・Option 付きの矢印では何も変わらない", () => {
  for (const mod of ["meta", "ctrl", "alt"] as const) {
    it(`${mod} 付きの矢印は、選択もカメラも変えない（自動は follow、止めているときは hold）`, () => {
      const auto = selected("A1", true);
      const manual: ViewingState = { mode: "manual", topic: "A", selection: { id: "A1", byKey: true } };
      for (const dir of ["left", "right", "up", "down"] as const) {
        const a = reduceViewing(auto, arrow(dir, { [mod]: true }), arrowTree("A"));
        expect(a.state).toEqual(auto);
        expect(a.camera).toEqual({ type: "follow" });
        const m = reduceViewing(manual, arrow(dir, { [mod]: true }), arrowTree("A"));
        expect(m.state).toEqual(manual);
        expect(m.camera).toEqual({ type: "hold" });
      }
      const none = reduceViewing(INITIAL_VIEWING, arrow("down", { [mod]: true }), arrowTree("A"));
      expect(none.state).toEqual({ mode: "auto" });
    });
  }
});

describe("reduceViewing: キーで選ぶとカメラが止まり、クリックで選んでも止まらない", () => {
  it("自動のときの矢印は、人の状態（今の議題を覚える）に移り、選んだノードを画面に入れる指示を出す", () => {
    const out = reduceViewing(INITIAL_VIEWING, arrow("down"), arrowTree("A2"));
    expect(out.state).toEqual({ mode: "manual", topic: "A2", selection: { id: "A2", byKey: true } });
    expect(out.camera).toEqual({ type: "revealNode", id: "A2" });
  });

  it("止めているときの矢印は、止めたまま。覚える議題は今の議題に更新する", () => {
    const from: ViewingState = { mode: "manual", topic: "A", selection: { id: "A1", byKey: true } };
    const out = reduceViewing(from, arrow("down"), arrowTree("B"));
    expect(out.state).toEqual({ mode: "manual", topic: "B", selection: { id: "A2", byKey: true } });
    expect(out.camera).toEqual({ type: "revealNode", id: "A2" });
  });

  it("全体を見ている間の矢印も、人の状態に移る（全体を見る前の状態は捨てる）", () => {
    const from: ViewingState = { mode: "overview", topic: "A", before: { mode: "auto" }, selection: { id: "A1", byKey: false } };
    const out = reduceViewing(from, arrow("down"), arrowTree("A"));
    expect(out.state).toEqual({ mode: "manual", topic: "A", selection: { id: "A2", byKey: true } });
    expect(out.camera).toEqual({ type: "revealNode", id: "A2" });
    expect("before" in out.state).toBe(false);
  });

  it.each([
    ["自動", INITIAL_VIEWING, { type: "follow" }],
    ["manual", { mode: "manual", topic: "A" }, { type: "hold" }],
    ["overview", { mode: "overview", topic: "A", before: { mode: "auto" } }, { type: "hold" }],
  ] as const)("クリックで選ぶと、%s のカメラの状態を変えず、指示は今までどおり（動かさない）", (_name, camera, expected) => {
    const out = reduceViewing(camera as ViewingState, click("A1"), arrowTree("A"));
    expect(out.state).toEqual({ ...camera, selection: { id: "A1", byKey: false } });
    expect(out.camera).toEqual(expected);
  });

  it("クリックで選び直すと、キーで選んだ印（byKey）は外れ、選び直した ID になる", () => {
    const out = reduceViewing(selected("A1", true, { mode: "manual", topic: "A" }), click("B"), arrowTree("A"));
    expect(selectionOf(out.state)).toEqual({ id: "B", byKey: false });
  });

  it("クリックで選んだノードから、矢印で続けられる（クリックのあとの矢印は選んだノードから動く）", () => {
    const { state, commands } = run([[click("A1"), arrowTree("A")], [arrow("down"), arrowTree("A")]]);
    expect(selectionOf(state)).toEqual({ id: "A2", byKey: true });
    expect(state.mode).toBe("manual");
    expect(commands).toEqual([{ type: "follow" }, { type: "revealNode", id: "A2" }]);
  });

  it("キーで選んで止めたあと、クリックで選んでも止まったまま（クリックで自動に戻らない）", () => {
    const { state } = run([[arrow("down"), arrowTree("A")], [click("B"), arrowTree("A")]]);
    expect(state).toEqual({ mode: "manual", topic: "A", selection: { id: "B", byKey: false } });
  });
});

describe("reduceViewing: 選択は右の列の出し入れに触らない", () => {
  it("右の列を隠していても、クリックでもキーでも隠したまま（列を出さない）", () => {
    const hidden: ViewingState = { mode: "auto", sideHidden: true };
    expect(reduceViewing(hidden, click("A1"), arrowTree("A")).state).toEqual({ ...hidden, selection: { id: "A1", byKey: false } });
    expect(reduceViewing(hidden, arrow("down"), arrowTree("A")).state).toEqual({ mode: "manual", topic: "A", sideHidden: true, selection: { id: "A", byKey: true } });
  });

  it("E で出し入れしても、選択は残る", () => {
    const side: ViewingEvent = { type: "side", meta: false, ctrl: false, alt: false };
    const sel = selected("A1", true, { mode: "manual", topic: "A" });
    const hide = reduceViewing(sel, side, arrowTree("A"));
    expect(hide.state).toEqual({ ...sel, sideHidden: true });
    expect(reduceViewing(hide.state, side, arrowTree("A")).state).toEqual(sel);
  });

  it("C と ? でも、選択は残る", () => {
    const sel = selected("A1", true, { mode: "manual", topic: "A" });
    const captions = reduceViewing(sel, { type: "captions", meta: false, ctrl: false, alt: false }, arrowTree("A")).state;
    expect(captions).toEqual({ ...sel, captionsHidden: true });
    const help = reduceViewing(sel, { type: "keyList", meta: false, ctrl: false, alt: false }, arrowTree("A")).state;
    expect(help).toEqual({ ...sel, keyList: true });
    expect(reduceViewing(help, { type: "keyList", meta: false, ctrl: false, alt: false }, arrowTree("A")).state).toEqual(sel);
  });
});

describe("reduceViewing: 選択は他の出来事では外れず、今の議題が変わって自動に戻っても残る", () => {
  const sel = selected("A1", true, { mode: "manual", topic: "A" });

  it("今の議題が変わる反映で自動に戻り（refocus）、選択は残る", () => {
    const { state, commands } = run([[reflect, arrowTree("B")]], sel);
    expect(state).toEqual({ mode: "auto", selection: { id: "A1", byKey: true } });
    expect(commands).toEqual([{ type: "refocus" }]);
  });

  it("同じ状態の上で、矢印 → 議題が変わる反映（自動に戻る）→ 次の矢印、と続けても、選択から続きカメラは選んだノードへ戻る", () => {
    const { state, commands } = run([
      [arrow("down"), arrowTree("A")], // 今の議題 A を選ぶ（manual, topic A）
      [arrow("right"), arrowTree("A")], // A → A2
      [reflect, arrowTree("B")], // 議題が B に変わり自動に戻る。選択 A2 は残る
      [arrow("down"), arrowTree("B")], // A2 → B1。画面の外なら寄せるのは revealNode
    ]);
    expect(commands).toEqual([
      { type: "revealNode", id: "A" },
      { type: "revealNode", id: "A2" },
      { type: "refocus" },
      { type: "revealNode", id: "B1" },
    ]);
    expect(state).toEqual({ mode: "manual", topic: "B", selection: { id: "B1", byKey: true } });
  });

  it("自動に戻った直後の矢印は、今の議題ではなく選んだノードから動く", () => {
    const back = run([[reflect, arrowTree("B")]], sel).state;
    const out = reduceViewing(back, arrow("down"), arrowTree("B"));
    expect(selectionOf(out.state)).toEqual({ id: "A2", byKey: true });
    expect(out.state.mode).toBe("manual");
  });

  it("同じ議題の反映・人の操作・縁の点でも選択は残る", () => {
    expect(selectionOf(reduceViewing(sel, reflect, arrowTree("A")).state)).toEqual({ id: "A1", byKey: true });
    expect(selectionOf(reduceViewing(sel, moved, arrowTree("A")).state)).toEqual({ id: "A1", byKey: true });
    const dot = reduceViewing(sel, { type: "edgeDot", id: "B" }, arrowTree("A")).state;
    expect(selectionOf(dot)).toEqual({ id: "A1", byKey: true });
    expect(dot.mode).toBe("manual");
  });

  it("キー（倍率・Shift+矢印の移動）でも選択は残る", () => {
    for (const k of ["=", "-", "0", "Shift+ArrowLeft", "Shift+ArrowDown"] as const) {
      expect(selectionOf(reduceViewing(sel, key(k), arrowTree("A")).state)).toEqual({ id: "A1", byKey: true });
    }
  });

  it("F で全体を見て、もう一度 F で戻っても選択は残る。全体を見る前の状態（before）には選択を入れない", () => {
    const overview = reduceViewing(sel, key("F"), arrowTree("A")).state;
    expect(overview).toEqual({ mode: "overview", topic: "A", before: { mode: "manual", topic: "A" }, selection: { id: "A1", byKey: true } });
    const back = reduceViewing(overview, key("F"), arrowTree("A")).state;
    expect(back).toEqual(sel);
    const fromAuto = reduceViewing(selected("A1", false), key("F"), arrowTree("A")).state;
    expect(fromAuto).toEqual({ mode: "overview", topic: "A", before: { mode: "auto" }, selection: { id: "A1", byKey: false } });
    expect(reduceViewing(fromAuto, key("F"), arrowTree("A")).state).toEqual(selected("A1", false));
  });

  it("全体を見ている間の反映でも選択は残る", () => {
    const overview = reduceViewing(sel, key("F"), arrowTree("A")).state;
    expect(selectionOf(reduceViewing(overview, reflect, arrowTree("A")).state)).toEqual({ id: "A1", byKey: true });
    expect(selectionOf(reduceViewing(overview, reflect, arrowTree("B")).state)).toEqual({ id: "A1", byKey: true });
  });

  it("見返しの idle・timeMoved で自動に戻っても、選択は残る", () => {
    const idleBack = reduceViewing(sel, { type: "idle" }, arrowTree("A"), "review");
    expect(idleBack.state).toEqual({ mode: "auto", selection: { id: "A1", byKey: true } });
    expect(idleBack.camera).toEqual({ type: "refocus" });
    const moveBack = reduceViewing(sel, { type: "timeMoved" }, arrowTree("A"), "review");
    expect(moveBack.state).toEqual({ mode: "auto", selection: { id: "A1", byKey: true } });
    const overview = reduceViewing(sel, key("F"), arrowTree("A")).state;
    expect(reduceViewing(overview, { type: "timeMoved" }, arrowTree("A"), "review").state).toEqual({ mode: "auto", selection: { id: "A1", byKey: true } });
  });

  it("選んでいないときは selection のフィールドを置かない（全ての出来事で）", () => {
    for (const event of [reflect, moved, plainEscape, key("="), { type: "idle" } as ViewingEvent]) {
      expect("selection" in reduceViewing(INITIAL_VIEWING, event, arrowTree("A")).state).toBe(false);
    }
  });
});

describe("reduceViewing: 選択は Esc でだけ外れる", () => {
  it.each([
    ["自動", selected("A1", false)],
    ["manual", selected("A1", true, { mode: "manual", topic: "A" })],
    ["overview", selected("A1", true, { mode: "overview", topic: "A", before: { mode: "auto" } })],
  ] as const)("%s のとき、修飾なしの Esc で選択が外れる", (_name, from) => {
    const out = reduceViewing(from, plainEscape, arrowTree("A"));
    expect("selection" in out.state).toBe(false);
    expect(out.state).toEqual({ mode: "auto" });
  });

  it("自動のときの Esc は、選択だけを外し、カメラは今までどおり（follow）", () => {
    const out = reduceViewing(selected("A1", false), plainEscape, arrowTree("A"));
    expect(out.state).toEqual({ mode: "auto" });
    expect(out.camera).toEqual({ type: "follow" });
  });

  it("止めているときの Esc は、自動に戻して寄せ直し（refocus）、選択も外す", () => {
    const out = reduceViewing(selected("A1", true, { mode: "manual", topic: "A" }), plainEscape, arrowTree("A"));
    expect(out.state).toEqual({ mode: "auto" });
    expect(out.camera).toEqual({ type: "refocus" });
  });

  it("キー一覧が開いているときの Esc は、一覧を閉じるだけで選択は残る。次の Esc で外れる", () => {
    const opened: ViewingState = { mode: "manual", topic: "A", keyList: true, selection: { id: "A1", byKey: true } };
    const closed = reduceViewing(opened, plainEscape, arrowTree("A"));
    expect(closed.state).toEqual({ mode: "manual", topic: "A", selection: { id: "A1", byKey: true } });
    expect(reduceViewing(closed.state, plainEscape, arrowTree("A")).state).toEqual({ mode: "auto" });
  });

  it.each(["meta", "ctrl", "alt"] as const)("%s 付きの Esc では選択が残る", (mod) => {
    const from = selected("A1", true, { mode: "manual", topic: "A" });
    expect(reduceViewing(from, { ...plainEscape, [mod]: true }, arrowTree("A")).state).toEqual(from);
    const auto = selected("A1", false);
    expect(reduceViewing(auto, { ...plainEscape, [mod]: true }, arrowTree("A")).state).toEqual(auto);
  });

  it("Esc で外したあとの矢印は、未選択と同じく今の議題を選ぶだけ", () => {
    const { state } = run([[arrow("down"), arrowTree("A")], [arrow("down"), arrowTree("A")], [plainEscape, arrowTree("A")], [arrow("down"), arrowTree("A2")]]);
    expect(selectionOf(state)).toEqual({ id: "A2", byKey: true });
  });

  it("Esc で右の列の出し入れや字幕は変わらない", () => {
    const from: ViewingState = { mode: "manual", topic: "A", sideHidden: true, captionsHidden: true, selection: { id: "A1", byKey: true } };
    expect(reduceViewing(from, plainEscape, arrowTree("A")).state).toEqual({ mode: "auto", sideHidden: true, captionsHidden: true });
  });
});

describe("reduceViewing: 選択でも入力を書き換えない", () => {
  it("select・arrow・escape は、入力の状態と木を書き換えず、新しいオブジェクトを返す", () => {
    const state: ViewingState = Object.freeze({ mode: "manual", topic: "A", selection: Object.freeze({ id: "A1", byKey: true }) });
    const t = arrowTree("A");
    const before = JSON.stringify(t);
    for (const event of [click("B"), arrow("down"), arrow("right"), plainEscape]) {
      const out = reduceViewing(state, event, t);
      expect(out.state).not.toBe(state);
    }
    expect(state).toEqual({ mode: "manual", topic: "A", selection: { id: "A1", byKey: true } });
    expect(JSON.stringify(t)).toBe(before);
  });
});
