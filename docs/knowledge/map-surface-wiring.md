# マップ面のつなぎ方

マップ面（`web/src/app/mapSurface/main.ts`）の Model にフィールドを足すとき、スナップショットを渡す手順・点滅の始め直し・見方の知らせを変えるとき、マップ面を使う画面を足すときに読む文書。つなぐ手順はマップ面の module と、画面が使う `surfaceFolds`（`web/src/app/mapSurface/parentFolds.ts`）に集まっている。決定そのものは仕様 [#1876](https://github.com/daiki-beppu/live-mindmap/issues/1876)（違いの振り分けは [#1556](https://github.com/daiki-beppu/live-mindmap/issues/1556)、置き場所は [#1557](https://github.com/daiki-beppu/live-mindmap/issues/1557)、写しの消し方は [#1864](https://github.com/daiki-beppu/live-mindmap/issues/1864)）にある。

- 用語: [カメラ・反映・見返し・話者の名前](../../GLOSSARY.md)
- ADR: 無し（web の内側の形で、外の契約に触れず戻せる）
- 関連する知識文書: [カメラ](camera.md)、[マップの畳み方](folding.md)

## 画面に残すのは役目から来る違いだけ。手順を画面に足す前に、#1556 の表のどちらかを確かめる

各画面に残すのは、スナップショットの出どころ、いつ渡すか、人が時刻を動かした知らせ（見返しだけ）、Escape で先に閉じるもの、再生のキー、M、C、右の列のボタン、`selfPaused`・`nameEdit` だけ。それ以外の違いは偶然として消した。画面ごとの分岐を足したくなったら、[#1556 の答え](https://github.com/daiki-beppu/live-mindmap/issues/1556) の表でどちらに当たるかを見る。

3 つ目の画面は、`surfaceFolds` に `read`・`write`・`toParentMessage`・`onViewingMode` を渡し、`update` で `withViewingNotice` を 1 回かければつながる。`onViewingMode` に渡す `foldViewingMode` は `const` なので、`sessionLayoutFolds` を `surfaceFolds` より先に定義する（2 つの画面がその順になっている）。

## フィールドは `MapSurface.Model` にだけ足す。`Stored` と `toStored` が画面の持ち分を導き、`surfaceOf` は共通にしない

`Stored`（`Model` から `mode`・`snapshot`・`speakerNames` を除いた schema）と `toStored` はマップ面が出す。2 つの画面の `mapSurface:` はこれを指すので、フィールドを足しても画面は直さない。写していた頃は、`foldingContext` を足すと 3 か所を直す必要があった。

外から入る 3 つを詰める `surfaceOf` は各画面に残す。会議の画面は feed から、見返しは再生の時刻と `context.timeline.speakerNames`（最後に付いた名前、[#1607](https://github.com/daiki-beppu/live-mindmap/issues/1607)）から取る。

## 点滅の条件は `ChangedSnapshot` の update の 1 か所。`replaceSnapshot` の分岐の中に書かない

`RestartBlink` を返す条件は、still ではない・測ってある（`size` がある）・反映番号（`round`）が前と違う・新しい表示に点滅するノードがある、の 4 つ。`replaceSnapshot` には早く返す分岐（判断軸だけの変化、畳み方の保留中の同じノード、脱線の印だけの変化、`reflectionOf` など）があり、どの分岐を通っても同じ条件で判定するために、その外側で見ている。判断軸だけが変わった反映でも、番号が変わって点滅するノードがあれば始め直す。

## `foldSnapshot` には、feed や `playback` を置き換える前の Model を渡す

`foldSnapshot` は `read` の結果を「前」のスナップショットに使い、`read` は feed や再生の時刻から `snapshot` を組み立てる。置き換えた後の Model を渡すと前と後が同じになり、点滅も反映の処理も止まる。会議の画面の `received` と見返しの `reduce` は、`foldSnapshot` の結果に新しい feed・`playback` を載せる順になっている。見返しの `reduce` をこの誤りに書き換えると、契約テストの見返しの点滅の 1 件が落ちる。

## 見方の知らせは `withViewingNotice` の前後比較で出す。OutMessage にしない

比べるのは Model の `camera.mode`（`viewing.mode` は無い。仕様の本文の記述はカメラの整理の前のもの）。比べる片方が None なら足さないので、会議の画面のセッションができた最初の frame では知らせを呼ばない。

OutMessage にしないのは、知らせの Toast がマップ面の兄弟の SessionLayout にあり、`Return` の `outMessage` が 1 つしか無いため。クリックで選ぶときの `SelectedNode` と同じ返り値で mode が変わることがある。前後比較なら、mode を変える Message が増えても漏れない。

`update` で 1 回だけかけることを守るのはレビューだけで、テストでは守っていない。Toast は今出している文と同じなら何もしない（`sessionLayout/main.ts` の `noticeOf`）ので、二重にかけても契約テストと会議の画面のテストは通る（試して 32 件すべて通った）。見える結果が同じなので、そのためのテストは足さない。

## 測る前のマップ面も動く。見返しで測る前に時刻を動かすと `foldingContext`・`idleStamp` が変わる

見返しだけが持っていた、`size` が無いときに `ChangedSnapshot` を飛ばす守りは [#1904](https://github.com/daiki-beppu/live-mindmap/pull/1904) で外した。今は会議の画面と同じく、測る前でも `ChangedSnapshot` が走る。測る前は `RestartBlink` を返さず、描かれてもいないので利用者には見えない。

「時刻を動かしてもマップ面の Model が変わらない」とは書かない。#1904 で、守りの効果を確かめていた `expect(result.model.mapSurface).toEqual(start.mapSurface)` は `size`・`nodeHeights` の比較に狭めた。守りを両方の画面に置くのは、測った後の表示や点滅が変わるテストが落ちたときだけにする。

## 点滅と知らせの契約は `mapSurfaceSnapshot.contract.story.test.ts` に足す。いつ渡すかの違いだけを画面のテストに残す

`describe.each` で会議の画面と見返しの公開の `update` に当てている。画面ごとの渡し物は、初期の Model、スナップショットを変える Message と変えない Message、キーと知らせの読み方。確かめるのは返る Command の名前と知らせの文言で、前と後の surface を組み直す手順や包みの中の分岐は見ない。

画面ごとのテストに残すのは、見返しのシーク・時計・ボタン・キー、会議の画面の取り込みの frame、見方を変える入口の違い（反映や時刻の移動で自動に戻る）、Escape で先に閉じるものの順、話者の名前（#1607）。

## マップ面に直接 `ChangedSnapshot` を流す scene・story テストは、点滅の Command を解決してから次へ進む

`ChangedSnapshot` が `RestartBlink` を返す条件を満たすと、次の Message を送るときに Foldkit のテストが `I found unresolved Commands` で落ちる。scene なら `Command.resolveAll([RestartBlink, Message.CompletedRestartBlink()])`、story なら `Command.resolve(RestartBlink, Message.CompletedRestartBlink())` を挟む。#1904 では scene テストに 9 か所足した。

## 出典

- [会議の画面と見返しのつなぎ方を 1 か所に集めたとき](../devlog/2026-11-04.md#map-surface-folds)
- 仕様 [#1876](https://github.com/daiki-beppu/live-mindmap/issues/1876)（Formal Spec のコメントを含む）、親 [#1897](https://github.com/daiki-beppu/live-mindmap/issues/1897)
- 子 [#1898](https://github.com/daiki-beppu/live-mindmap/issues/1898)・[PR #1902](https://github.com/daiki-beppu/live-mindmap/pull/1902)、[#1899](https://github.com/daiki-beppu/live-mindmap/issues/1899)・[PR #1903](https://github.com/daiki-beppu/live-mindmap/pull/1903)、[#1900](https://github.com/daiki-beppu/live-mindmap/issues/1900)・[PR #1904](https://github.com/daiki-beppu/live-mindmap/pull/1904)、[#1901](https://github.com/daiki-beppu/live-mindmap/issues/1901)・[PR #1905](https://github.com/daiki-beppu/live-mindmap/pull/1905)
