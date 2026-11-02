# Issue #1833 検証報告

2026-11-02 JST、PR #1853 の修正工程で取得した結果。以下の初回検証では既存の実装・テストを変更していない。過去runの報告に対応する原JSON・manifestを回収できなかったため、現在版で検証し直した。後続のhelper調査とテストの失敗診断の変更は末尾に記録する。

- 対象コード: `10f4a913beea7078d6c1f9b75143313ea28e8a75`
- 比較元: 今回のPR base ref `refs/takt/pr-base/main`、`b5275179e6386057b68e7e480809c12592b6ac21`
- 検証開始時のworking treeは変更なし。終了時も既存追跡ファイルのSHA-256が開始時のmanifestと全件一致した。
- [原データ・実行ログ・manifest](./evidence.tar.gz)。展開後の `source-manifest.json` が対象版、`comparison-manifest.json` が比較元と採取ツールのハッシュを記録する。ログの作業場所は `$REPO`、ホームは `$HOME` に置換している。

## R-001 表示比較の証跡回収と報告

比較元のgit archiveを検証用コピーへ展開し、両版それぞれのlockfileで `pnpm install --frozen-lockfile` を実行した。今回のbaseにはTailwindがあり、対象版にはない。ブラウザ補助コードと入力fixtureは両版で同一だった。

削除済みの `web/scripts/css-migration/capture.mjs` と `compare.mjs` は、比較元コミットから検証用コピーへ一時復元し、変更せず使用した。実際のソースから見返しHTMLをビルドし、会議中は各版のwebをViteで起動した。採取後に検証用コピーを削除した。照合ツールは製品のソースへ戻していない。

環境はmacOS arm64、Node `v26.13.0`、pnpm `12.11.2`、managed Chromium `153.0.8010.12`。locale `ja-JP`、timezone `Asia/Tokyo`、light。比較元、対象版の順に同じMacで採取した。`document.fonts.ready`、カメラの安定、フォーカス解除、アニメーション終了を待ち、全要素のcomputed style・表示テキスト・矩形を採取した。

| 状態 | 1280×800 | 390×844 |
|---|---:|---:|
| 見返し初期 | 166要素 | 109要素 |
| 速さメニュー表示 | 182要素 | 125要素 |
| キー一覧表示 | 217要素 | 160要素 |
| 畳んだノード | 166要素 | 109要素 |
| 開いたノード | 176要素 | 119要素 |
| 会議中の確定済み字幕 | 93要素 | 47要素 |
| 会議中の字幕と3種類の知らせ | 96要素 | 50要素 |
| 見返しの右の列 | 174要素 | 169要素 |
| 会議中の根拠表示 | 104要素 | 97要素 |
| 会議中のTODO・根拠表示 | 70要素 | 70要素 |

390pxは `NARROW_QUERY` の768px以下に含まれる。20場面・2,499要素は両版で同数。

| 生差分 | before | after | 件数 | 理由 |
|---|---|---|---:|---|
| `style.--font-weight-semibold` | `600` | 不在 | 2,499 | Issue #1833の削除指定 |
| `style.--spacing` | `1px` | 不在 | 2,499 | Issue #1833の削除指定 |
| その他のcomputed style・表示テキスト・要素対応 | — | — | 0 | 一致 |
| 矩形の差が0.5pxを超えるもの | — | — | 0 | 許容差内 |

比較器は差分を除外せず終了1。生差分4,998件を `diff.json` にすべて保存した。`before.json`・`after.json` は全要素の採取データ、`diff-summary.json` は集計、`capture-*.status.json`・`compare.status.json` はコマンドと終了状態を持つ。指定2変数以外の差分はない。

再実行時は上記baseから元の採取・比較スクリプトを検証用コピーへ取り出し、READMEの手順で両版を採取する。実行コマンドの引数は各status JSONに残している。判定規則はcomputed styleの厳密比較と矩形の0.5px許容で、変更していない。

## R-002 CSS検査の正常・拒否結果の報告

現在版の `web/src`・`web/scripts`・`server/scripts` を隔離コピーへ複製し、同じ入口 `node web/scripts/check-css.ts` を実行した。ケースごとに一時変更を復元した。詳細は `checker-cases.json`。

| 入力 | 終了コード | 診断 |
|---|---:|---|
| 正常ソース | 0 | なし |
| `evidence__kind` と同じ文字列に `probe__undefined1833` を1語追加 | 1 | `web/src/app/sidePanel/main.ts:13`: CSSにクラスがない |
| `.probe__unused1833 { display: block; }` を1規則追加 | 1 | `web/src/styles.css:292`: 未使用のクラス |
| `.layout` に `color: var(--color-white)` を追加 | 0 | なし |
| 同じ宣言の値だけ `#fff` に変更 | 1 | `web/src/styles.css:25`: トークンと同じhex `#fff` |
| `.layout` に `box-shadow: none` を追加 | 0 | なし |
| 同じ宣言の値だけ `0 1px 2px black` に変更 | 1 | `web/src/styles.css:25`: box-shadowはnoneだけ |
| 全ケース復元後 | 0 | なし |

隔離コピー内の全ファイルが元ソースとバイト単位で一致したことを確認してからコピーを削除した。一時違反を本体へ入れていない。正常ソースの許可と、4種類それぞれの診断・非0終了を確認した。常設テスト・許可一覧・検査仕様の変更はない。

## R-003 検証層の証跡整理と不足分の実施

各コマンドはリポジトリルートから、現在のpackage scriptsを使って実行した。timeout・retry・並行度・対象の設定は変更していない。

| 実行内容 | 結果 | ログ |
|---|---|---|
| `bash helper/scripts/build-webrtc-apm.sh` | 終了0 | `apm.log` |
| `bash helper/scripts/fetch-speaker-models.sh` | 終了0 | `speaker-models.log` |
| `pnpm --filter @live-mindmap/server deps:install chromium` | 終了0 | `chromium.log` |
| `pnpm typecheck` | 終了0。server・web・helper・e2eと末尾のfallowを実行。fallowは0 above threshold | `typecheck.log` |
| `pnpm test` | **終了1**。server 134ファイル・3,130件、web 54ファイル・1,884件は成功。helperのNode検査51件は成功。Swift unit 571件・108 suiteのうち1件失敗 | `unit.log` |
| `pnpm test:it` | 終了0。server 67ファイル・1,195件、web 6ファイル・49件、helper 162件・20 suiteが成功 | `light-it.log` |
| `pnpm --filter @live-mindmap/web test:it:heavy test/review.mount.heavy.test.ts test/meeting.mount.heavy.test.ts` | 終了0。指定2ファイル・64件成功 | `web-heavy.log` |
| `pnpm --filter @live-mindmap/server test:it:heavy test/reviewBuild.heavy.test.ts` | 終了0。指定1ファイル・1件成功 | `server-heavy.log` |
| `pnpm --filter @live-mindmap/web test:it test/reviewControls.it.test.ts` | 終了0。指定1ファイル・3件成功 | `review-controls.log` |

各ログと同名の `*.status.json` が実際のコマンド、JSTの開始・終了日時、終了コードを記録する。`pnpm typecheck` の診断に警告はあるが、終了コードは0だった。

unitで失敗したのは `helper/Tests/HelperCoreTests/RunAudioTests.swift:1015` の `myRecordingFailureEndsRunWhileMicrophoneIsOpen`。録音出力を失敗させ、マイク入力を開いたままrunの失敗伝播を待つテストで `DeadlineExceeded()` が記録された。失敗原因は未確認。helperの累積PR差分はないが、これだけで失敗を無関係・一過性とは判定しない。再試行、テスト削除、期待値変更、timeout延長はしていない。

## 初回の完了条件と残る事項

R-001とR-002の検証・報告成果物は補完した。R-003も全指定層の対象・結果・対象版を記録したが、unitの成功条件は未成立。成功させるための変更を今回の証跡補完の範囲へ追加せず、修正計画へ差し戻す。

CSS更新が同じ開発画面へ届くことの実表示確認は、裁定どおりfinal-gateへ持ち越す。今回の静的表示比較をその代替証拠にはしていない。

編集後セルフスキャンの対象はこの報告と証跡アーカイブだけ。実行module、import・export・callee・call site、mock/double、分類済みtestの変更はない。元の追跡ソース全件のSHA-256一致、検証用コピーの削除、リンク先とアーカイブの存在、`git diff --check` を確認した。commit・push・stagingは行っていない。

## R-003 後続のhelper unit調査

初回の `evidence.tar.gz` は変更せず保持した。SHA-256は `796c4f479ed5087b374fcbc3679c648b25c6c17c4a75adaf01d13bb7940c321d`。調査開始時にmanifestの984ファイルが現在版と一致することを確認した。

対象は同じHEADの作業コピー。既存の開いたマイク、音の値4・hostTime100、録音失敗設定、`within`の既定5秒を保持した。一時的にテストとfixtureへ段階別の診断を追加し、音受信・録音出力失敗・run結果・stop・finishの到達順と経過時間を記録した。本番の録音・失敗伝播は変更していない。

| 調査実行 | 結果 | 対象テストの観測 |
|---|---|---|
| `pnpm --filter @live-mindmap/helper test`、段階別診断あり | 終了0。helper Swift unit 571件成功 | 音投入後、約0.85秒で録音出力失敗、約0.86秒でrunが`myRecording`で失敗。stop後、約0.88秒でfinish完了 |
| `pnpm test`、同じ段階別診断あり | 終了0。server 3,130件・web 1,884件・helper Swift unit 571件成功 | 約1.76秒で録音出力失敗、約1.77秒でrunが`myRecording`で失敗。stop後、約1.79秒でfinish完了 |

比較した条件はhelper単独の実行と、元のルート入口で他packageのunitも動く実行。runnerの並行度・timeout・retryは変更していない。両実行でマイクをstopする前に録音エラーがrunへ届き、停止後の録音終了を確認できた。ただし初回の期限切れは再現しておらず、どちらの待機で失敗したかも初回ログからは復元できない。これらの成功だけで実行時の負荷、一過性、録音実装の欠陥、テスト同期の問題のいずれかを原因と確定しない。

一時的な段階別ログとfixtureへの診断コールバックは除去した。最終差分は `helper/Tests/HelperCoreTests/RunAudioTests.swift` の対象テストで、`DeadlineExceeded`の発生時にrun待機とstop後のfinish待機を区別し、既存observationsを失敗診断へ含めて同じエラーを再送出する変更だけ。期待する`AudioFailure.myRecording`、停止順、録音終了のassertion、期限を維持した。

最終コードで `pnpm --filter @live-mindmap/helper test` を実行し、終了0、helper Swift unit 571件成功を確認した。helperのtypecheckと層検査もこのpackage script内で成功した。診断実行と最終コードの検証を混同せず、初回のルートunit失敗は残す。成功するまで繰り返す実行は行っていない。

[追加調査の証跡](./helper-unit-investigation.tar.gz)には3実行のログ・status、段階別診断のパッチと対象ファイルのハッシュ、最終ソースmanifestを保存した。初回と同じくログの作業場所・ホームを置換している。初回の表示比較とCSS検査に関係するソースは変更していないため、R-001・R-002の原証跡は再利用できる。その他の初回成功層も、実行コードと対象テストを変更していない範囲の証拠として保持する。

セルフスキャンでは一時診断の識別子を再検索し、fixture・本番コードが元の内容へ戻り、元の984ファイルとの差が対象unitテスト1ファイルだけであることを確認した。import・export・signatureの変更はなく、対応するtest doubleは同じファイルの `RunAudioFixture` と `RunTranscriber`。最終helper package testでこのファイルを含むunit全体を実行した。`git diff --check`も成功した。

初回失敗の原因確定は未完了。追加の成功を根拠に初回失敗を免除せず、保存した証跡と最小の失敗診断を後続裁定へ渡す。CSS更新の実表示確認も引き続きfinal-gateの確認事項とする。

## 現在の報告と不具合追跡

原因未確認のhelper unit失敗は [bug #1854](https://github.com/daiki-beppu/live-mindmap/issues/1854) で追跡する。issueには入力、期待する失敗伝播・終了契約、初回失敗、診断版と最終版の後続成功、環境、証跡、既存の失敗診断、今後の調査・完了条件を記載した。ラベルは `bug`・`needs-triage`。

既存issueの確認では、openなbug全3件（#1819・#1798・#1518）の本文・コメントを確認した。いずれも別のテストまたはビルド計測を扱っていた。全状態で対象関数名と `DeadlineExceeded` を検索して一致0件、`RunAudioTests` の検索結果8件は閉じた仕様・実装issueで、同じ初回期限切れを扱う追跡先は確認できなかった。そのため新規起票した。

初回の原因確定と、Issue #1833が求める検証結果の報告を分ける。報告は初回失敗を保持し、原因調査・必要な修正を #1854へ接続した。後続成功や期限切れの診断追加を根本修正とは扱わない。

| 対象コードの状態 | 実行記録 | 現在の扱い |
|---|---|---|
| 初回HEAD、既存追跡ファイル無変更 | root typecheckはfallowを含め0、root unitは1、light IT・指定heavy IT3本・reviewControlsは0 | 初回アーカイブのログ・status・manifestを保持。unit失敗を成功へ置き換えない |
| 同HEADに段階別診断を加えた作業コピー | helper単独とルートunitが0 | 診断版の結果として保持。最終版のルート全体成功とは記載しない |
| 段階別診断を除去し、対象テストの期限切れ診断だけを残した最終作業コピー | helper package testが0、Swift unit 571件成功 | 最終helper版の結果として保持。追加アーカイブの984ファイルのmanifestと現在版が一致 |

今回の報告整理ではコード・fixture・テスト対象・設定を変更せず、新しいテスト実行も行っていない。初回アーカイブと追加アーカイブはどちらも変更せず、SHA-256の一致を再確認した。表示・checker関連のソースは不変のため、R-001・R-002の証跡は引き続き適用できる。

R-001〜R-003の証跡保持・検証結果の報告・規約上の失敗追跡への接続は完了した。独立検証へ渡す確認事項は、原因未確認のbug #1854と、裁定から持ち越したCSS更新の実表示確認である。bugの解消やCSS更新の実表示確認を完了とはしていない。
