// 試作（Issue #736）: キー一覧の行と速さのメニューの文言。今の画面では KeyList.tsx・ReviewControls.tsx（React の部品）にあり、
// import すると React と @videojs/react が束ねに入るので、試作では写して持つ（既存のファイルは変えない約束のため）
export const KEY_LIST = [
  { group: "キー", keys: "Esc", action: "今の議題へ戻る（一覧が開いているときは閉じるだけ）" },
  { group: "キー", keys: "F", action: "全体を見る・もう一度で戻る" },
  { group: "キー", keys: "= / -", action: "拡大・縮小（JIS 配列では ^ でも拡大）" },
  { group: "キー", keys: "0", action: "倍率 1.0 にする" },
  { group: "キー", keys: "← → ↑ ↓", action: "ノードを選ぶ（← 親・→ 縦に近い子・↑↓ 同じ深さの上下。Esc で外す）" },
  { group: "キー", keys: "Enter", action: "選んだ議題・論点を開く・畳む（今の議題とその祖先には効かない。Esc で元に戻る）" },
  { group: "キー", keys: "Z", action: "選んだノードと子孫が収まるまで寄る（選んでいないときは何もしない）" },
  { group: "キー", keys: "Shift + 矢印", action: "画面の 1/3 ずつ移動する" },
  { group: "キー", keys: "E", action: "右の列（変わったこと・根拠）を出す・隠す" },
  { group: "キー", keys: "C", action: "字幕を出す・隠す" },
  { group: "キー", keys: "?", action: "このキー一覧を開閉する" },
  { group: "マウス・トラックパッド", keys: "スクロール", action: "縦横に移動する" },
  { group: "マウス・トラックパッド", keys: "何もないところをドラッグ", action: "移動する" },
  { group: "マウス・トラックパッド", keys: "⌘/Ctrl + スクロール・ピンチ", action: "拡大・縮小" },
  { group: "マウス・トラックパッド", keys: "⌘/Ctrl + Shift + スクロール", action: "縦か横の一方だけに移動する" },
  { group: "マウス・トラックパッド", keys: "⌘/Ctrl + クリック / + Option", action: "押したところを中心に拡大 / 縮小する" },
  { group: "マウス・トラックパッド", keys: "ノードのクリック", action: "根拠を出す" },
  { group: "マウス・トラックパッド", keys: "隠れた数の丸・開いたノードの小さな丸", action: "押すと開く・畳む（小さな丸は、人が開いたノードにホバーしたときだけ出る）" },
  { group: "マウス・トラックパッド", keys: "縁の点", action: "そのノードへ寄る" },
] as const;

export const REVIEW_KEY_LIST = [
  { group: "キー", keys: "Space・K", action: "進める・止める" },
  { group: "キー", keys: "J / L", action: "10 秒戻る・進む" },
  { group: "キー", keys: ", / .", action: "反映 1 つ戻る・進む" },
  { group: "キー", keys: "< / >", action: "速さを 1 段下げる・上げる" },
  { group: "キー", keys: "Home / End", action: "最初・最後の時点へ" },
] as const;

export const AUDIO_KEY_LIST = [{ group: "キー", keys: "M", action: "ミュート・戻す" }] as const;

const rateOptionLabel = (rate: number, duration: number) => `${rate} 倍（${Math.round(duration / 60)} 分を ${(Math.round((duration / rate / 60) * 10) / 10).toFixed(1)} 分で）`;
export const rateItemLabel = (rate: number, duration: number, timesOnly: boolean) => (timesOnly ? `${rate} 倍` : rateOptionLabel(rate, duration));
