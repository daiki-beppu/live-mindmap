# HTTP とブラウザ向けの WebSocket は effect/http で受け、失敗からステータスへの対応は 1 つの表に置く

server を Effect 4 へ置き換える（[#193](https://github.com/daiki-beppu/live-mindmap/issues/193)）にあたって、HTTP の受け口（`/apps`・`/session/*`）とブラウザ向けの WebSocket（`/ws`、今の `ws.ts`）を次の形で書く（[#204](https://github.com/daiki-beppu/live-mindmap/issues/204)）。

- **`effect/http` の `HttpRouter` と、`@effect/platform-node` の `NodeHttpServer` で受ける**。`/ws` は同じサーバー・同じポートで `HttpServerRequest.upgrade` を受け、`Socket` で送る。`node:http` と `ws` には直接依存せず、`RequestError` もやめる
- **応答の形は変えない**。失敗は `{ "error": "<文面>" }` とステータス（400・403・404・409・503・500）で返し、呼び出し元の cli は触らない。defect も文面を伏せずに 500 で返す（127.0.0.1 だけで待ち受け、呼び出し元は自分の cli なので、調べやすさを取る）
- **タグ付きの失敗からステータスへの対応は、HTTP のモジュールの表 1 つに置く**。表は `Record<タグ, ステータス>` で型を付け、タグが増えたら対応を足すまで型エラーにする。`Sessions` の失敗は HTTP を知らない。表にない失敗と defect は `causeResponse` で 500 にする
- **依頼の本文の Schema は HTTP のモジュールに置き**、`schemaBodyJson` で検証する。落ちたら 400 で、文面は Schema の既定のもの（本文を作るのは cli で、壊れた本文は手で送ったときしか来ない）。運び方の都合なので core には置かない
- **Origin の制限は `HttpRouter` のミドルウェア 1 つ**にし、HTTP と `/ws` の upgrade の両方に掛ける
- **ブラウザへ送る側は `Viewers` という Service** にする。最後に送った値（スナップショット、トラックごとの話している文字、取り込みの状態）は `Ref` に持ち、新しい値は `PubSub` に流す。つないだクライアントごとに Fiber を 1 本立て、**先に購読してから**保持している値を送る（逆にすると、その間に来た値を取りこぼす）。切れたら Fiber ごと終わる

## Considered Options

- **`node:http` と `ws` を安定した API（`acquireRelease`・`Effect.callback`・`FiberSet.makeRuntime`）で包む**: 安定した API だけで済む。ただし unstable を受け入れる判断は ADR 0008 で済んでいて、HTTP だけ包んでも安定性は増えない
- **`effect/http-api`（`HttpApi`）で宣言的に書く**: エンドポイントと失敗を型で宣言でき、OpenAPI も出せる。エンドポイントは 5 本、呼び出し元は自分の cli だけで、重すぎる
- **失敗のクラスごとに `HttpServerRespondable` を実装する**: ステータスが失敗の定義の横に来る。ただしドメインの失敗が HTTP に依存する

## Consequences

- `effect/http` も `@stability unstable`。ADR 0008 と同じく exact pin にし、上げるときは `effect/http`・`effect/socket` の変更も確かめる
- 許可しない Origin から `/ws` につないだときの応答は、401（`ws` の `verifyClient`）から 403 に変わる。ブラウザから見ればどちらも接続の失敗
