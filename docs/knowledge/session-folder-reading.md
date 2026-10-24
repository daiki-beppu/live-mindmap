# 過去のセッションのフォルダの読み側

過去のセッションのフォルダ（`log.jsonl`・`export.json`・`screens/`・録音）を読む処理を触るとき、とくに CLI の `play`・`restore`・`eval`・`review`・`publish` や bench にログを読む所を足す・変えるときに読む文書。読み側の口の使い方、壊れた行の失敗の運び方、どの層のテストで確かめるかの基準を書く。決定そのものは仕様 [#1438](https://github.com/daiki-beppu/live-mindmap/issues/1438) と、その元の [#1427](https://github.com/daiki-beppu/live-mindmap/issues/1427) の解決コメントにある。

- 用語: [再生・発言・共有画面・ローカルモード](../../GLOSSARY.md)
- ADR: [0010 CLI の引数は effect/cli で読み、引数の誤りの出力は effect/cli の既定に任せる](../adr/0010-cli-on-effect-cli.md)
- 関連する知識文書: [セッションの sink](session-sink.md)（ログを書く側）、[エクスポートの公開](export-publish.md)（`cli publish`）

## ログは `sessionFiles` の口で読む。`log.jsonl` を自分で開いて行番号を対応づけない

フォルダの作りを知っているのは `server/src/sessionFiles.ts` だけにしてある。書き側と同じ module に、読み側の口が並ぶ。

| 口 | 返すもの |
|---|---|
| `latestSessionDir(sessionsDir, file)` | `file` を持つ最新のフォルダのパス。sessions のフォルダが無い・ファイルだった（`ENOTDIR`）・候補が無いときは `NoSavedSession` |
| `readSessionLog(dir)` | `SessionLogRead`。`log.jsonl` が無ければ `MissingSessionLog`、JSON として読めない行があれば `BrokenLogLine(kind: "json")` |
| `log.select(schemas)` | 指定した種類の行だけを `LogEvent` で decode した値。合わなければ `BrokenLogLine(kind: "event")` |
| `log.lineOf(event)` | `select` が返した値の元の行番号 |
| `log.brokenAt(error)` | `restoreSession`・`restoreState` の `InvalidLogEvent`（index）を、元の行番号の `BrokenLogLine` にしたもの |
| `startOf(log)` | start の行。無ければ `MissingStartLine` |
| `isLocal(log)` | start の `model.local`。start が無い・decode できないときは `false` |

行番号は、空行も数えた、エディタで開いたときの行番号だ。読み側を写していたころは、空行を除いた配列から行番号を引く `lines[i]?.no ?? 1` が 4 か所に写され、同じ壊れたログでもコマンドによって文が違った（パスの有無、言い換え）。新しい読み手も、呼び出し側には目的の形に変えるところ（play の `replayableRemark`・`recordedScreen` など）だけを書く。

bench の `edgeJudge`・`siblingJudge` は、`sessionFiles` の `readLogLines` を使う。`mapShape`・`sttReplay`・`sessionStats` などの bench と、語彙の pool の `updatePoolFromSession`（stream で読み、失敗を警告で済ませる）は自前で読む。後者は目的の違う読み方なので、口へ寄せない。

## 欲しい種類だけを `select` で decode する。全部を先に decode しない

`cli play` は、再生に使わない差分更新の行（diff）が壊れていても流せる。全部入りの記録を先に decode する口にすると、この寛容さが黙って消え、ログの種類が増えるたびに戻り値も大きくなる（#1427 で比べて採らなかった案）。読み手を足すときは、自分が読み飛ばしている種類を `select` に入れない。

## 壊れた行は `BrokenLogLine` のまま入口へ返す。間で別の失敗に包み直さない

日本語の文を作るのは `cli.ts` の入口の表（`failureLine`）だけで、文は 2 つしかない。

```text
json:  <パス> の <行> 行目が JSON として読めません: <理由>
event: <パス> の <行> 行目が読めません: <理由>
```

`CommandFailed` や `ReviewPageFailed` へ包み直すと、パスと行番号が文字列に埋もれて、文が入口の表から外れる。見返しの書き出しの失敗には「map.html を書き出せませんでした: …」の前置きを付けるが、ログを読む段はその `mapError` の外に置き、壊れた行には前置きを付けない（`cli review` は `readSessionLog` を先に済ませてから書き出す）。

## 生の `events` を受け取って decode する所も、読み手として数える

`SessionLogRead.events` は JSON として読んだだけの値で、見返しの埋め込みと復元のために渡す。受け取った先が自分で decode すると、そこが行番号を知らない読み手になる。

[#1446](https://github.com/daiki-beppu/live-mindmap/issues/1446) のレビューで、`cli publish --content map` がこの形で漏れていた。発言の文字を消す `mapOnlyReviewEvents`（`server/src/core/review.ts`）が発言と共有画面の行を自分で decode し、壊れていると `出来事 ${index} 行目を読めません: …` を投げる。`index` は空行を除いた 0 始まりで、パスも無い。仕様は読み手を「`log.jsonl` を開く所」で数えていて、ここを数えていなかった。直しは、`publishedMapHtml` が描画の前に `log.select([RemarkEvent, ScreenEvent])` で検証だけをし、描画には元の `events` を渡す形だ（[PR #1515](https://github.com/daiki-beppu/live-mindmap/pull/1515)）。

`mapOnlyReviewEvents` の文は今も残っていて、発言と画面の行を decode する所は `select` とこことの 2 つある。生の `events` を `renderReviewPages` に渡す呼び出し側を足すときは、map の版なら先に同じ `select` を呼ぶ。

## 成功した値の行番号は `lineOf`、復元の index は `brokenAt` で引く。decode の前後の参照の同一性に頼らない

`cli play` は、共有画面の行が指す画像が無いと、その行の行番号を付けて失敗する。行番号は失敗のときだけでなく、decode に成功した値を呼び出し側が検証するときにも要る。#1427 の下書きの interface には `brokenAt` しかなく、#1446 の実装の計画が `lineOf` を足した。`lineOf` は、`select` が decode した値をキーにして覚えた行番号を返す。decode の前の値と後の値が同じ参照だという仮定は置いていないので、`lineOf` に渡すのは `select` が返した値そのものにする。

## 読み側の契約は偽の `FileSystem` の unit で、CLI の文は `cliEntry` の IT で形ごとに 1 つ確かめる

読み側の契約が越える境界は FileSystem だけなので、`server/test/sessionFiles.test.ts` で偽物の Layer を差して確かめる（`node:fs` は import しない）。

```ts
const fileSystem = (overrides: Partial<FileSystem.FileSystem>) =>
  Layer.succeed(FileSystem.FileSystem, FileSystem.makeNoop(overrides));
```

ここで確かめているのは、空行込みの行番号（json・event の両方）、選んでいない種類の壊れでは失敗しないこと、`MissingSessionLog`（存在を確かめた直後に消えた場合も含む）、読み取りの権限エラーを「無い」に変えないこと、`latestSessionDir` の選び方と `NoSavedSession`、`lineOf`・`brokenAt` の行番号、`startOf`・`isLocal` の場合分けだ。

CLI を argv から動かす IT は、標準エラーの文の完全一致を `cliEntry.it.test` に文の形（json・event）ごとに 1 つずつだけ持つ。行番号の数え方を `cli.it.test` でも確かめていた 2 件は、同じ失敗を 2 つの層で見ることになるので消した（[#1446](https://github.com/daiki-beppu/live-mindmap/issues/1446)）。

## 出典

- [保存したセッションのログの読み側を 1 つの module にまとめたとき](../devlog/2026-10-25.md#session-log-reader)
- 仕様 [#1438](https://github.com/daiki-beppu/live-mindmap/issues/1438)、決定の一次資料 [#1427](https://github.com/daiki-beppu/live-mindmap/issues/1427)
- [#1444](https://github.com/daiki-beppu/live-mindmap/issues/1444)・[PR #1463](https://github.com/daiki-beppu/live-mindmap/pull/1463)、[#1445](https://github.com/daiki-beppu/live-mindmap/issues/1445)・[PR #1466](https://github.com/daiki-beppu/live-mindmap/pull/1466)、[#1446](https://github.com/daiki-beppu/live-mindmap/issues/1446)・[PR #1515](https://github.com/daiki-beppu/live-mindmap/pull/1515)
