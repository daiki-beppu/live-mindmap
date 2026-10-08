# PROTOTYPE（#491）

捨てる前提。規則で取った語彙の候補に混ざるふつうの語で、誤って直すのを防ぐ手段を比べた。

- `../proto-vocab-correct/main.swift` に `--stop <一覧> --stop-scope <all|kanji|latin>` を足した。一覧に載る区間は直さない（latin は英字の語への書き換えだけ通す）
- 一覧は wordfreq 3.1.1 の `top_n_list('ja', N)`（データは CC BY-SA 4.0）
- `run.sh <手段...>` で jargon（語彙 100・300・1000）と他の 4 会議にかける。`tok.swift` は語のトークン数、`parts.swift` は部品が全部一覧に載る語を落とす
- 結果は `~/live-mindmap-samples/runs/stoplist/`

結論: 区間の守り（上位 5 万語・latin）だけを採る。語彙の側では絞らない。
