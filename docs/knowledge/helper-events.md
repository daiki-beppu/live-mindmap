# helper のイベントの見本

helper が server へ送るイベント（Swift の `HelperEvent`、server の `server/src/core/live.ts` の `HelperEvent` と `decodeHelperEvent`）の形を足す・変えるとき、helper のイベントの見本（`helper/Tests/HelperCoreTests/Fixtures/helper-events.jsonl`）を書き直すときに読む文書。形の正をどちらに置くか、見本をどう書き直すか、両側のテストと CI がどう走るかを書く。決定は仕様 [#1609](https://github.com/daiki-beppu/live-mindmap/issues/1609) と、その元の [#1571](https://github.com/daiki-beppu/live-mindmap/issues/1571) の答えにある。

- 用語: 無し（運び方の話で、利用者に見える言葉は増えないと仕様が決めている）
- ADR: [0002 音声取得と STT はローカルのヘルパーが行い、Web アプリには文字起こしのイベントだけを渡す](../adr/0002-local-stt-helper.md)
- 関連する知識文書: [取り込みの試行](intake-attempts.md)（server の知らないイベントの知らせ）、[セッションの開始とブラウザへの送り口](session-start-and-viewers.md)（server ↔ web の frame）

## 形の正は送る側の Swift。見本は `HelperEvent.jsonString()` の出力で、手で直さない

見本は、Swift の `EventsTests.swift` の `helperEventExamples` から `jsonString()`（キーを並べ替えるので毎回同じ文字列）で作った 1 行 1 件の JSONL になっている。Swift のテストは、作った JSONL と置いてある見本を比べ、違えば落ちる。意図して形を変えたときは、書き直してからコミットする。

```sh
UPDATE_HELPER_EVENTS=1 pnpm --filter @live-mindmap/helper test
```

`HelperEvent` に case を足したら、`helperEventExamples` に見本を足す。隣の `exampleCaseName` は `default` 無しの `switch` なので、足さないとコンパイルが落ちる。`default` を足して吸収しない。

見本には case ごとの 1 件に加えて、両側で一致していなければならない規則の形を 1 件ずつ入れている。`screen` の `image: null`・`ocrFailed`（`lines` を欄ごと落とす）・`lines` あり・`meetingTabTitle` あり、`self-pause` の `paused` が true と false、`origin` の文字列の `hostTime` だ。`hostTime` の値は `9007199254740993`（2^53 + 1、JavaScript の数で正確に表せない最小の整数）にしてある。規則を変えると、この行の差分に出る。

## server のテストは見本を両方向から確かめる。どの行も既知として読め、server の union のどの type も見本に出る

`server/test/helperEvents.test.ts` は 2 つを見る。見本のどの行も `decodeHelperEvent` で `kind: "known"` になること。server の `HelperEvent` の union の type の集合が、見本に出る type の集合と一致すること。後者が無いと、helper がもう送らない type を server が受け続けていても落ちない。

server に type を足したのに helper が送らないとき、または helper に case を足したのに server が知らないときは、このテストが落ちる。片側だけを直して通そうとせず、両側をそろえる。

## 見本を読む server のテストは `?raw` の import で unit に置く。見本のパスは CI の `ts` の例外に入っている

server のテストは、見本を `../../helper/Tests/HelperCoreTests/Fixtures/helper-events.jsonl?raw` で読む。`node:fs` を import すると、`server/scripts/check-test-layers.ts` が unit として通さない。

`.github/workflows/check.yml` の `changes` は、`helper/` の下だけが変わった PR では `ts` を走らせない。server のテストが読む helper のファイル（`helper/package.json` と見本）だけは例外で `ts=true` にしている。server のテストが helper の別のファイルを読むようにしたら、同じ行に足す。足さないと、そのファイルだけを変えた PR で server のテストが走らない。

## `fake-helper.ts` の手書きの JSON は場面の入力として残す。形の一致は見本が受け持つ

`server/test/fixtures/fake-helper.ts` などに手で書いた JSON は、場面ごとのテストの入力のまま残す。見本に置き換えない（仕様の Out of Scope）。両側の形の一致を確かめるのは見本だけで、場面の振る舞いは手書きの入力で書く。

## 出典

- [helper・server・web の受け渡しの形のずれを、見本と型で CI に捕まえさせた話](../devlog/2026-10-27.md#seam-contract-tests)
- 仕様 [#1609](https://github.com/daiki-beppu/live-mindmap/issues/1609)、親 [#1616](https://github.com/daiki-beppu/live-mindmap/issues/1616)
- チケット [#1617](https://github.com/daiki-beppu/live-mindmap/issues/1617)・[PR #1640](https://github.com/daiki-beppu/live-mindmap/pull/1640) の差分
