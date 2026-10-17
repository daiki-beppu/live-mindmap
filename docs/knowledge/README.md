# 知識文書

用語（[GLOSSARY.md](../../GLOSSARY.md)）にも判断（[docs/adr/](../adr/)）にもならない、その領域で作業するときの判断の基準・はまりどころ・確かめ方・実測した数字を、触る領域ごとに置く。時系列の経緯は [開発ログ](../devlog/) と PR にある。

- [エクスポートの公開](export-publish.md): 会議の後にエクスポートを期限つきで外に置く機能の仕様・実装・見直し
- [右の列](side-panel.md): 根拠・TODO・変わったことの段を足す・変える・テストするとき
- [takt の run](takt-runs.md): takt で実装させるとき、run の報告を読むとき

## 取り込み済み

- [会議の後にマップを URL で見せる機能の地図を作ったとき](../devlog/2026-10-16.md#export-publish-map) → [エクスポートの公開](export-publish.md)
- [会議の後にマップを URL で見せる相手を決めたとき](../devlog/2026-10-16.md#export-publish-audience) → [エクスポートの公開](export-publish.md)
- [会議の後に URL で見せる物の既定値を決めたとき](../devlog/2026-10-16.md#export-publish-defaults) → [エクスポートの公開](export-publish.md)
- [会議の後に相手の発言を URL で出すときの確認を決めたとき](../devlog/2026-10-16.md#export-publish-consent) → [エクスポートの公開](export-publish.md)
- 仕様 [#1284](https://github.com/daiki-beppu/live-mindmap/issues/1284) → [右の列](side-panel.md)。用語は捨てた: 仕様が新しい語を足さないと決めている。ADR は捨てた: 段の並びと割合は覆しやすい
- 親 [#1286](https://github.com/daiki-beppu/live-mindmap/issues/1286) → 捨てた: 仕様と完了条件の写しで、新しい学びが無い
- チケット [#1287](https://github.com/daiki-beppu/live-mindmap/issues/1287)・[PR #1292](https://github.com/daiki-beppu/live-mindmap/pull/1292) の差分 → [右の列](side-panel.md)
- #1287 の takt の run（`20261017-060712-implement-using-only-the-files-sugyi4`）の trace と reports → [右の列](side-panel.md)、[takt の run](takt-runs.md)。説明コメントの重複の指摘（後で根拠なしとされた）は捨てた: 結論が出ず、作業の基準にならない。案内役を通しで流した最初の題材だったことは捨てた: 案内役は dotfiles の側の話
