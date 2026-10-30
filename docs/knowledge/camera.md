# カメラ

画面のカメラの見方（自動・手動・全体・変わったところ）と見る位置を決める決まりを足す・変えるとき、カメラに届く入力を足すとき、そのテストを書くときに読む文書。決まりはカメラの module（`web/src/camera.ts`）の状態 `Camera` と遷移 `stepCamera` にだけあり、呼ぶのはマップ面（`web/src/app/mapSurface/main.ts`）の更新だけ。見方の reducer（`web/src/viewing.ts`）は命令を出さず、何が起きたか（`CameraInput`、決まった id つき）を返す。会議・見返しの画面が読むのは `Camera` の `mode` と `viewport` だけ。決定そのものは仕様 [#1702](https://github.com/daiki-beppu/live-mindmap/issues/1702)（interface は [#1549](https://github.com/daiki-beppu/live-mindmap/issues/1549)、テストの移し方は [#1550](https://github.com/daiki-beppu/live-mindmap/issues/1550)）にある。

- 用語: [カメラ・今の議題・反映・畳む・見返し](../../GLOSSARY.md)
- ADR: 無し（module の切り方は内側の構造で覆しやすいので、仕様に置いている）
- 関連する知識文書: [マップの畳み方](folding.md)、[右の列](side-panel.md)

## 決まりは `stepCamera` の表のセルで変える。ただし門・錨・列のずらしは表が呼ぶ関数の中にもあるので、併せて読む

`stepCamera` の `table` は、行が入力の種類（`CameraInput["type"]`）、列が前の見方で、セルが `Decision`（後の見方・見る位置の決め方 `placement`・外すもの `reset`・今の議題を覚え直すか `topic`）。どの入力でどの見方の見る位置が動いてよいか（共有画面で跳ばない決まり）は、ここで読む。

けれども、セルだけでは決まりは閉じない。#1702 の 3 つの食い違いを直した子のうち、セルだけで済んだのは [#1715](https://github.com/daiki-beppu/live-mindmap/issues/1715)（`unrelated` の行で列のずらしの保留を残す）だけだった。

- 何も変わらない反映では動かない門（#173）は、`placeCamera` の `placement === "topic"` の条件にある。反映以外で自動を寄り直させる入力（測り直し・Esc）は、門を通らない `refocus` を `placement` に置く（[#1713](https://github.com/daiki-beppu/live-mindmap/issues/1713)）。自動での選択で畳み方が変わったときは `unrelated` として届くので、`topicPlacement` が前後の `seen` の位置を比べて `refocus` かを決める
- 開閉の錨を見る位置に当てるのは `reanchor` で、表のどのセルを通っても最後に走る。錨を外すのは `reset` が `keep` 以外のセルと、`measuredCamera` で列のずらしが片付くとき（ずらしが錨より優先、#1715）
- 全体・変わったところでも錨があれば収め直さないのは、`placeCamera` の `all`・`changes` の分岐にある

決まりを変える issue に「表のこの決まりだけを直す」と縛りを書くと、表の外が要ったときに takt の run が通らなくなる。[#1717](https://github.com/daiki-beppu/live-mindmap/issues/1717) は `reanchor` を直す必要があり、3 本の run が失敗した後、issue に例外を足して通った（[takt の run](takt-runs.md) の縛りの節）。縛るなら、上の 3 つの関数も範囲に入れる。

## 錨の id は `shownIdOf` を 2 回かけて、今見えている先にする

`seen.shownIdOf` は畳む module の `keepTargetOf` で、隠れたノードの id を見えているまとめ（「議題 N 件」）の id に、もう無いまとめの id をその先頭の議題に読み替える。読み替えた先がまた別の種類の id になりうるので、1 回では止まらない。開閉の前のまとめ `run:A` は、1 回目で先頭の議題 `A` になり、`A` が今は別のまとめ `run:X` に入っていれば、2 回目で `run:X` になる。だから `reanchor` は `seen.positions[seen.shownIdOf(seen.shownIdOf(id))]` を引く（#1717）。位置を id で引く所を足すときは、同じ読み替えが要るかを見る。

## 更新後の状態から畳むのは `surfaceOf` の 1 か所。反映で選択か人の開閉が変わると更新先を 2 回畳むが、それで正しい

マップ面の `surfaceOf` は、更新後の Model から `foldView` を 1 回呼び、その値から見方の reducer に渡す木（`VisibleTree`）とカメラの `seen` を両方作る（[#1710](https://github.com/daiki-beppu/live-mindmap/issues/1710)）。カメラは畳む module を import せず、`FoldView` も受け取らない。`seen` は Model に置かず、毎回 Model から導く。

反映の経路では `surfaceOf` を 2 回通ることがある。反映で消えたノードを選んでいたら、選択の移し先を、更新先を今の選択で畳んだ木から探す（まとめの id も候補に入るので、畳む前の木では足りない）。その結果、選択が移るか人の畳みが解けると、`foldView` の引数が変わるので畳み直す。1 回目を省くとまとめが候補から外れ、1 回目を使い回すと選んだノードまでの鎖が開かれない。どちらも見える動きが変わる。PR #1732 のマージの run の裁定役はこれを P1 に挙げたが、「呼ぶ所が 1 か所」と読んで残すと決めた（[PR #1732 のコメント](https://github.com/daiki-beppu/live-mindmap/pull/1732)）。評価を 1 回にするなら、畳む module の interface（#1615）を変えることになる。

## カメラの決まりのテストは `mapSurfaceCamera.story.test.ts` の 1 つの `it.each` に行を足し、最後の `mode` と `viewport` を見る

`web/test/mapSurfaceCamera.story.test.ts` の「入力と前の見方から決まるカメラ」が、入力 × 前の見方 → 後の見方・期待の見る位置の表になっている。行は `MapSurface.update` に Message を続けて流す `start`・`apply` と、story にある期待の関数（全体に収める・今の議題に寄る・はみ出た分ずらす など、`camera.ts` が export のまま残している幾何の関数）で書く。`stepCamera` だけを呼ぶ unit test や、表の形を見るテストは足さない。見方の reducer のテスト（`viewing.test.ts`）には、選択・人の開閉・右の列・矢印の移り先だけを置く。

修飾付きのキーは手動の行で確かめる。ほかの見方では、見方の決まりで同じ見る位置に戻り、違いが見えない。開閉の錨は、補間の途中と終わりの両方で、開閉したノードの画面座標を見る（同じ describe の外の「開閉で位置を保つ」の節が先例）。

直す前に赤かったことは、テストを今の版のまま、`camera.ts` だけを直す前の版に置き換えて、足した行を名前で絞って流せば示せる。#1713 では、直す前の版で 4 件とも落ち、高さ・選択・Esc の 3 件は見る位置の y が 87.8 のまま動いていなかった。

```sh
pnpm --filter @live-mindmap/web test test/mapSurfaceCamera.story.test.ts -t '空の反映の後の(画面サイズ変更|ノードの高さ変更|選択による畳み変更| Esc)'
```

## 出典

- [画面のカメラの決め方を 1 つの表に集めたときの開発ログ](../devlog/2026-10-31.md#camera-module)
- 仕様 [#1702](https://github.com/daiki-beppu/live-mindmap/issues/1702)、親 [#1709](https://github.com/daiki-beppu/live-mindmap/issues/1709)、地図 [#1547](https://github.com/daiki-beppu/live-mindmap/issues/1547) の決定 [#1548](https://github.com/daiki-beppu/live-mindmap/issues/1548)・[#1549](https://github.com/daiki-beppu/live-mindmap/issues/1549)・[#1550](https://github.com/daiki-beppu/live-mindmap/issues/1550)・[#1633](https://github.com/daiki-beppu/live-mindmap/issues/1633)
- チケット [#1710](https://github.com/daiki-beppu/live-mindmap/issues/1710)・[PR #1732](https://github.com/daiki-beppu/live-mindmap/pull/1732)、[#1712](https://github.com/daiki-beppu/live-mindmap/issues/1712)・[PR #1741](https://github.com/daiki-beppu/live-mindmap/pull/1741)、[#1713](https://github.com/daiki-beppu/live-mindmap/issues/1713)・[PR #1743](https://github.com/daiki-beppu/live-mindmap/pull/1743)、[#1715](https://github.com/daiki-beppu/live-mindmap/issues/1715)・[PR #1742](https://github.com/daiki-beppu/live-mindmap/pull/1742)、[#1717](https://github.com/daiki-beppu/live-mindmap/issues/1717)・[PR #1757](https://github.com/daiki-beppu/live-mindmap/pull/1757)
