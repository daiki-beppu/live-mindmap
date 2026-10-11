# 判定は判定のモデルを差し替えられる口の後ろに置き、無くても動くようにする

差分更新を早めたり振り分けたりするための判定（選択肢から選ぶだけの答え）は、差分更新とは別の口の後ろに置き、判定のモデルを設定で差し替えて使う。口は System One API の形（`state` と質問の束を渡し、質問ごとに確率の分布・選んだもの・確からしさを受け取る）にそろえ、個々の判定はこの口の上で質問を組み立てる。判定は速さのための足しであり、判定のモデルが無い・鍵が無い・1 回の呼び出しが失敗や時間切れになったときは、その回を判定が無いときと同じ流れで処理する。地図 [#757](https://github.com/daiki-beppu/live-mindmap/issues/757) のチケット [#762](https://github.com/daiki-beppu/live-mindmap/issues/762) で決めた。

ADR 0003 は「サーバーが Jev を呼ぶ」と書いていたが、実装されず、[#84](https://github.com/daiki-beppu/live-mindmap/issues/84) で Jev を Claude の前段のゲートに使う案も見送った。判定を呼ぶかどうかと、どのモデルで呼ぶかは、この ADR で置き換える。

## Considered Options

- **判定ごとの関数（「どのノードの話か」など）を、判定のモデルごとに実装する**: 判定を 1 つ足すたびに、判定のモデルの数だけ書くことになる。Jev と Cloudflare の Clef は同じ System One API で、宛先・モデル名・鍵しか違わないので、汎用の口 1 つで足りる。OpenAI Decisions も質問の形（choice・score・predicate）が近く、predicate を yes-no に、`refusal` を「判定できなかった」に写せば同じ口に収まる
- **判定のモデルが無ければ開始を断る**: 判定が無くても差分更新は動くので、使い方の前提を増やすだけになる

## Consequences

- 設定は差分更新のモデル（`models` / `default`）にそろえ、`judges` / `judge` で選び、`--judge <名前>`・`LIVE_MINDMAP_JUDGE` で上書きする。`--judge off` で判定を使わない。組み込みで `jev`・`clef-flash`・`clef` を持ち、鍵は環境変数から読む。経路は Jev・Clef 共通の `system-one` から始め、OpenAI Decisions は呼べるようになったら別の経路として足す
- 既定の判定のモデルは、まず `jev` にする。Jev と Clef を同じ条件で測った結果で見直す
- ローカルモードの約束（ADR 0014）は変えない。ローカルモードで選べる判定のモデルは live-mindmap が起動する子プロセスだけで、クラウドの判定のモデルを指定すると開始を断る。候補は Apple Intelligence。端末内の Clef-flash は、会議と並べたときのメモリと遅れの心配から見送った
- 判定を使う機能はどれも、判定が無いときの動き（いまの動き）を持つ。時間切れの長さは計測で決める
