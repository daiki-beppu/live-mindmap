// キー一覧の行。後の issue（#317〜#320）は、この配列に行を足すだけで一覧に載せられる
export const KEY_LIST = [
  { group: "キー", keys: "Esc", action: "今の議題へ戻る（一覧が開いているときは閉じるだけ）" },
  { group: "キー", keys: "F", action: "全体を見る・もう一度で戻る" },
  { group: "キー", keys: "= / -", action: "拡大・縮小（JIS 配列では ^ でも拡大）" },
  { group: "キー", keys: "0", action: "倍率 1.0 にする" },
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
  { group: "マウス・トラックパッド", keys: "縁の点", action: "そのノードへ寄る" },
] as const;

// マップの右上に重ねる、細い枠だけの一覧（影・バッジなし）
export function KeyList() {
  return (
    <div className="key-list">
      {KEY_LIST.map((row) => (
        <p className="key-list__row" key={`${row.group}:${row.keys}`}>
          <span className="key-list__keys">{row.keys}</span> {row.action}
        </p>
      ))}
    </div>
  );
}
