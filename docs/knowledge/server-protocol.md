# CLI と server の受け渡し

CLI と server の間の経路・本文・応答（`server/src/serverProtocol.ts` の `ServerRoutes`）を足す・変えるとき、CLI の `requestServer`、server の `http.ts`、web が送る本文を触るときに読む文書。既定値をどこで補うか、応答を Schema で書き出すときに wire を変えないための注意、どの層で確かめるかを書く。置き場所と `HttpApi` を採らない理由は [ADR 0023](../adr/0023-cli-and-server-share-one-protocol-module.md) にある。

- 用語: 無し（実装の話で、利用者に見える言葉は増えない）
- ADR: [0023 本文と応答の Schema は、CLI と server が import する 1 つのモジュールに置く](../adr/0023-cli-and-server-share-one-protocol-module.md)、[0009 HTTP とブラウザ向けの WebSocket は effect/http で受け、失敗からステータスへの対応は 1 つの表に置く](../adr/0009-http-and-browser-socket-on-effect-http.md)
- 関連する知識文書: [更新の計画](update-plan.md)（`/session/start`・`/session/recorded` の `model`・`judge`）

## 本文の既定値と null は、本文の Schema の decode でだけ補う。確かめるのは `serverProtocol.test`

`audio`・`screen` の省略と null は true、`vocab` の省略は空、`realtime` の省略は false、`title` の null は無し。どれも `SessionStartBody`・`SessionRecordedBody` の decode が補う。`http.ts` と `sessions.ts` には補完を書かない。[#1308](https://github.com/daiki-beppu/live-mindmap/issues/1308)（[PR #1326](https://github.com/daiki-beppu/live-mindmap/pull/1326)）の前は、`toSessionStart` と `startRecordedSession` の 2 か所で補っていた。

null を受けるのは `title`・`audio`・`screen` だけで、`realtime` の null は decode に失敗する（「null の realtime は既定値に読み替えず、decode に失敗する」）。前の `realtime` も null を受けていなかった（`Schema.optionalKey(Schema.Boolean)`）。null は手で送る本文の互換を保つためのものなので、前に受けていなかった欄まで広げない。

補完の規則は `serverProtocol.test` の unit で見る。#1308 は、`http.heavy` にあった省略と null の行をここへ移して消した。HTTP を通す本文と応答の往復は `http.it` に残っている。

## 応答を Schema で書き出すときは、無い欄を `undefined` で持たせず、欄ごと付けない

server は成功の応答を、経路の `response` の Schema で書き出す（`HttpServerResponse.schemaJson`）。`Schema.optionalKey` の欄に `undefined` の値を入れると、その欄は null で書き出され、wire が変わる。#1308 は `/session/status` の `lastInterruptedAt` をこう直した。途切れていないときは、`...(lastInterruptedAt === undefined ? {} : { lastInterruptedAt })` で欄ごと付けない。録画の側の `lastInterruptedAt: undefined` も消した。

応答の値を組む箇所を Schema 化するときは、`undefined` を入れている欄を探し、欄を省く形に直す。古い CLI は、欄が無いことを前提に読んでいる。

## web から本文に型を付けるときは、`import type` と `satisfies typeof X["Encoded"]` にする

web の自分のミュートと話者の名前は、今も `fetch` で送る。本文には `JSON.stringify({ paused } satisfies typeof SelfPauseBody["Encoded"])` のように型だけを付ける（`web/src/app/meeting/command.ts`・`web/src/app/sessionLayout/command.ts`）。`import type` なので、web の bundle に server のモジュールは入らない。値として import すると、`serverProtocol.ts` が import する core と `effect` の Schema が bundle に入る。

web から新しい経路を呼ぶときも同じ形にし、web を `HttpClient` に置き換えない（ADR 0023）。

## 出典

- 仕様 [#1306](https://github.com/daiki-beppu/live-mindmap/issues/1306)、親 [#1307](https://github.com/daiki-beppu/live-mindmap/issues/1307)
- チケット [#1308](https://github.com/daiki-beppu/live-mindmap/issues/1308)・[PR #1326](https://github.com/daiki-beppu/live-mindmap/pull/1326) の差分
- PR のレビューの takt の run（`20261018-001428-evaluate-pull-request-1326-usi`）のレビューと裁定
