# 本文と応答の Schema は、CLI と server が import する 1 つのモジュールに置く

> ADR 0009 の「依頼の本文の Schema は HTTP のモジュールに置く」を置き換えた。それ以外（`HttpRouter` と `NodeHttpServer` で受けること、応答の形、失敗からステータスへの対応の表、Origin の制限、`Viewers`）は、ADR 0009 のまま。

CLI と server の間の要求・応答の形を、両側が import する 1 つのモジュール（`server/src/serverProtocol.ts`）に置く（[#1308](https://github.com/daiki-beppu/live-mindmap/issues/1308)、仕様 [#1306](https://github.com/daiki-beppu/live-mindmap/issues/1306)）。これまでは、本文の Schema が server の HTTP のモジュールにあり、CLI は本文を `object` のリテラルで、パスを文字列で書いていた。応答の Schema も CLI 側に写しがあり、送る本文が server の受ける Schema に合うかは、結合テストで落ちるまで分からなかった。

- **経路ごとに `{ method, path, body?, response }` を 1 つの値にして並べる**。17 本（`/apps`・`/session/*`・`/share/*`・`/server`・`/check`・`/deps/*`・`/update`・`/ws`）が対象。CLI の `requestServer` は経路の記述と、その `body` の Schema の `Encoded` 型の値を受け取り、server の `HttpRouter.route` は同じ記述の `method`・`path`・`body` を使う。本文の欄を書き間違えると `pnpm typecheck` が落ちる
- **server は成功応答を、記述の `response` の Schema で書き出す**（`HttpServerResponse.schemaJson`）。CLI は同じ Schema で読む。書き出せない（応答の値が Schema に合わない）のは server 側の不具合なので defect とし、表にない失敗と同じく 500 で返す
- **ドメインの値である応答（取り込みの状態・共有の状態・録画の経過）の Schema は core に置き**、TS の型はそこから導く。ADR 0009 の「運び方の都合なので core には置かない」は、本文と経路の記述についてだけ保つ
- **nullable と省略の既定値は、本文の Schema の decode で 1 回だけ補う**。`audio`・`screen` は true、`vocab` は空、`realtime` は false、`title` の null は無し。null は今まで通り受ける（手で送った本文の互換）
- **失敗は経路の記述に宣言しない**。失敗からステータスへの対応は、ADR 0009 の表 1 つのまま
- **wire の形は変えない**。パス・本文・応答・ステータス・ヘッダー・NDJSON の stream・204 は今のままで、古い CLI と新しい server の組み合わせ（またはその逆）でも動く
- **web は型だけを import する**。自分のミュート・話者の名前の本文に、共有モジュールの `Encoded` 型を付ける（`import type` なので bundle は増えない）。web を `HttpClient` に置き換えることはしない

## Considered Options

- **`effect/http-api`（`HttpApi`）で宣言的に書く**: 採らない。理由は 3 つ。
  1. stream の経路・応答ヘッダー・204・`StartupRefusal` を `HttpApi` の宣言に合わせて書き直すことになり、1 つの表で回っている失敗からステータスへの対応も経路ごとに散らばる
  2. 型で確かめたいのは「送る本文が受ける Schema に合うか」だけで、Schema を共有すれば足りる（OpenAPI の出力も外部のクライアントも要らない）
  3. `effect/http-api` も unstable で、exact pin の点検の対象がさらに増える
- **本文の Schema を HTTP のモジュールに置いたまま、CLI が import する**: CLI が server の HTTP の実装（`node:http`・`ws`）を読み込むことになる。web も型を取れない

## Consequences

- 本文と応答の形を変えるときは、共有モジュールの 1 か所を直す。CLI・server・web の型検査がそろって落ちるので、片側だけの更新に気づける
- 共有モジュールは `effect` の Schema だけを import する純粋なモジュールにする（web の型検査が Node の型や `effect/http` に依存しないため）
