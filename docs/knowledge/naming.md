# 名前

名前 `live-mindmap` を変える話が出たとき、名前に依存するもの（保存先・環境変数・helper の実行ファイル・画面タイトル）を足す・変えるとき、LIVE の読み方を書くときに読む文書。決定は [#1861](https://github.com/daiki-beppu/live-mindmap/issues/1861)（名前と展開形）と [#1862](https://github.com/daiki-beppu/live-mindmap/issues/1862)（改名しない）にある。

- 用語: 無し
- ADR: 無し（今のままを残す決定で、後からでも同じ費用で変えられる）
- 関連する知識文書: [README の 2 つの版](readme-versions.md)

## 改名で壊れるのは、回数の多い URL ではなく、パスとプロセス間の約束の 5 か所

[#1859](https://github.com/daiki-beppu/live-mindmap/issues/1859) の洗い出しでは、追跡中のファイルに `live-mindmap` が 2,157 回、`LIVE_MINDMAP` が 341 回あった（2026-11-03、`git grep -Io`）。うち 1,661 回は GitHub の URL で、改名してもリダイレクトで残る。ADR・開発ログ・調査は過去の記録なので変えない。壊れるのは次の 5 か所で、詳細は [調査の文書](https://github.com/daiki-beppu/live-mindmap/blob/research/live-mindmap-name-usages/docs/investigations/2026-11-03-live-mindmap-name-usages.md)（`research/live-mindmap-name-usages` ブランチ）にある。

| 場所 | 変えると起きること |
|---|---|
| 保存先 `~/.live-mindmap/` | 過去のセッションと導入済みの依存が見えなくなる |
| 環境変数 `LIVE_MINDMAP_*`（18 種） | 外から渡す設定が黙って効かなくなる |
| helper の実行ファイル名 `live-mindmap-helper`・`live-mindmap-apple` | server が固定のパスで起動するので、起動できなくなる（`server/src/helperPath.ts`・`server/src/appleIntelligence.ts`） |
| web のタイトルと helper の除外 | 片方だけ変えると、自分のマップを会議のタブとして覚える |
| 手元の登録（ghq のパス、Orca の repo、Claude Code の auto memory のフォルダ、案内役の引数 `daiki-beppu/live-mindmap`） | パスや引数で照合するものが止まる |

新しい環境変数やパスを足すと、この表の費用が増える。

## web のタイトル `live-mindmap` は、helper の自画面の除外と対になっている

`web/src/app/{meeting,review,capture}/entry.ts` の `TITLE` と `web/index.html` の `<title>` を、`helper/Sources/HelperCore/ScreenChange.swift` の除外の一覧が同じ文字列で照合している。型でもテストでも結ばれていない。タイトルを変えるときは、除外の一覧も同じ PR で変える。

## LIVE の展開形は、2 つの README の冒頭に 1 か所ずつだけ書く

字句は `**L**IVE **I**nstantly **V**isualizes **E**xchanges` のまま、語も大文字・小文字も変えない。太字で、LIVE の部分が再帰していることを示す。`README.ja.md` にだけ「LIVE は、交わされる言葉をすぐに見える形にする。それをマップにするので LIVE mindmap」の説明を添える。

`GLOSSARY.md`・`package.json` の説明・CLI のヘルプ・web の画面には書かない（仕様 [#1896](https://github.com/daiki-beppu/live-mindmap/issues/1896) の Out of Scope）。`できること` と `What you can do` の対象でもない。

## 名前が 12 文字なことと、再帰が LIVE の部分だけなことは、承知の上の選択なので指摘し直さない

どちらも map [#1857](https://github.com/daiki-beppu/live-mindmap/issues/1857) の条件からは外れるが、利用者がこの名前を選び、#1861 に外れる点として記録した。

## 名前を考え直すなら、今の名前を候補の 1 行に入れ、「〇〇map」の条件から始める

#1857 では 20 個の候補を出して、どれも選ばれなかった。候補の表に今の名前の行が無く、依頼文の欠けた条件（答えは「〇〇map で考えて」）も最後まで埋まっていなかった。経緯は [開発ログ](../devlog/2026-11-04.md#live-acronym) にある。

- 調べ直すときの物差しは [衝突の調査](https://github.com/daiki-beppu/live-mindmap/blob/research/name-collisions/docs/investigations/2026-11-03-name-collisions.md)（深刻さの 3 段、調べる範囲）と [#1887](https://github.com/daiki-beppu/live-mindmap/issues/1887) の [候補の調査](https://github.com/daiki-beppu/live-mindmap/blob/research/name-candidates/docs/investigations/2026-11-03-name-candidates.md) にある。どちらも使い捨てのブランチの文書で、調べたのは 2026-11-03
- 素の npm 名 `live-mindmap` は空いている（2026-11-04 の `npm view` で E404）。公開はしていない。`live`・`lmm`・`lmap`・`livemap` は取られていた
- 日本の商標（J-PlatPat）は、どの候補についても調べていない

## 出典

- [改名の候補を 20 個出してどれも選ばれなかったときの開発ログ](../devlog/2026-11-04.md#live-acronym)
- 仕様 [#1896](https://github.com/daiki-beppu/live-mindmap/issues/1896)、親 [#1907](https://github.com/daiki-beppu/live-mindmap/issues/1907)、子 [#1908](https://github.com/daiki-beppu/live-mindmap/issues/1908)、[PR #1909](https://github.com/daiki-beppu/live-mindmap/pull/1909)
- map [#1857](https://github.com/daiki-beppu/live-mindmap/issues/1857) の本文の編集履歴と、子の [#1858](https://github.com/daiki-beppu/live-mindmap/issues/1858)・[#1859](https://github.com/daiki-beppu/live-mindmap/issues/1859)・[#1860](https://github.com/daiki-beppu/live-mindmap/issues/1860)・[#1861](https://github.com/daiki-beppu/live-mindmap/issues/1861)・[#1862](https://github.com/daiki-beppu/live-mindmap/issues/1862)・[#1887](https://github.com/daiki-beppu/live-mindmap/issues/1887) の解決コメント
