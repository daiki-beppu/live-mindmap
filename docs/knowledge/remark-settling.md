# 途中結果から発言を作る段

途中結果と確定結果から発言を作る確定の段（`server/src/core/settle.ts`）と、出す直前の関所（`server/src/core/remarkGate.ts`）を触るとき、特に本文どうしを比べる処理（重なり・挿入の検出）を足す・変えるときに読む文書。

- 用語: [発言・途中結果・字幕](../../GLOSSARY.md)。「確定の段」「関所」は実装の言葉で、用語集には載せない
- ADR: 無し

## 本文どうしを比べるときは、関所の `compact`・`overlapEnd` を import する。無視する文字の集合を写さない

比べるときに無視する文字（句読点・空白の `IGNORED`）と、比べる形の位置を元の本文の位置に戻す走査は、`remarkGate` だけが持つ。外へ出しているのは `compact(text)`（比べる形にする）と `overlapEnd(text, count)`（比べる形の `count` の位置を元の本文の UTF-16 の位置に戻す）の 2 つで、`IGNORED` そのものは出していない。

以前は `settle` が `IGNORED` の写しと同じ走査を持ち、コメントで「ずれると比較が壊れる」と注意していた。片方の集合だけを変えると、挿入の検出（`settle` の `insertionEnd`）と関所の重なりの判定が黙ってずれ、字幕・発言の重複や欠けになる。[#1442](https://github.com/daiki-beppu/live-mindmap/issues/1442)（[PR #1455](https://github.com/daiki-beppu/live-mindmap/pull/1455)）で写しを消し、`insertionEnd` は `p <= 0 ? 0 : overlapEnd(text, p)`（`p = compact(text).indexOf(compact(emitted))`）の 2 行になった。

依存の向きは `settle` → `remarkGate` だけにする。`remarkGate` は循環を避けるため `settle` を import しない（ファイルの頭のコメント）。

## 「関所の振る舞いを変えない」という約束は、export を足すことを禁じない

`settle` の写しは、[#996](https://github.com/daiki-beppu/live-mindmap/issues/996) の仕様の「出す直前の関所は振る舞いを変えない」を「関所の export も増やせない」と読んで作られていた。export を足しても関所の振る舞いは変わらず、`settle` はすでに `createRemarkGate` を import していたので循環の心配も無かった（[#1439](https://github.com/daiki-beppu/live-mindmap/issues/1439)）。

複製のコメントが「〜は変えないので共有できない」と理由を書いていたら、その約束が禁じているのが振る舞いか形かを読み直す。振る舞いだけなら、export して畳める。

## `overlapEnd` に渡す数は、比べる形の UTF-16 の長さ。コードポイントで数えた長さは足し直してから渡す

`overlapEnd` は残す文字ごとに `c.length` を足して数える。`compact(text).indexOf(...)` の結果は UTF-16 の位置なので、そのまま渡せる。一方、関所の `fuzzyOverlap` が返す重なりの長さ `j` はコードポイント数で、関所は `Array.from(newBody).slice(0, j)` の `c.length` を足し直してから `overlapEnd` に渡している。

コードポイント数のまま渡すと、補助平面の文字（`𠮷` など）を含む本文で切る位置がずれ、出した分の再出力か、続きの欠けになる。`settle.test` の「補助平面の文字を含む本文でも、直前に出した本文の分を除いた残りが出る」がこれを押さえている。

## 比べ方を触ったら、helper の unit を足さず、挿入・補助平面・字幕の 3 つの振る舞いのテストで確かめる

`compact`・`overlapEnd` の中を覗くテストは足さない（[#1439](https://github.com/daiki-beppu/live-mindmap/issues/1439) のテストの方針、`CODING_STANDARDS.md` の Tests）。比べ方の契約は、次の既存テストが外から見える出力で押さえている。

- `settle.test`: 「頭の挿入を句読点を無視して切るとき、words も同じ位置で切り、残る語の位置が切った後の本文に合う」「出した文が頭で句読点だけ書き換わり後ろで繰り返されても、その間の本文を捨てない」「補助平面の文字を含む本文でも、直前に出した本文の分を除いた残りが出る」
- `remarkSettling.test`: 関所を通った発言の並び
- `captions.test`: 「頭に挿入が入った途中結果（出した本文が新しい本文の途中に現れる）は、settler が次の発言にするのと同じ位置で切った後ろだけが字幕に入る」（字幕と次の発言が同じ位置で切られること）

まず 3 ファイルだけを流す。#1442 の時点で 227 件。

```sh
pnpm --filter @live-mindmap/server test test/settle.test.ts test/remarkSettling.test.ts test/captions.test.ts
```

## 出典

- 仕様 [#1439](https://github.com/daiki-beppu/live-mindmap/issues/1439)、親 [#1441](https://github.com/daiki-beppu/live-mindmap/issues/1441)
- チケット [#1442](https://github.com/daiki-beppu/live-mindmap/issues/1442)・[PR #1455](https://github.com/daiki-beppu/live-mindmap/pull/1455) の差分
- #1442 の takt の run（`20261024-042021-issue-1442-no-no-be-no-wo-shi-hj3cz3`）の計画・テストの報告・実装の報告・レビュー
