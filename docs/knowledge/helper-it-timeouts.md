# helper の IT の時間切れ

helper の Swift の IT（`swift test --filter 'ITTests/'`）にテストを足すとき、偽物のフックや同期の API を協調スレッドの上から呼ぶとき、CI の helper のジョブが待ちの期限切れで落ちたのを調べるときに読む文書。CI でだけ落ちる理由、手元で再現するコマンド、PR のせいかどうかの見分け方を書く。テストの層と CI のジョブの全体は [`docs/agents/checks.md`](../agents/checks.md)、待ちの書き方は `CODING_STANDARDS.md` → Tests にある。

- 用語: 無し
- ADR: 無し
- 関連する知識文書: [helper のライブのセッション](live-session.md)（`LiveSessionITTests` の偽の機器）、[録画からのセッションの helper の経路](recorded-helper-relay.md)（巻き添えで落ちやすい録画の IT）、[takt の run](takt-runs.md)

## 協調スレッドの上で、別の協調スレッドの仕事が解く待ちをしない。CI のランナーはコアが少なく、解く側が走れずに IT ごと止まる

Swift concurrency の協調スレッドのプールは、コア数だけのスレッドしか持たない。swift-testing のテスト関数も、async の閉包も、偽の機器のフックも、このプールで動く。その上で `DispatchSemaphore.wait` のように同期で待ち、解く側も協調スレッドで動く仕事だと、空きスレッドが無くなったときに誰も解けない。手元（10 コア前後）では空きがあって通り、GitHub の macOS ランナー（3 コア）でだけ止まる。

止まるのは塞いだテストだけではない。プールを取られた隣の IT が、期限まで進めずに落ちる。2 回起きている。

- [#1197](https://github.com/daiki-beppu/live-mindmap/issues/1197): Vision の OCR（`VNImageRequestHandler.perform`）は、中の処理をプールに積んでセマフォで待つ。プールの上から同期で 3 つ同時に呼ぶと、132 件が started のまま 1 件も終わらず、ジョブの上限の 30 分で cancel された。公開の `recognizeScreenText` を async にし、同期の版は `@available(*, noasync)` の `recognizeScreenTextBlocking` に下げた。
- [#1667](https://github.com/daiki-beppu/live-mindmap/issues/1667)（[PR #1683](https://github.com/daiki-beppu/live-mindmap/pull/1683)）: `LiveSessionITTests` の偽の tap のフックが、テスト本体が解くセマフォを待っていた。落ちたのは録画の `FileReadingAlignment` と `invNoReadWhilePaused` の suite で、流し直しても同じだった。停止の要求と待ち合わせを `Thread.detachNewThread` に出して直した。

フックの中で待ちが要るなら、解く側をプールの外のスレッド（`Thread.detachNewThread`）か専用の `DispatchQueue` に置く。同期で待つ API を新しく作るなら、`@available(*, noasync)` を付けて協調スレッドから呼べなくする。この規則を検査する仕組みはまだ無い（レビューだけ）。

## プールを 1 本に絞ると、手元でも再現できる

```sh
cd helper
LIBDISPATCH_COOPERATIVE_POOL_STRICT=1 swift test --skip-build --filter 'ITTests/'
```

#1667 では、PR の版のテストで 28 件落ち、製品コードはそのままで `LiveSessionITTests.swift` だけを main の版に戻すと 2 回とも全件通った。直した後は同じコマンドで 3 回とも 162 件通った。#1197 でも 1 回目で止まり、`sample` で唯一のスレッドが `semaphore_wait_trap` にいるのが見えた。協調スレッドの上で同期の待ちを書いたテストは、このコマンドで 1 回流してから PR にする。

## 落ちたテストが PR と関係なくても、PR のせいではないとは言えない。PR が足した同期の待ちを先に探し、無ければ base の main の同じ赤を確かめる

見た目は同じでも、原因は 2 通りある。2026-10-27〜28 に、続けて両方が起きた。

| PR | 落ちた IT | 原因 |
|---|---|---|
| [#1683](https://github.com/daiki-beppu/live-mindmap/pull/1683) | 録画の `FileReadingAlignment`・`invNoReadWhilePaused`（流し直しても同じ） | PR が足したテストがプールを塞いでいた（上の節） |
| [#1680](https://github.com/daiki-beppu/live-mindmap/pull/1680) | 録画の `FileSessionRelayITTests`、流し直すと `FileReadingPauseITTests` | PR と無関係。base の main（`fe0304b`）の 1 回目も同じ IT で落ちていた。3 回目で通った |

見る順は次のとおり。

1. PR の差分に、協調スレッドの上の同期の待ち（`DispatchSemaphore.wait`・`DispatchGroup.wait`・同期の Vision など）が無いか探す。あれば `LIBDISPATCH_COOPERATIVE_POOL_STRICT=1` で PR の版と、テストだけ main に戻した版を比べる。
2. 無ければ、base の main の run で同じ IT が落ちていないかを `gh run view <run> --json attempt,jobs` で見る。落ちていれば、PR では直さず、期限の延長・除外・assertion を緩めることもせず、時間切れを [#1681](https://github.com/daiki-beppu/live-mindmap/issues/1681) に足して流し直す。

takt の CI の調査（PR のコメントの「CI調査」）は、どちらの場合も `insufficient_evidence` で止まった。#1683 では `LiveSessionITTests.swift:354` のセマフォの待ちに気づいていたが、「他のテストの失敗を引き起こした証拠はない」として追わなかった。CI のログには個々の assertion が出ないことが多いので、調査の結論を待たずに上の 1 を手元で回す。

## 協調スレッド以外の時間切れは、#1681 にまとめて追う

#1681 は 2026-10-28 の時点で開いている。分かっていることは issue の本文にある。ランナーの image が `20261012.601` から `20261021.618` に替わった頃から、helper の IT 全体が 27 秒から 43〜55 秒に延びたこと。`FileReadingPauseITTests.pausedPairDoesNotAdvance` が固定の 500ms の sleep で位置を写していること。CI では映像を読む IT が CPU を取り合っているかもしれないこと（未確認）。新しい時間切れを見たら、run の番号と落ちたテストを #1681 に足す。#1667 の直しの後も、`78b9cd7` の main で `FileReadingAlignmentITTests` が 1 件落ちている。

## 出典

- [helper のライブのセッションを差し替えられる module にしたら、止める直前のイベントの欠けが直り、CI の時間切れの 1 つはテスト自身が協調スレッドを塞いでいた話](../devlog/2026-10-28.md#live-session-module) の 5・6 節
- [PR #1683](https://github.com/daiki-beppu/live-mindmap/pull/1683) の本文（「CI の helper IT の失敗の修正」）と CI 調査のコメント、[PR #1680](https://github.com/daiki-beppu/live-mindmap/pull/1680) の CI 調査と review-fix のコメント
- [#1197](https://github.com/daiki-beppu/live-mindmap/issues/1197)、[#1681](https://github.com/daiki-beppu/live-mindmap/issues/1681)
