# Cloudflare OS をエクスポートの公開の社内向けの公開先にできるか（Issue #1214）

地図 [#1206](https://github.com/daiki-beppu/live-mindmap/issues/1206) の調査チケット [#1214](https://github.com/daiki-beppu/live-mindmap/issues/1214)。会社の Cloudflare OS に、会議の後のエクスポート（1 ファイルの HTML、数 MB〜25MB）を外から置き、社内の権限で見せられるかを一次資料で調べた。

- 調べた日: 2026-10-16
- ソース: `cloudflare/cloudflare-os` の `main`（コミット `ca8bbeb`、2026-10-15）を shallow clone して読んだ。コードは動かしていない
- ほかの資料: `cloudflare/cloudflare-os-starter` の README、Cloudflare のブログ 2 本とプレスリリース、Cloudflare Access の docs
- 会社の Cloudflare OS の実物（設定・版・サインインの方式）は見ていない。**［未確認］** と付けたものは一次資料で裏が取れていない

## 結論

- **エクスポートの公開の公開先には向かない。** 外から文書やアプリを置くための公開の口（REST API・CLI・MCP サーバー）が無い。置いたものに期限を付ける仕組みも無い。見る人は全員、その Cloudflare OS にアカウントが要る
- **外から置く道は、Web 画面が使う内部の RPC しか無い。** `/api` は Cap'n Web RPC で、`authenticate(token)` や `newGadget()` が呼べる。ただし文書化された外向けの API ではない。Cloudflare Access の構成では Origin と Access の JWT（email 入り）を確かめるので、CLI から呼ぶには手が要る。early access で版の保証も無い
- **HTML をそのまま置けない。** ガジェットの UI は `client.js` が DOM を組み立てる形で、`index.html` は無い。CSP で外への通信を止めている。`map.html` は `client.js`（＋必要なら `server.js`）に組み直す必要がある。組み直すなら、作るのは「Cloudflare OS 向けのマップのビューア」という別の製品になる
- **社内の権限はよく効く。** ガジェットは既定で非公開で、共有した相手は `use`（見て触るだけ）か `build` のどちらか。外すとすぐ切れる。開いた記録はアナリティクスのイベント（`gadget_opened`）として残る。ただし社外の人に見せる口は無い（Access の構成ならポリシーに入っている人だけ）
- **今やるなら、利用者が手で置く運用に留める。** 例: map.html をチャットに添付し、エージェントにガジェット化を頼む。ただし添付は 1 件 4MB まで。live-mindmap の製品の機能にはしない（理由は「マップを HTML のまま置くか、組み直すか」の節）

## 1. 外から置く口と、期限・削除

### 公開の口（API・CLI・MCP）は無い

- README とブログには、外から文書やアプリを入れる API・CLI・MCP の説明が無い [1][2][3]。ブログにある外とのつなぎは Gatekeeper（Cloudflare OS から外のサービスへ出ていく側）と、MCP Server Portals（組織の MCP サーバーを Cloudflare OS から呼ぶ側）だけで、どちらも向きが逆 [2][9]
- MCP の Gatekeeper（`gatekeeper-mcp`・`gatekeeper-mcp-portal`）は「外の MCP サーバーを Gadget の能力としてつなぐ」もの。Cloudflare OS 自身が MCP サーバーになるのではない [9]

### Web 画面が使う内部の RPC

- backend の HTTP の入口は 5 つ: ロゴ、ブループリントのスクリーンショット、`/api/client-errors`、`/api/device-session/callback`、`/api`。`/api` は Cap'n Web RPC で、POST（HTTP バッチ）と WebSocket を受ける。どちらでもない要求は 404 か 400 を返す（`packages/workshop-backend/src/server.ts`）
- `PublicApi` には次がある（`packages/workshop-shared/src/api.ts`）:
  - サインイン: `authenticate(token)`（`<user-id>:<secret>` の形）、`authenticateFromCfAccess()`
  - ガジェット: `newGadget()` で作る。コードの書き込みは `submitCodeChange(chatId, …)` で、1 件 8,000,000 バイトまで（`MAX_CODE_CHANGE_SIZE`）。これはエディタの OT（操作変換）用の仕組み
  - 削除: `deleteSelf()`（オーナーだけ）
  - ブループリントの取り込み: `importBlueprint(archive)`。`.gadget` ファイルを取り込み、1 パックは 32MiB まで（`MAX_RELEASE_PACK_BYTES`）
  - チャットへの添付: `uploadChatAttachment`。1 件 4MiB まで、1 メッセージで合計 5MiB まで（`chat-attachment-validation.ts`、`overseer.ts`）
- この RPC は Web 画面のための内部の契約で、外向けの文書化や互換の約束は無い。コード中の型名やコメントは版ごとに変わっている（例: `ChatCodeBase` の generation の扱い）

### 期限は無い

- 共有リンクの期限・使用回数の制限は「Future work」にある（`docs/sharing.md` の「Share link expiration and usage limits」）。今は無い [4]
- ガジェット自体に TTL は無い。消すにはオーナーが `deleteSelf()` を呼ぶ。期限で自動に消すには、ガジェット自身の作り（例: スケジューラの Gatekeeper で自分を消す）で組む必要がある。そうできるかは**［未確認］**

## 2. 誰が見られるか（社内の権限・記録・社外）

- **見るには全員アカウントが要る。** ガジェットは既定で非公開 [1][2]。共有の方法は 2 つ: 相手を名前で足す（OAuth か Access の構成ならメールアドレス）か、共有リンク（`#share=<key>`）を渡す。リンクを開いた人は collaborator（共同作業者）として足される。開く人は、その Cloudflare OS にサインインしている必要がある [4]
- **権限は 2 段。** `build` は編集・AI チャットまでできる。`use` は「デプロイ済みの UI を表示して操作するだけ」[4]。マップを見せる用途なら `use` で足りる
- **外すとすぐ切れる。** 外したりリンクを取り消したりすると、Overseer の DO を再起動して開いている接続も切る（約 100ms）[4]
- **Gatekeeper の read-through の権限（observer）。** ガジェットが Gatekeeper を通して読んだデータがあれば、開く人もそのデータを読める権限があるか確かめられる。無ければ開けない [5]。外から置いた HTML のマップは Gatekeeper を通して読まないので、この確認は効かない。効くのは Cloudflare OS への入場（Access）と、共有の相手の指定だけ
- **アクセスの記録。** 開くたびに `gadget_opened`（ユーザー ID、ガジェット ID、直接かリンクか）がプロダクトのアナリティクスに送られる（`analytics.ts`、`overseer.ts`）。送り先の `PRODUCT_ANALYTICS` のバインディングが無ければ送らない。管理者がそれをどこで見るかは**［未確認］**。Gatekeeper の「全操作の記録」は、ガジェットやエージェントが外のサービスに対して行った操作の記録で、人が見たことの記録ではない [1]
- **社外の人に見せる口は無い。**
  - ブループリントのリンク（`/blueprint/<id>`）はサインインなしで開けるが、見えるのはメタデータ（題・説明・作者・要るバインディング）だけ [6]
  - Cloudflare Access の構成（starter の既定 [7]、マネージド版も Access のポリシー [3]）では、ポリシーに入っていない人はそもそも入れない
  - パスワードの構成で新規登録を開ければ社外の人もアカウントを作れる（管理画面の `setSignupsEnabled`）。ただしそれは社内のワークスペースに社外の人を入れることになる

## 3. 置く側の認証（CLI から何を用意するか）

- **公式の CLI 向けの認証は無い。** デバイス・セッション（`/api/device-session/callback`）は Cloudflare OS のネイティブアプリとデスクトップアプリのための仕組みで、`127.0.0.1:<port>` に戻すデスクトップ用の形もある [8]。ただしそのアプリ以外の CLI に開かれた契約としては書かれていない
- **Access の構成で `/api` に入るには 2 つの条件がある**（`server.ts`）:
  1. `Origin` ヘッダーがそのホストと一致すること
  2. `cf-access-jwt-assertion` の JWT が検証でき、`email` を含むこと
- CLI から用意するものは、利用者の Access の JWT（例: `cloudflared access login` で取るもの）と、Origin を付けた Cap'n Web のクライアント。Access のサービストークン（`CF-Access-Client-Id`・`CF-Access-Client-Secret` のヘッダー [10]）では JWT に `email` が入らないと思われ、`/api` は 403 を返すはず。**［未確認］**（サービストークンの JWT の中身は docs に書いていない）
- **パスワードの構成**なら、`login(username, passwordHash)` の戻り値のトークンを `authenticate()` に渡せば入れる。どちらにしても会社の Cloudflare OS がどの構成かによる。**［未確認］**

## 4. early access の提供範囲と変わりやすさ

- README:「This repository is actually version 2, a complete rewrite」「As of the August 2026 release ... consider this an "early access" release」[1]
- starter:「Cloudflare OS is early-access software. Pin upstream releases, review changes, and verify the trust boundary before every production upgrade.」。starter は upstream を固定した版（git submodule）で配る [7]
- GitHub Releases は 0 件で、タグも無い。版は starter が固定するコミットか、`scripts/release/` が作るリリースで決まる（2026-10-16 時点）
- 外部からの貢献は受けていない（README の Contributing）[1]
- マネージド版はウェイトリストのみ（2026-10-01 のブログ）。一般提供の日付・料金・版の扱いは書いていない [3]
- 公開日: プレスリリースとブログは 2026-08-05 [2][11]。社内の v1 は 2026-05 [2]
- 内部の RPC は外向けの契約ではなく、`main` は毎日のように更新されている（pushed_at 2026-10-16）。live-mindmap がこれに依存すると、会社の固定版が上がるたびに壊れうる

## 5. マップを HTML のまま置くか、組み直すか

**HTML のまま置くことはできない。**

- ガジェットのエージェント向けの説明:「Note that there is no index.html. Instead, client.js must build the entire UI using JavaScript code.」（`packages/workshop-backend/src/agent.ts`）
- クライアントは sandbox の iframe で動き、CSP は次のとおり（`GadgetUI.tsx`）:

  ```
  default-src 'none'; script-src data: 'unsafe-inline'; style-src data: 'unsafe-inline'; img-src data:; media-src data:; connect-src 'none'
  ```

- 外部の CDN・フォント・`fetch` は使えない。`alert`・`confirm` も使えない

**組み直すなら:**

- `map.html` は 1 ファイルで、中身（ノード・字幕）を埋め込んだ HTML。これを「`client.js` が DOM を組む」形に変える。データは `server.js` の Durable Object のストレージに入れる
- 外から書き込む口が `submitCodeChange`（8MB/件、OT の契約）か、`.gadget` のブループリントの取り込み（32MiB）しか無い。25MB 近い `map-audio.html` は前者に入らない
- 組み直すと、live-mindmap が Cloudflare OS 向けのビューアを持ち、上流の版に追従し続けることになる。#1206 の「エクスポートを置く」から外れ、Out of scope の「Cloudflare OS に載せる」に近づく
- Cloudflare OS の得意な形（チャットで Docs や Slides の文書にまとめる、エージェントが組み直す）に寄せるなら、利用者が `map.html` を添付して頼む運用の方が合う。ただし添付は 4MiB まで

## 未確認のこと

- 会社の Cloudflare OS の構成（Access かパスワードか）、固定している版、新規登録・ユーザー検索の設定
- Access のサービストークンで `/api` に入れるか（JWT の `email`）
- `gadget_opened` のアナリティクスを管理者がどこで見られるか
- ガジェット自身がスケジューラで自分を消せるか（期限の代わり）

## 出典

1. cloudflare/cloudflare-os README（`ca8bbeb`）https://github.com/cloudflare/cloudflare-os/blob/ca8bbeb762a4e76e42220a41f233ecabe8760d89/README.md
2. Cloudflare OS: an open platform for agents, apps, and work（2026-08-05）https://blog.cloudflare.com/cloudflare-os/
3. Cloudflare OS: your company's agent workspace, managed for you（2026-10-01）https://blog.cloudflare.com/managed-cloudflare-os/
4. docs/sharing.md https://github.com/cloudflare/cloudflare-os/blob/ca8bbeb762a4e76e42220a41f233ecabe8760d89/docs/sharing.md
5. docs/observers.md https://github.com/cloudflare/cloudflare-os/blob/ca8bbeb762a4e76e42220a41f233ecabe8760d89/docs/observers.md
6. docs/blueprints.md https://github.com/cloudflare/cloudflare-os/blob/ca8bbeb762a4e76e42220a41f233ecabe8760d89/docs/blueprints.md
7. cloudflare/cloudflare-os-starter README https://github.com/cloudflare/cloudflare-os-starter
8. docs/oauth-signin.md https://github.com/cloudflare/cloudflare-os/blob/ca8bbeb762a4e76e42220a41f233ecabe8760d89/docs/oauth-signin.md
9. packages/gatekeeper-mcp-portal/README.md・packages/gatekeeper-mcp/README.md（同コミット）
10. Cloudflare Access: Service tokens https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/
11. プレスリリース（2026-08-05）https://www.cloudflare.com/press/press-releases/2026/cloudflare-os-is-the-first-ai-workspace-built-around-how-companies-actually-work/

ソースの該当箇所: `packages/workshop-backend/src/server.ts`（入口と Access の確認）、`packages/workshop-shared/src/api.ts`（RPC）、`packages/workshop-shared/src/code-change.ts`（`MAX_CODE_CHANGE_SIZE`）、`packages/workshop-backend/src/blueprint-release.ts`（`MAX_RELEASE_PACK_BYTES`）、`packages/workshop-backend/src/chat-attachment-validation.ts`、`packages/workshop-backend/src/agent.ts`（ガジェットの形）、`packages/workshop-frontend/src/GadgetUI.tsx`（CSP）、`packages/workshop-backend/src/analytics.ts`。
