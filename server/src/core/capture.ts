// map.png の撮影で、サーバー（Playwright で開く側）と web（描く側）が共有する名前。Node には依存しない。

// サーバーが addInitScript で、撮るスナップショットを入れるグローバル変数の名前。web はこれがあれば撮影用の表示にする
export const CAPTURE_SNAPSHOT_GLOBAL = "__LIVE_MINDMAP_CAPTURE_SNAPSHOT__";

// 撮れる状態（全ノードが測られ、全体を収め終えた）になったら、描画のルートにこの属性を付ける
export const CAPTURE_READY_ATTRIBUTE = "data-capture-ready";

// 全ノードが測られたが、撮影の画面（ビューポート）に全体を収められなかったら、ready の代わりにこの属性を付ける
export const CAPTURE_OVERFLOW_ATTRIBUTE = "data-capture-overflow";
