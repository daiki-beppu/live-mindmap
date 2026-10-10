# ホスティングするときは Cloudflare と Alchemy を使う。今はホスティングしない

live-mindmap をどこかに載せる日が来たら、載せ先は Cloudflare（Workers とその周り）にし、構成は Alchemy で書く。ただし今は載せない。パイプラインはローカルの Node サーバーが持ち（ADR 0003）、ローカルモードは live-mindmap が起動する子プロセスに限る（ADR 0014）。この 2 つはそのまま据え置く。外から見せたいときは、ローカルのサーバーを Cloudflare Tunnel で閲覧だけ開く（地図 [#734](https://github.com/daiki-beppu/live-mindmap/issues/734)、[#738](https://github.com/daiki-beppu/live-mindmap/issues/738)）。

選んだ理由は、server がすでに Effect 4 で書かれていて（ADR 0007〜0010）、web も Foldkit で Effect に寄せると決めたことにある（[#736](https://github.com/daiki-beppu/live-mindmap/issues/736)）。Effect 4 の `HttpRouter.toWebHandler` は Web の `Request` を受けて `Response` を返す関数を作るので、今の HTTP の層をそのまま Workers の `fetch` に渡せる（[HttpRouter](https://effect.website/docs/v4/api/effect/unstable/http/HttpRouter)、手元の `effect@4.0.1` の `effect/http` にもある）。Alchemy v2 は Effect で書く IaC で、Cloudflare の Workers・Durable Objects・R2・KV・D1 などを扱う（[What is Alchemy?](https://alchemy.run/what-is-alchemy/)）。npm の `alchemy@2.0.0-beta.81`（2026-10-10 時点の `latest`）は `effect@^4.0.0` を peer に取る。アプリと構成を同じ言語・同じ型で書ける組み合わせは、ほかに無い。CAFE stack（[Effect-TS/cafe](https://github.com/Effect-TS/cafe)）として Effect の組織が同じ組み合わせを示していることも、追従の見込みとして数えた。

## 今は載せない理由

今の作りの中心は、Workers に載らない。

- **Claude の呼び出し**: Agent SDK は Claude Code の CLI を子プロセスとして起動する。Workers の `node:child_process` は、読み込めるだけで動かないスタブである（[Compatibility flags](https://developers.cloudflare.com/workers/configuration/compatibility-flags/) の `enable_nodejs_child_process_module`）。また、自分で使う分はサブスクの認証で呼んでいるが（ADR 0003）、Anthropic の規約は、第三者の開発者が利用者のサブスクの認証で要求を送ることを認めていない（[Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)、ADR 0004）
- **ヘルパー**: Mac の音声の取り込み・AEC3・SpeechAnalyzer を使う Swift のプロセスで、利用者の Mac でしか動かない（ADR 0002・0008）
- **Apple Intelligence**: ローカルモードの差分更新は、サーバーが起動する子プロセスである（ADR 0012・0014）

## 載せるのはいつか

配布の形が変わったときに限る。たとえば、差分更新の呼び出しを API キーで Anthropic API を直接呼ぶ実装に差し替え（ADR 0003 の Consequences）、セッションの状態を複数の端末で持ち合う必要が出たとき（会議中の共同編集、[#385](https://github.com/daiki-beppu/live-mindmap/issues/385)）である。そのときもヘルパーは Mac に残るので、載るのはサーバーの一部と web だけになる。Workers・Durable Objects・Sandbox への割り振りは、その時点で決める。

## Considered Options

- **今のうちに Workers へ載せる**: 上の 3 つが載らず、載せられる部分だけを分けると、ローカルのサーバーと二重に持つことになる。閲覧の共有は Tunnel で足りる
- **Terraform・Pulumi・Wrangler の設定だけで構成を書く**: どれでも Cloudflare に載せられるが、構成とアプリが別の言語・別の型になり、バインディングを環境変数と文字列でつなぎ直す。Effect にそろえる動機（地図 #734 の Notes）と逆を向く
- **Vercel・Fly.io など別の載せ先**: 長く動く接続（WebSocket）と状態を持つ Durable Objects、閲覧の共有に使う Tunnel が同じ Cloudflare にそろう利点が無い

## Consequences

- 載せ先を決めたのは「選ぶ基盤」だけである。この ADR を根拠に、今のコードを Workers 向けに書き換えない。ADR 0003 の「Node の実行環境に依存しない中核」は、Workers でも Node でも動く形として引き続き効く
- Alchemy v2 は 2026-10-10 時点で beta である。載せる日が来たら、まず版と提供範囲を確かめ直す
- `effect` を exact で固定している（AGENTS.md）ため、Alchemy を入れるときは、その版の peer が server・web の `effect` と 1 つにそろうかを確かめる
