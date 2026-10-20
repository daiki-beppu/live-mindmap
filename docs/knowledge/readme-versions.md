# README の 2 つの版

英語の `README.md` と日本語の `README.ja.md` を直すとき、ファイルを移す・分ける PR をマージするときに読む文書。英語版と日本語版を照らす手順と、移動の履歴を残すマージの仕方を書く。どの PR でどちらの版のどの節を直すかの決まりは、AGENTS.md の「README」節にある。決定そのものは仕様 [#1386](https://github.com/daiki-beppu/live-mindmap/issues/1386) と、その元の map [#1380](https://github.com/daiki-beppu/live-mindmap/issues/1380) の子（#1381〜#1384）の解決コメントにある。

- 用語: 無し
- ADR: [0004 live-mindmap は収益化せず、全体を MIT で公開する](../adr/0004-mit-license-no-monetization.md)
- 関連する知識文書: [takt の run](takt-runs.md)

## 英語版の `What you can do` は、承認済みの下書きでなく、その時点の `できること` と 1 項目ずつ照らす

[#1383](https://github.com/daiki-beppu/live-mindmap/issues/1383) で承認された英語の下書きは 14 項目だった。[PR #1392](https://github.com/daiki-beppu/live-mindmap/pull/1392) で `README.ja.md` の `できること` と照らすと、マイクの一時停止（M）、F で変わったことへの切り替え、根拠を辿る、公開の一覧と取り下げ（`cli publish list`・`cli publish withdraw`）の 4 項目が足りず、モデルの選び方の項目には判定のモデル（Jev・Clef）も抜けていた。入った英語版は 18 項目になっている。

英語版の項目を足す・直すときも、下書きや前の版の英語から書き起こさず、日本語版の `できること` を上から読んで過不足を見る。英語版は項目ごとのアンカーを持たない（日本語版の構成を変えないと仕様が決めた）ので、対応は文面で取る。

## 英語版から張るアンカーは、日本語の見出しを小文字にし、空白をハイフンにした形。張り直したら照らす

GitHub は日本語の見出しをそのままアンカーにする。`### Claude の認証` は `#claude-の認証`、`## 差分更新のモデルを選ぶ` は `#差分更新のモデルを選ぶ` になる。英語版が張っているのは `#できること`・`#差分更新のモデルを選ぶ`・`#claude-の認証`・`#ローカルモード`・`#ライブのセッション` の 5 つ。

日本語版の見出しを変えた PR では、リポジトリのルートで次を流し、`MISSING` が出ないことを確かめる。記号を除く規則は入れていないので、記号を含む見出しへ張るときは GitHub の画面でアンカーを確かめる。

```sh
grep -o 'README\.ja\.md#[^)]*' README.md | sed 's/.*#//' | sort -u | while read a; do
  grep '^#' README.ja.md | sed -E 's/^#+ //' | tr 'A-Z ' 'a-z-' | grep -qxF "$a" && echo "ok $a" || echo "MISSING $a"
done
```

## ファイルの移動を `git blame` で辿らせたいなら、移動だけのコミットを分けて rebase でマージする。`git log --follow` は squash でも辿れる

AGENTS.md の既定は squash でのマージだが、[PR #1392](https://github.com/daiki-beppu/live-mindmap/pull/1392) は `git mv README.md README.ja.md` だけのコミットと英語版を書くコミットに分け、rebase でマージした（main の `3bd5550` と `35cde9e`）。PR の本文は「squash だと `git log --follow README.ja.md` で移動前の履歴をたどれない」を理由に挙げていたが、手元で同じ 2 コミットを 1 つに squash して確かめると、`git log --follow` は squash でも移動前のコミットまで辿れた。違いが出たのは `git blame` のほうだった。

| `README.ja.md` の 339 行 | squash | rebase（今の main） |
|---|---|---|
| `git log --follow` | 移動前まで辿れる | 移動前まで辿れる |
| `git blame` | 339 行すべてが squash のコミット | 元のコミットに分かれる（#671 の PR #803 が 97 行など） |
| `git blame -C` | 元のコミットに分かれる | 元のコミットに分かれる |

squash では、同じコミットの中で `README.md` が残って書き換わるので、`README.ja.md` は新しいファイルとして数えられ、copy を探す `-C` を付けないと行の出どころが消える。移すファイルの行ごとの履歴を残したい PR は、移動だけのコミットを先に置き、`gh pr merge <N> --rebase` でマージする。仕様の完了条件に履歴を書くときは、`git log --follow` ではなく `git blame` で確かめる形にする。

## 出典

- 仕様 [#1386](https://github.com/daiki-beppu/live-mindmap/issues/1386)、親 [#1387](https://github.com/daiki-beppu/live-mindmap/issues/1387)
- チケット [#1388](https://github.com/daiki-beppu/live-mindmap/issues/1388)、[PR #1392](https://github.com/daiki-beppu/live-mindmap/pull/1392) の差分と本文
- squash と rebase の比べ方: `4ec3527` から `git merge --squash 35cde9e` したコミットと、今の main の `README.ja.md` で `git log --follow`・`git blame`・`git blame -C` を流した（2026-10-20）
