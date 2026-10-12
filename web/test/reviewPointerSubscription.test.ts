import { Option } from "effect";
import { describe, expect, it } from "vitest";
import { Message as MapSurfaceMessage } from "../src/app/mapSurface/message.ts";
import { makeSubscriptions } from "../src/app/review/subscription.ts";
import { Message } from "../src/app/review/message.ts";
import { plainApp, plainContext, stateAt } from "./reviewHarness.ts";

// 見返しの表示面のポインタ（Issue #826）。何も無い所を押して動かすパンは、押している間だけ文書全体の pointermove・pointerup・pointercancel を受ける Subscription が要る。
// 見返しの Subscription に表示面の pointer が組み込まれていないと、押しても動かせない（stream の中身は mapSurface 側の Subscription が持つ）。
// 開く条件は modelToDependencies で確かめる。ドラッグでビューポートが実際に動くことは、画面の照合の heavy IT（screenCompare.heavy.test.ts）が見る

const subscriptions = makeSubscriptions(plainContext);
const surface = (message: MapSurfaceMessage) => Message.GotMapSurfaceMessage({ message });

// 押している最中（isPressing: true）として開く Subscription の名前。親に包んだ（lift した）Subscription の依存は maybeDependencies の中にある
type Dependencies = { isPressing?: boolean; maybeDependencies?: { _tag: string; value?: { isPressing?: boolean } } };
const isPressing = (dependencies: Dependencies): boolean => (dependencies.maybeDependencies === undefined ? dependencies.isPressing : dependencies.maybeDependencies.value?.isPressing) === true;
const pressing = (model: ReturnType<typeof stateAt>): string[] =>
  Object.entries(subscriptions)
    .filter(([, entry]) => isPressing(entry.modelToDependencies(model) as Dependencies))
    .map(([name]) => name);

describe("見返しの表示面のポインタの Subscription", () => {
  it("何も無い所を押した間だけ、表示面のポインタの Subscription が開く（スライダーを押した間の文書の pointerup とは別）", () => {
    const start = stateAt(plainContext, 100);
    expect(pressing(start)).toEqual([]);
    const pressed = plainApp.update(start, surface(MapSurfaceMessage.PressedMapSurface({ clientX: 100, clientY: 100, button: 0, ctrlKey: false, insideNoPan: false }))).model;
    expect(pressing(pressed)).toHaveLength(1);
    expect(pressing(pressed)).not.toContain("sliderRelease");
    const released = plainApp.update(pressed, surface(MapSurfaceMessage.ReleasedPointer({ ctrlKey: false, metaKey: false }))).model;
    expect(pressing(released)).toEqual([]);
  });

  it("スライダーを押している間は、表示面のポインタの Subscription を開かない", () => {
    const pressedSlider = plainApp.update(stateAt(plainContext, 100), Message.PressedSliderPointer()).model;
    expect(pressing(pressedSlider)).toEqual(["sliderRelease"]);
  });

  // 補間の rAF（Issue #826）。測定済みで反映をまたぐ移動の直後は補間中で、Tick 合計 500 の後に閉じる
  const motionActive = (model: ReturnType<typeof stateAt>): boolean => {
    const dependencies = subscriptions.mapSurfaceAnimationFrame!.modelToDependencies(model) as { maybeDependencies?: { value?: { isActive?: boolean } } };
    return dependencies.maybeDependencies?.value?.isActive === true;
  };

  it("補間している間（motion が Some）だけ、表示面の animationFrame の Subscription が開き、Tick 合計 500 の後に閉じる", () => {
    const measured = plainApp.update(stateAt(plainContext, 100), surface(MapSurfaceMessage.MeasuredMapSurface({ width: 800, height: 600, nodeHeights: { root: 40, n1: 40, n2: 40, n3: 40 } }))).model;
    expect(motionActive(measured)).toBe(false);
    const moved = plainApp.update(measured, Message.ClickedNext()).model;
    expect(Option.isSome(moved.mapSurface.motion)).toBe(true);
    expect(motionActive(moved)).toBe(true);
    const half = plainApp.update(moved, surface(MapSurfaceMessage.TickedAnimationFrame({ deltaMs: 250 }))).model;
    expect(motionActive(half)).toBe(true);
    const done = plainApp.update(half, surface(MapSurfaceMessage.TickedAnimationFrame({ deltaMs: 250 }))).model;
    expect(motionActive(done)).toBe(false);
  });
});
