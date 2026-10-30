# マップの畳み方

マップ面で何を畳んで見せるか、人の開閉（Enter・畳みの点・変更一覧のクリック・反映・Esc）で見せ方がどう変わるかを触るときに読む文書。畳む規則と人の開閉の記録の変え方は、畳む module（`web/src/folding.ts`）の `foldView`・`refold`・`keepTargetOf` にだけあり、マップ面（`web/src/app/mapSurface/main.ts`）・見せ方の reducer（`web/src/viewing.ts`）・右の列の根拠（`web/src/evidence.ts`）はその出力を読む。決定そのものは仕様 [#1615](https://github.com/daiki-beppu/live-mindmap/issues/1615)（interface は [#1608](https://github.com/daiki-beppu/live-mindmap/issues/1608)）にある。

- 用語: [畳む・今の議題・反映・見返し](../../GLOSSARY.md)
- ADR: 無し（module の切り方は内側の構造で覆しやすいので、仕様に置いている）
- 関連する知識文書: [右の列](side-panel.md)、[カメラ](camera.md)

## 開閉の判定はノードごとの `Openness` だけを読む。種別や今の議題の鎖を呼ぶ側で写さない

`foldView` の `openness[id]` は、見せるノードごとに `folded`（押すと開く）・`open`（`byHuman` のときだけ「畳む」の点）・`bundle`（「議題 N 件」のまとめ、解くだけ）・`fixed`（開閉できない）のどれかを返す。マップ面の描き分け、Enter と畳みの点の効き方、まとめをクリックしても選ばないことは、どれもこの値だけで決めている。

「議題か論点なら開閉できる」「今の議題の祖先は開閉できない」を呼ぶ側で判定し直すと、#1615 の前に戻る。そのときは同じ規則が `isFolded`・見せ方の reducer の今の議題のたどり直し・マップ面の `treeOf`・テストの `visibleOf` の 4 か所にあり、どれか 1 つを誤って変えても、点は出るのに押しても効かない画面がテストを通った。規則を変えるときは `folding.ts` の `isFolded` と `opennessOf` だけを直す。

## `refold` には、同じ `ViewingState` とスナップショットから作った見せ方をそのまま渡す。写した見せ方では黙って効かない

`refold(view, action)` はスナップショットを受け取らない。見せ方を作った材料（スナップショット・人の開閉・選択）は、`FoldView` のオブジェクトをキーにした `WeakMap` に入っていて、型の欄には出ていない。だから、見せた開閉と違う材料で遷移を判定する誤りは書けない。

裏返すと、`{ ...view }` で写した見せ方や、テストで手組みした見せ方には材料が無く、`refold` は例外を投げずに `null`（効かない）を返す。本番では、マップ面が見せ方の reducer に木（`VisibleTree` の `fold`）を渡す 1 か所でこの約束が成り立つ。still の木と、カメラ・矢印を位置で確かめるテストの手組みの木は `fold: null` で、開閉は効かない。

## 人の開閉の記録は `ViewingState` の `humanFolds` 1 欄で、中身は畳む module の外で読まない

`HumanFolds` は開いた・畳んだ・解いたの 3 つの集合を持つが、外からは `foldView` と `refold` に渡すだけにする。空になったら `refold` は `human: undefined` を返し、欄が無い状態が「人の操作なし」を表す。Esc だけは `refold` を通さず、見せ方の reducer が欄を落とす。統合で消えたノードの ID は集合に残るが、付け替えない（効かないだけで、Esc で消える）。

値を Model（`ViewingState`）に置くのは、導いた値ではなく人の操作の記録だからだ。1 つの操作が人の開閉・選択・カメラを同時に変えるので、見せ方の reducer の遷移は割らず、reducer には `refold` が返す `select` を選択に書くことと、カメラに何が起きたか（`CameraInput`）を返すことだけが残る（[#1553](https://github.com/daiki-beppu/live-mindmap/issues/1553)）。カメラの見方と見る位置はカメラの module が決める（[カメラ](camera.md)）。

## 変更一覧のクリックは、祖先の人の畳みを外すだけで祖先を開いた集合に足さない。それでも指したノードは必ず見える

`refold` の `point` は、指したノードの祖先（と自身）の人の畳みを外し、選択を指したノードに移した状態で `foldView` を作り直して、指したノードがなお `folded` なら開いた集合に足す。祖先が既定の理由（`済み`・15 分）で畳まれていても、選択の祖先は既定では畳まないので開く。#1615 の形式仕様（Quint、228,349 状態）の `invPointShows` がこれを全状態で確かめた。祖先を開いた集合に足すと、選択を外した後に、人が開いた覚えのないノードが開いたまま残る。

## 呼ぶ側の分岐を見せ方の reducer へ移すときは、マップ面が出来事の種類で決めている待機の計り直しを確かめる

マップ面の `applyViewing` は、見返しで触らずに 10 秒たつと自動のカメラに戻す待機（`idleStamp`）を、出来事の種類（`keepsIdleTimer` の `side`・`select`・`deselect`）で計り直すかどうか決めている。#1661 で、スナップショットに無い ID の変更一覧のクリックを、マップ面で `select` に変える代わりに reducer が `pointChange` のまま受けるようにしたとき、そのままでは待機を計り直す振る舞いに変わるところだった。reducer の戻り値の `preserveIdleTimer` で前の振る舞いを保っている。出来事の種類を変える・分岐を移すときは、`keepsIdleTimer` に載っている種類と、`web/test/mapSurfaceCamera.story.test.ts` の「見返しで触らずに 10 秒たつと自動に戻る」の節を見る。

## 畳む規則のテストは `foldingActions` で操作の列を畳み込み、見せるノードと `openness` だけを期待値に書く

`web/test/foldingActions.ts` の `foldingActions(snapshot, actions, human?, selectedId?)` は、`FoldAction` の列を 1 つずつ `refold` に通し、最後の `foldView` を返す。途中の操作が `null`（効かない）なら失敗にする。ただし `reflect` は、解く人の畳みが無ければ `null` を返す実装なので、失敗にしない（仕様の約束は `toggle` と `point` の `null` しか挙げていないが、呼ぶ側は `null` を「人の開閉はそのまま」と読むので振る舞いは同じ）。

期待値に書くのは見せるノードの ID、`openness[id]`、`hint`・`hidden`、`blink`・`shownAs` で、`HumanFolds` の集合の中身は書かない。見せ方の reducer のテスト（`viewing.test.ts`）には、選択の期待値（選択を畳んだ議題・まとめの先頭・指したノードに移す）だけを置く。同じ規則の失敗を両方で拾っていた分を #1661 で外し、`viewing.test.ts` は 728 行減った。カメラの期待値は #1712 で `mapSurfaceCamera.story.test.ts` の表に移した（[カメラ](camera.md) のテストの節）。丸の click から Model・DOM までのつなぎは、層が違うのでマップ面の Story・Scene に残している。

## 出典

- [マップの「畳めるノード」の規則を 1 つの module に集めたときの開発ログ](../devlog/2026-10-28.md#folding-module)
- 仕様 [#1615](https://github.com/daiki-beppu/live-mindmap/issues/1615)（Formal Spec のコメントを含む）、親 [#1659](https://github.com/daiki-beppu/live-mindmap/issues/1659)、地図 [#1551](https://github.com/daiki-beppu/live-mindmap/issues/1551) の決定 [#1552](https://github.com/daiki-beppu/live-mindmap/issues/1552)・[#1553](https://github.com/daiki-beppu/live-mindmap/issues/1553)・[#1554](https://github.com/daiki-beppu/live-mindmap/issues/1554)・[#1608](https://github.com/daiki-beppu/live-mindmap/issues/1608)
- チケット [#1660](https://github.com/daiki-beppu/live-mindmap/issues/1660)・[PR #1687](https://github.com/daiki-beppu/live-mindmap/pull/1687)、[#1661](https://github.com/daiki-beppu/live-mindmap/issues/1661)・[PR #1690](https://github.com/daiki-beppu/live-mindmap/pull/1690)
