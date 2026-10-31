# CI の段とジョブの割り方

CI（GitHub Actions）にテストやジョブを足すとき、ジョブの割り方や時間切れを変えるとき、Nightly・Weekly の結果や知らせの issue を見るときに読む文書。今の組み方（段の表・入力・ジョブの一覧・時間切れの値・手元で runner の受け持ちを流すコマンド）は [`docs/agents/checks.md`](../agents/checks.md) の `## CI` にあり、ここではそれを変えるときの判断の基準と実測を書く。

- 用語: 無し
- ADR: 無し（仕様 [#1706](https://github.com/daiki-beppu/live-mindmap/issues/1706) が、workflow の書き換えで戻せるとして起こさないと決めている）。main の修復は [0026](../adr/0026-verify-main-after-merge-without-strict.md)
- 関連する知識文書: [マージと main の修復](merge-and-main-repair.md)、[helper の IT の時間切れ](helper-it-timeouts.md)、[takt の run](takt-runs.md)

## 新しいテストの段は、層（unit・light・heavy）ではなく「結果を何が決めるか」で決める

マージを止めてよいかを決めるのは重さではなく、結果が PR のコードだけで決まるかどうか。コードだけで決まるなら heavy でも PR で全件流し、テスト自身が外から取得するなら `*.external.test.ts`（vitest の project `external`）にして、PR では管理する依存のパスに当たるときだけ流す。`managedClaude`・`managedDeps` の 2 本は heavy の定義を満たすが、2026-10-28 の配布元の遅さでコードと関係なく落ちたので external に移した（[PR #1740](https://github.com/daiki-beppu/live-mindmap/pull/1740)）。e2e は重いが、記録の再生（`--strict-cache`）だけでモデルも資格情報も使わないので、コードだけの側にある。main への push の段に external を置かないのは、外の障害で main が赤くなると「When main goes red」の revert を誤って踏むからだ。

## 時間切れの値は決め方（通常時の p90 の約 3 倍を 5 分単位で切り上げ、最小 5 分）で決め、外から取るステップにはジョブとは別に 5 分を付ける

10/28 に最長 1 時間 56 分待ったのは、ジョブにもステップにも時間切れが無かったからだ（[PR #1730](https://github.com/daiki-beppu/live-mindmap/pull/1730)）。ステップの時間切れがあると、どの取得で止まったかがログに出る。Node は `actions/setup-node` がランナーの toolcache から取る。取り方を変えたら、ジョブのログに `Found in cache @ /opt/hostedtoolcache/node/<版>/x64` が出て、ダウンロードしていないことを確かめる。#1720 で割ったジョブは p90 を測る前の仮の値（最小の 5 分）なので、数本の run の後に決め直す。

## 60 秒の目標にはまだ届いていない。偏りの元は、所要時間を見ずにファイルの並び順の剰余で配ることと、1 本で 60 秒を超える `measureBootstrap.heavy`

`scripts/run-ci-tests.sh` は、テストの一覧をファイル名（heavy は `file:line`）でまとめて番号を振り、その剰余で runner を決める。新しいファイルを足しても設定を書き換えずに済む代わりに、長いファイルが片方に寄ると寄ったままになる。割った後（[PR #1760](https://github.com/daiki-beppu/live-mindmap/pull/1760)）の main の push の run 6 本（2026-10-31、`c8c0949`〜`898b218`）の稼働時間（秒、範囲 / p50）は次のとおり。割る前の ts（型検査・unit・light IT を直列）は 145〜156 / 148、heavy server は 98〜113 / 104 だった。

| ジョブ | 範囲 / p50 |
|---|---|
| 型検査・fallow | 22〜31 / 28 |
| unit | 39〜65 / 57 |
| light IT runner 0（server の半分と web の全件） | 54〜88 / 88 |
| light IT runner 1 | 48〜72 / 61 |
| heavy server 0/2（`measureBootstrap.heavy` だけ） | 57〜72 / 67 |
| heavy server 1/2 | 60〜95 / 83 |
| heavy web 0/3・1/3・2/3 | p50 65・60・72 |
| e2e | 53〜60 / 57 |

light IT の runner 0 は、web の分（約 2 秒）を引いても runner 1 より約 25 秒長い。縮めるなら、まず runner を足すか所要時間で配る形にする。heavy server 0/2 は 1 本のテストなので、割り方では 60 秒に収まらない。選択の仕組み（`vitest related`）を入れ直す条件（checks.md の「When to reconsider changed-test selection」）は「ファイルの中まで割れないとき」で、light IT はまだ配り直す余地があるので当たらない。目標は親 [#1711](https://github.com/daiki-beppu/live-mindmap/issues/1711) の完了条件で、親は開いている。

## 必須の `check` は再利用の workflow の外に置いたまま、中のジョブの結果を `results` の出力で受け取り、欠けたら落とす

`check` を `tests.yml`（`workflow_call`）の中に入れるとチェック名が変わり、ruleset を書き換えることになる。外に置くと呼び出し 1 つ分の結果しか見えないので、`tests.yml` の `results` のジョブが 7 つのジョブの結果を JSON で運び、`check` がキーの集合とそれぞれの結果を確かめる（[PR #1756](https://github.com/daiki-beppu/live-mindmap/pull/1756)）。ジョブを足したら、`results` と `check` の jq のキーの一覧の両方に足す。片方だけだと `check` が落ちる。

同じ PR の古い run は `concurrency` で取り消され、その run の `check` は古い head の SHA に failure を付ける。PR #1730 で空のコミットを push して確かめると、新しい head の run だけが green になり、マージは止まらなかった。古い SHA の赤は無視してよい。

## CI の仕様に「今と同じく」と書くなら、その場で設定ファイルを開いて確かめる。形式仕様の検証は、表と今の workflow の食い違いを見つけない

仕様 #1706 は 2 か所で今の動きを誤って述べていた。「push では helper を今と同じくパスで振り分ける」（実際は push では常に流す）と「キャッシュの保存は push だけ、今の方針のまま」（実際は Playwright・APM・話者モデルは PR でも保存する）。Quint の 13 本の不変条件は通っていたが、モデルが写すのは仕様の表で、workflow ではない。食い違いは「振る舞いを変えない」作り替えの [#1719](https://github.com/daiki-beppu/live-mindmap/issues/1719) で表に出て、takt の run が止まった後、振る舞いを変えない方を優先すると issue に決めてから通った。今も checks.md の段の表は仕様の規則で、その下の注記が今の `check.yml` との違いを書いている。表と注記を揃えるなら、仕様を直すか `check.yml` を変える PR を別に出す。

## Nightly・Weekly の schedule は、予定の時刻から数時間遅れて始まることがある

Nightly の cron は 18:17 UTC（毎時 0 分の混みを避けた）だが、最初の schedule の run（41138129987）の作成は 22:26 UTC で、約 4 時間遅れた。朝の時点で結果が出ている前提で手順を組まない。この run は web の heavy IT で落ち、知らせの issue [#1768](https://github.com/daiki-beppu/live-mindmap/issues/1768) が立った。checks.md の「定期段が落ちたとき」の手順どおり、落ちたジョブだけを流し直して通り、`meeting.mount.heavy` のクリック直後の Enter の揺れと突き止めて [#1783](https://github.com/daiki-beppu/live-mindmap/pull/1783) で直し、原因を書いて閉じた。Weekly は 2026-10-31 の時点でまだ 1 度も走っておらず、`workflow_dispatch` での確かめも済んでいない。最初の run を測ってから、キャッシュなしの準備の時間切れを決め直す（[PR #1759](https://github.com/daiki-beppu/live-mindmap/pull/1759)）。

## 出典

- [CI を PR・main への push・Nightly・Weekly の段に分けたとき](../devlog/2026-10-31.md#ci-stages)
- 仕様 [#1706](https://github.com/daiki-beppu/live-mindmap/issues/1706)（Formal Spec のコメントを含む）、親 [#1711](https://github.com/daiki-beppu/live-mindmap/issues/1711)
- 子 [#1714](https://github.com/daiki-beppu/live-mindmap/issues/1714)・[PR #1730](https://github.com/daiki-beppu/live-mindmap/pull/1730)、[#1716](https://github.com/daiki-beppu/live-mindmap/issues/1716)・[PR #1724](https://github.com/daiki-beppu/live-mindmap/pull/1724)、[#1718](https://github.com/daiki-beppu/live-mindmap/issues/1718)・[PR #1740](https://github.com/daiki-beppu/live-mindmap/pull/1740)、[#1719](https://github.com/daiki-beppu/live-mindmap/issues/1719)・[PR #1756](https://github.com/daiki-beppu/live-mindmap/pull/1756)、[#1720](https://github.com/daiki-beppu/live-mindmap/issues/1720)（before の表のコメント）・[PR #1760](https://github.com/daiki-beppu/live-mindmap/pull/1760)、[#1721](https://github.com/daiki-beppu/live-mindmap/issues/1721)・[PR #1759](https://github.com/daiki-beppu/live-mindmap/pull/1759)、[#1722](https://github.com/daiki-beppu/live-mindmap/issues/1722)・[PR #1766](https://github.com/daiki-beppu/live-mindmap/pull/1766)
- Nightly の知らせ [#1768](https://github.com/daiki-beppu/live-mindmap/issues/1768)、[PR #1783](https://github.com/daiki-beppu/live-mindmap/pull/1783)
