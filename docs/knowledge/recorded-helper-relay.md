# 録画からのセッションの helper の経路

録画からのセッション（`cli recorded`）で、helper がファイルの音声と映像を読んで server に送る経路を触るときに読む文書。触る場所は、`helper/Sources/HelperCore/FileSessionRelay.swift` の入口 `relayFileSession`、`FileScreen.swift` の `FileScreenReading`・`relayFileScreen`、`FileReadingAlignment`、`ScreenChange.swift` の録画用の進み（`fileProgress`）。出す順の契約、音声をどこまで進めてよいか、どのテストで確かめるかを書く。決定そのものは仕様 [#1612](https://github.com/daiki-beppu/live-mindmap/issues/1612) と、その元の [#1564](https://github.com/daiki-beppu/live-mindmap/issues/1564)・[#1565](https://github.com/daiki-beppu/live-mindmap/issues/1565)・[#1566](https://github.com/daiki-beppu/live-mindmap/issues/1566)・[#1567](https://github.com/daiki-beppu/live-mindmap/issues/1567) にある。

- 用語: [録画からのセッション・共有画面・トラック・重複の印・途中結果・発言・一時停止](../../GLOSSARY.md)
- ADR: [0011 共有画面は、選んだ会議アプリのウィンドウからピッカーを使わずに取り込む](../adr/0011-capture-shared-screen-directly.md)、[0013 話者分離はヘルパーが STT とは別のイベントで流し、サーバーが発言を話者で切る](../adr/0013-diarize-in-helper-split-remarks-by-speaker.md)、[0015 語彙での補正はサーバーが発言を締めるときにかけ、読みはヘルパーが送る](../adr/0015-correct-remarks-in-server-readings-from-helper.md)、[0016 共有画面の OCR は語彙のためだけにヘルパーで行い、文字を画面の通知に載せる](../adr/0016-ocr-shared-screen-only-for-vocabulary.md)
- 関連する知識文書: [セッションの sink](session-sink.md)（受け手の `recordedFeed`）

## 入口は `relayFileSession` 1 つ。`--self` の有無は `mine` が nil かどうかだけで表す

読み手が `相手` だけでも `相手` と `自分` でも、同じ入口が `FileReadingAlignment` に読み手と映像の進みを足し、`relay(tracks:)` で送る。`main.swift` は `FileSessionSource` を組んで渡すだけで、経路を選ばない。読み手が `相手` だけのときは `duplicates: nil`（ライブのイヤホンと同じ）で、`DuplicateMarker` は `自分` があるときだけ作る。映像を読むループも `relayFileScreen` の 1 つだけだ。

前は `相手` だけの経路（`fileSessionEvents`）が別にあり、門・取り消し・`screen-off` の直しを 2 か所に入れる必要があった（[#1625](https://github.com/daiki-beppu/live-mindmap/issues/1625)）。録画にだけ要る振る舞いを足すときも、読み手の数で分岐を作らず、この入口の中に置く。

## 出す順の契約は「時刻 t の `screen` は、end > t の `partial`・`remark` より先」だけ。画面がすべて先、は契約ではない

server の `recordedFeed` は、届いた画面を待ち行列に積み、発言が来るたびに「時刻 < その発言の end」の画面を先に出す。届く順については、この弱い条件にしか頼っていない（[#1564](https://github.com/daiki-beppu/live-mindmap/issues/1564)）。

前の `相手` だけの経路は「画面をすべて送ってから文字起こしの結果」を送り、注にも「サーバーは画面の変化を発言より先に受け取る前提」と書いていた。この強い条件を契約と読むと、映像を最後まで判定するまで発言が 1 件も出ない作りが正しく見える。順を変えたくなったら、まず `recordedFeed` が何に頼っているかを読む。

この順にそろえたので、共有画面に映った語での発言の補正が、画面の直後の発言に間に合わないことがある。ライブと同じ振る舞いとして受け入れている。

## 音声を進めてよい時刻は、映像のフレームの時刻ではなく `fileProgress`。後から作る画面の `start` はその時刻を下限にする

判定器は、変化を確かめてから画面を送る。送る画面の `start` は、変わったマスが変わり始めた時刻の中央値なので、送ると決めたフレームの時刻より前になる。だから「判定したフレームの時刻」まで音声を進めると、その後に出る画面の `start` より遅く終わる発言が先に届き、上の契約が破れる。

逆に「画面のイベントを出したフレームでだけ進める」と、変わらない画面や小さな変化が残った画面で進みが止まり、最初の発言が映像の終わりまで待たされる（[#1625](https://github.com/daiki-beppu/live-mindmap/issues/1625) の 1 回目のレビューの REJECT）。0.25 秒に 40 マスだけ変わって固定し、3 秒で 47 マスに増える動画では、どちらのやり方でも片方が破れた。

今の作りは、判定器が録画のときだけ `fileProgress` を持ち、`fileScreenEvent` で毎フレーム確定させる。`relayFileScreen` は画面を送った後、その値まで `progress.advance(to:)` する。そして一度進めた時刻を、後から作る画面の `start` の下限にもする（`send` の `max(start, fileProgress)`）。進みを先に約束し、画面の側を約束に合わせる。ライブでは `fileProgress` が nil なので `start` は変わらない。

判定器の `start` の決め方や、比較から外すマスの決め方を変えるときは、`ScreenEventTests` の録画の進みのテスト（`smallRecordingChangeCommitsProgress`・`stationaryRecordingAdvancesProgress`・`pendingRecordingProgressSurvivesEncodeFailure`）と、`FileSessionRelayITTests` の `smallChangeDoesNotStallRecording`・`textBesideVideoDoesNotStallRecording` を流す。順の性質を形式仕様で確かめるときは、画面の `start` を判定の時刻と同じにする抽象化をしない。[#1612](https://github.com/daiki-beppu/live-mindmap/issues/1612) の Quint のモデルはそうしていて、この穴を捕まえられなかった。

## 順のテストは早さを確かめない。早く出ることは、映像を止めたまま発言が届くことで見る

`screenPrecedesLaterRemarksWhenVideoIsDelayed` は、最後に映像の門を全部開けてから届いた順を見る。映像が終わるまで発言を溜める作りでも通る。早さの契約は `remarksArriveBeforeVideoFinishes` が、映像を途中で止めたまま `remark 相手` が届くことで確かめる。どちらも `includeMine:` の引数で読み手 1 つ・2 つの両方を回す。

止める位置と台本の発言の終わりは、音声が塊で渡ることを見込んで決める。映像を 2 秒で止めても、16 kHz の fixture で渡った音声の終わりは 1.536 秒だった。発言の終わりを 1.6 秒にした台本は発言を出さずに時間切れになり、1.2 秒に下げて通った。

## 画面の変化を試す fixture の動画は ProRes 4444 で作る

`FileAudioFixtureITTests.swift` の fixture は既定で H.264 だが、小さな変化や動く場所の横の文字を試す動画は `proRes4444` にしている。H.264 だと圧縮で輝度がフレームごとに揺れ、判定器がそのマスを「動いている場所」として比較から外し続け、狙った変化が判定に入らない（[#1625](https://github.com/daiki-beppu/live-mindmap/issues/1625) の 2 回目の直し）。判定に関わる fixture を足すときは、劣化の無い形式から始める。

## 録画の判定器は `withoutTabDetection()` で作り、読み終えたら `finish()` の結果を流す。保留は今は空で、入口からは落ちない

録画にはブラウザのタブが無いので、`FileScreenReading` は `ScreenChangeDetector.withoutTabDetection()`（bundle id が nil）で判定器を作る。前の `ScreenChangeDetector(bundleID: "")` は、空文字がブラウザの bundle id の一覧に無いことでタブの判定を止めていて、意図が名前に出ていなかった（[#1624](https://github.com/daiki-beppu/live-mindmap/issues/1624)）。

映像を読み終えた（`.end`）ときは、`step()` が `detector.finish()` の結果を `.events` で返してから終える。ライブの `ScreenEventEmitter.close` と同じ約束だ。途中で読めなくなったときは `screenEvent(windowGoneAt:)` → `screen-off`（許可なし）、取り消されたときは呼ばない。

タブを判定しないので、保留は今はいつも空で、この約束が破れても入口の IT は落ちない。仕様は入口の IT を足さないと決め、`ScreenEventTests` の単体テストでタブを判定しない作り方の振る舞いだけを確かめている。判定器がタブ以外の理由で画像を溜めるようにするなら、そのときに空でない保留を流すテストを足す。

## 出典

- [録画を読む経路を 1 本にしたとき、「判定の済んだ時刻」がフレームの時刻ではなかった話](../devlog/2026-10-27.md#recorded-relay-one-path)
- 仕様 [#1612](https://github.com/daiki-beppu/live-mindmap/issues/1612)（Formal Spec のコメントを含む）、親 [#1623](https://github.com/daiki-beppu/live-mindmap/issues/1623)
- チケット [#1624](https://github.com/daiki-beppu/live-mindmap/issues/1624)・[PR #1641](https://github.com/daiki-beppu/live-mindmap/pull/1641)、[#1625](https://github.com/daiki-beppu/live-mindmap/issues/1625)・[PR #1644](https://github.com/daiki-beppu/live-mindmap/pull/1644)
- takt の run `20261026-170454-issue-1624-no-no-wo-tabuwo-shi-q0xe0t`・`20261026-185815-issue-1625-karanosesshonno-hel-hdfs52` の計画・実装の報告・レビュー・裁定・直しの計画（最初の版と再計画の版）
