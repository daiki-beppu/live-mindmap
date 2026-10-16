// キーの表（Issue #822）。Subscription が受けるバインディングと、キーの一覧の行を、この 1 つの表から画面で絞って作る。
// 行を 1 つ足し引きすれば、登録と一覧が同時に変わる（片方だけを変えられない）。
// 一覧の文言と順はReact 版（KeyList、Issue #829 で削除）から変えない。「マウス・トラックパッド」の行は、キーの行と同じ形の静的な表（POINTER_ROWS）で、受けるバインディングを持たない
import { Schema } from "effect";

// 押されたキーの種類。バインディングが複数あっても（= と ^ など）、同じ意味なら同じ KeyId にする。意味は update が決める
export const KeyId = Schema.Literals([
  "Escape",
  "F",
  "=",
  "-",
  "0",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Enter",
  "Z",
  "Shift+ArrowLeft",
  "Shift+ArrowRight",
  "Shift+ArrowUp",
  "Shift+ArrowDown",
  "E",
  "C",
  "?",
  "Space",
  "K",
  "J",
  "L",
  ",",
  ".",
  "<",
  ">",
  "Home",
  "End",
  "M",
]);
export type KeyId = typeof KeyId.Type;

// 会議中・見返し（音声なし）・見返し（音声つき）。M は会議中（自分の休止）と音声つきの見返し（ミュート）だけで、意味が別
export type Screen = "live" | "review" | "reviewAudio";

// keys は foldkit の書き方（"Shift+=" "Shift+Plus" "Space" など。+ のキーは Plus）。Shift は厳密に照合されるので、Shift が要る字（JIS の =・US の +・? < >）は Shift 付きの行を別に持つ
export type Binding = { readonly keys: string; readonly key: KeyId };

export type KeyRow = {
  readonly keys: string;
  readonly action: string;
  readonly screens: readonly Screen[];
  readonly bindings: readonly Binding[];
};

const ALL: readonly Screen[] = ["live", "review", "reviewAudio"];
const REVIEW: readonly Screen[] = ["review", "reviewAudio"];
const AUDIO: readonly Screen[] = ["reviewAudio"];
const LIVE: readonly Screen[] = ["live"];

const bind = (key: KeyId, ...keys: readonly string[]): readonly Binding[] => keys.map((k) => ({ keys: k, key }));

export const KEY_ROWS: readonly KeyRow[] = [
  { keys: "Esc", action: "今の議題へ戻る（一覧が開いているときは閉じるだけ）", screens: ALL, bindings: bind("Escape", "Escape") },
  { keys: "F", action: "全体を見る・もう一度で変わったところへ寄る", screens: ALL, bindings: bind("F", "F") },
  {
    keys: "= / -",
    action: "拡大・縮小（JIS 配列では ^ でも拡大）",
    screens: ALL,
    // JIS の ^ と US の + でも拡大が効く。Shift 付きの = は JIS の Shift + -
    bindings: [...bind("=", "=", "Shift+=", "^", "Shift+Plus"), ...bind("-", "-")],
  },
  { keys: "0", action: "倍率 1.0 にする", screens: ALL, bindings: bind("0", "0") },
  {
    keys: "← → ↑ ↓",
    action: "ノードを選ぶ（← 親・→ 縦に近い子・↑↓ 同じ深さの上下。Esc で外す）",
    screens: ALL,
    bindings: [...bind("ArrowLeft", "ArrowLeft"), ...bind("ArrowRight", "ArrowRight"), ...bind("ArrowUp", "ArrowUp"), ...bind("ArrowDown", "ArrowDown")],
  },
  { keys: "Enter", action: "選んだ議題・論点を開く・畳む（今の議題とその祖先には効かない。Esc で元に戻る）", screens: ALL, bindings: bind("Enter", "Enter") },
  { keys: "Z", action: "選んだノードと子孫が収まるまで寄る（選んでいないときは何もしない）", screens: ALL, bindings: bind("Z", "Z") },
  {
    keys: "Shift + 矢印",
    action: "画面の 1/3 ずつ移動する",
    screens: ALL,
    bindings: [
      ...bind("Shift+ArrowLeft", "Shift+ArrowLeft"),
      ...bind("Shift+ArrowRight", "Shift+ArrowRight"),
      ...bind("Shift+ArrowUp", "Shift+ArrowUp"),
      ...bind("Shift+ArrowDown", "Shift+ArrowDown"),
    ],
  },
  { keys: "E", action: "右の列（変わったこと・根拠）を出す・隠す", screens: ALL, bindings: bind("E", "E") },
  { keys: "C", action: "字幕を出す・隠す", screens: ALL, bindings: bind("C", "C") },
  { keys: "?", action: "このキー一覧を開閉する", screens: ALL, bindings: bind("?", "?", "Shift+?") },
  { keys: "M", action: "自分を休止・再開", screens: LIVE, bindings: bind("M", "M") },
  { keys: "Space・K", action: "進める・止める", screens: REVIEW, bindings: [...bind("Space", "Space"), ...bind("K", "K")] },
  { keys: "J / L", action: "10 秒戻る・進む", screens: REVIEW, bindings: [...bind("J", "J"), ...bind("L", "L")] },
  { keys: ", / .", action: "反映 1 つ戻る・進む", screens: REVIEW, bindings: [...bind(",", ","), ...bind(".", ".")] },
  { keys: "< / >", action: "速さを 1 段下げる・上げる", screens: REVIEW, bindings: [...bind("<", "<", "Shift+<"), ...bind(">", ">", "Shift+>")] },
  { keys: "Home / End", action: "最初・最後の時点へ", screens: REVIEW, bindings: [...bind("Home", "Home"), ...bind("End", "End")] },
  { keys: "M", action: "ミュート・戻す", screens: AUDIO, bindings: bind("M", "M") },
];

const pointer = (keys: string, action: string): KeyRow => ({ keys, action, screens: ALL, bindings: [] });

export const POINTER_ROWS: readonly KeyRow[] = [
  pointer("スクロール", "縦横に移動する"),
  pointer("何もないところをドラッグ", "移動する"),
  pointer("⌘/Ctrl + スクロール・ピンチ", "拡大・縮小"),
  pointer("⌘/Ctrl + Shift + スクロール", "縦か横の一方だけに移動する"),
  pointer("⌘/Ctrl + クリック / + Option", "押したところを中心に拡大 / 縮小する"),
  pointer("ノードのクリック", "根拠を出す"),
  pointer("隠れた数の丸・開いたノードの小さな丸", "押すと開く・畳む（小さな丸は、人が開いたノードにホバーしたときだけ出る）"),
  pointer("縁の点", "そのノードへ寄る"),
];

// 一覧の行: その画面で効くキーの行 → マウス・トラックパッドの行
export const keyListRows = (screen: Screen): readonly KeyRow[] => [...KEY_ROWS, ...POINTER_ROWS].filter((row) => row.screens.includes(screen));

// Subscription が受けるバインディング: 一覧の行と同じ行から導く
export const bindingsOf = (screen: Screen): readonly Binding[] => keyListRows(screen).flatMap((row) => row.bindings);
