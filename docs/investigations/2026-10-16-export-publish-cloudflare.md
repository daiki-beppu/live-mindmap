# 期限つきで静的な HTML を置く Cloudflare の方式（Issue #1207）

エクスポートの公開（地図 [#1206](https://github.com/daiki-beppu/live-mindmap/issues/1206)）で、1 ファイル・数 MB〜25MB の HTML を Cloudflare に期限つきで置き、URL で見せる方式の事実を、Cloudflare の一次資料（developers.cloudflare.com と API リファレンス、npm レジストリ）で調べた。2026-10-16 時点。手で触っての確認はしていない。資料から読み取った推測は「推測」と書いた。

## 結論

- **Workers Static Assets が向く。** Pages の公式ページ自体が「新しいプロジェクトは Workers で始める」と書いている。1 ファイルの上限はどちらも **25 MiB**。数の上限は Pages が 1 アカウント **100 プロジェクト**、Workers が **100（Free）/ 500（Paid）**。
- **利用者の Cloudflare アカウントは要る。** アカウント無しの一時の置き場（Claim Deployments の一時アカウント）はあるが、**60 分で消え、静的ファイルは 1 つ 5 MiB まで**なので、この用途には使えない。
- **最小の権限は Account の Workers の Admin（Workers Scripts Write）1 つ。** 新しい Worker を作るには製品単位の Admin が要る。削除も同じ権限で済む。
- **`wrangler` は要らない。** Workers の静的ファイルは、公開の REST API（Direct Upload）だけで置ける。`wrangler` は workerd 込みで 180MB を超えるので、使うなら ADR 0017 の管理ディレクトリ行き。Pages は、内容をアップロードする手順が公開の API リファレンスに無く、実質 `wrangler` が要る。
- **期限は「Worker が 410 を返す」と「Worker ごと消す」を組み合わせる。** 410 は Worker のコードに期限を焼き込めば、誰も何も流さなくても期限で効く。消すのは、次に CLI を使ったとき（ローカルが API で消す）が素直。Cron Triggers で Worker が自分を消すには API トークンを Worker に secret で持たせる必要があり、無料枠では Cron は 1 アカウント 5 個まで。
- **Access（メールの PIN）は無料枠でかけられる。** Zero Trust Free は 50 ユーザーまで $0。ただし Zero Trust の組織を作るときに支払い情報の入力が要る（課金はされない）。新しい組織の既定のログイン方法は Cloudflare アカウントで、OTP は自分で足す。
- **AI Crawl Control は `*.workers.dev`・`*.pages.dev` には効かないと見るべき（推測）。** 設定はドメイン（ゾーン）単位で、ダッシュボードでドメインを選んで開く。既定のドメインは利用者のゾーンではない。資料にこの 2 つへの言及は無い。AI の拒否は robots.txt・`X-Robots-Tag`・Worker での UA 判定で自前で行う。

## 1. Pages（Direct Upload）か Workers Static Assets か

| | Pages（Direct Upload） | Workers Static Assets |
|---|---|---|
| 1 ファイルの上限 | 25 MiB | 25 MiB（Free・Paid とも） |
| 1 サイトのファイル数 | 20,000（Free）/ 100,000（Paid） | 20,000（Free）/ 100,000（Paid）/ 版 |
| 数の上限 | 1 アカウント 100 プロジェクト（「通常は上げない」） | 1 アカウント 100 Worker（Free）/ 500（Paid）。Pages とは別枠 |
| REST API だけで置けるか | 内容のアップロード手順が公開されていない | 公開・文書化済み（Direct Upload） |
| 期限で 410 | Functions（`functions/_middleware.js`）。ドラッグ＆ドロップでは Functions は動かず、`wrangler` が要る | `assets.run_worker_first: true` の Worker |
| 位置づけ | 「Workers がほとんどの用途を覆う。新しいプロジェクトは Workers で」 | Cloudflare の主たる基盤 |

- Pages の上限: [Pages Limits](https://developers.cloudflare.com/pages/platform/limits/)（「The maximum file size for a single Cloudflare Pages site asset is 25 MiB」「Cloudflare Pages has a limit of 100 projects per account. This limit is not routinely increased.」。作り始めの 48 時間は新規プロジェクト作成も絞られる）
- Workers の上限: [Workers Limits](https://developers.cloudflare.com/workers/platform/limits/)（Individual Static Asset file size 25 MiB、Number of Workers 100 / 500、Cron Triggers per account 5 / 250）
- Pages の位置づけ: [Cloudflare Pages](https://developers.cloudflare.com/pages/)（「Are you sure you want to use Pages? Workers supports most Pages use cases … Start new projects with Workers.」）
- Pages のドラッグ＆ドロップでは `functions` が動かない: [Direct Upload](https://developers.cloudflare.com/pages/get-started/direct-upload/)（「To deploy a `functions` folder, you must use Wrangler」。ドラッグ＆ドロップは 1,000 ファイル・25 MiB まで）

**1 回の公開を 1 Worker にすると、Free で同時に 100 本まで**（他の Worker と共有）。1 本の Worker に複数の公開をパスで載せる形もあるが、そのときは 1 つを消すのに版を作り直すことになり、Access も Worker 単位でかかる（下の 6）。どちらにするかは製品側の判断。

### 料金で効くこと

静的ファイルへのリクエストは Free・Paid とも無料・無制限。ただし Worker を通すと Worker のリクエストとして数えられ、Free は 1 日 100,000 リクエスト（Pages Functions も同じ枠）。`run_worker_first: true` にすると全リクエストが数えられる。

- [Workers Pricing](https://developers.cloudflare.com/workers/platform/pricing/)（「Requests to static assets are free and unlimited.」）
- [Pages Functions Pricing](https://developers.cloudflare.com/pages/functions/pricing/)（「A request is considered static when it does not invoke Functions.」「50,000 Functions requests and 50,000 Workers requests to use your full 100,000 daily request usage」）

## 2. アカウントは要るか。アカウント無しの一時の置き場はあるか

ある。**Claim Deployments（一時アカウント）**。`wrangler deploy --temporary`（Wrangler 4.102.0 以上）か、REST API（`POST /client/v4/provisioning/previews/challenge` で proof-of-work を受け、解いて `POST /client/v4/provisioning/previews`、返った一時トークンで Workers Script Upload API）で、ログインせずに `workers.dev` に置ける。

ただしこの用途には合わない。

- **60 分で消える。** 「You have 60 minutes to claim the account. If you don't, Cloudflare deletes the account and its resources.」
- **静的ファイルは 1,000 個・1 つ 5 MiB まで。** map.html（数 MB〜25MB）は多くが入らない。
- 利用規約への同意が要り、作成はレート制限され、乱用の検査で断られることがある。
- 出典: [Claim Deployments](https://developers.cloudflare.com/workers/platform/claim-deployments/)

それ以外に、アカウント無しで静的ファイルを置ける Cloudflare の提供物は見つからなかった。したがって**利用者の Cloudflare アカウントは要る**。閲覧の共有の「アカウント・ドメインを前提にしない」と食い違うかは、地図の側で判断する（このチケットでは事実だけ）。

## 3. API トークンの最小の権限と、作る手順

### 最小の権限

Workers Static Assets で、公開のたびに Worker を作り、期限後に消すなら:

- **Account › Workers の Admin（製品単位）**。API の権限名では `Workers Scripts Write`（ダッシュボードの一覧では `Workers Scripts Edit`）。
  - 「Creating new Workers requires product-level `Admin` access.」。`Editor` は既存の Worker の更新・デプロイだけで、作成・削除はできない（[Workers authorization](https://developers.cloudflare.com/workers/authorization/workers/)）
  - 削除 `DELETE /accounts/{account_id}/workers/scripts/{script_name}` は `Workers Scripts Write` / `Workers Admin` / `Individual Workers Admin` のどれか（[API: Delete Worker](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/delete/)）
- `workers.dev` で出すだけなら Zone の権限（`Workers Routes Write`）は要らない。カスタムドメインに付けるときだけ要る。
- Access を API で Worker にかけるなら、加えて Access のアプリ・ポリシーの書き込み（`Access: Apps and Policies Write`）が要る（[Workers の Cloudflare Access](https://developers.cloudflare.com/workers/configuration/cloudflare-access/) は `POST /accounts/{account_id}/access/apps` に destination `worker` を渡す形。具体的な権限名はそのページに無く、[権限の一覧](https://developers.cloudflare.com/fundamentals/api/reference/permissions/)の名前から推した）。
- トークンのほかに **アカウント ID** が要る（`CLOUDFLARE_ACCOUNT_ID`）。

Pages なら `Pages Write`（作成・更新・削除）1 つ（同じ [Workers authorization](https://developers.cloudflare.com/workers/authorization/workers/) の Cloudflare Pages の節）。

### 利用者に作ってもらう手順

[Create API token](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/) より:

1. ダッシュボードで **My Profile › API Tokens**（利用者に紐付くトークン）か **Manage Account › API Tokens**（アカウントに紐付くトークン。人に紐付かないサービス用）を開く
2. **Create Token** → テンプレートではなく **Create custom token**
3. 名前を付け、権限に Account › Workers（Admin / Scripts Edit）を選び、対象のアカウントを選ぶ
4. 任意で **Client IP Address Filtering** と **TTL** を付ける
5. **Continue to summary** → **Create Token**。秘密は**一度しか表示されない**ので控える

`wrangler login`（OAuth）でもよいが、細かい権限は付けられない（「The `wrangler login` OAuth flow does not currently support granular authorization.」[Authorization](https://developers.cloudflare.com/workers/authorization/)）。

## 4. `wrangler` は要るか。REST API だけで置けるか

### Workers: REST API だけで置ける

[Workers Static Assets の Direct Upload](https://developers.cloudflare.com/workers/static-assets/direct-upload/) が、`wrangler` を使わない手順を公開している。

1. `POST /accounts/{account_id}/workers/scripts/{script_name}/assets-upload-session` に manifest（パス → 32 桁 16 進のハッシュとサイズ）を送る。返る JWT は 1 時間有効
2. `POST /accounts/{account_id}/workers/assets/upload?base64=true` に、返された bucket ごとに multipart で base64 の中身を送る（認証はさっきの JWT）。全部送ると完了の JWT が返る（1 時間有効）
3. `PUT /accounts/{account_id}/workers/scripts/{script_name}` で Worker のコード（410・AI の拒否をする小さなスクリプト）と完了の JWT を付けて版を作り、デプロイする

`cloudflare` の TypeScript SDK の例もあるが、SDK は npm で約 71MB（`cloudflare@7.3.0` の unpackedSize）。手順は `fetch` 3 種で書けるので SDK も要らない。

### Pages: 実質 `wrangler` が要る

`POST /accounts/{account_id}/pages/projects/{project_name}/deployments`（`Pages Write`）は manifest と `_headers`・`_worker.js` 等を受けるが、ファイルの中身をアップロードする手順は API リファレンスに書かれていない（[API: Create deployment](https://developers.cloudflare.com/api/resources/pages/subresources/projects/subresources/deployments/methods/create/)）。Direct Upload の案内も `wrangler pages deploy` とダッシュボードのドラッグ＆ドロップだけ（[Direct Upload](https://developers.cloudflare.com/pages/get-started/direct-upload/)）。

### `wrangler` を使う場合の固定

- Cloudflare は「プロジェクトにローカルで入れる」ことを勧め、版をプロジェクトごとにそろえられると書いている（[Install/Update Wrangler](https://developers.cloudflare.com/workers/wrangler/install-and-update/)）。完全一致の版で lock を置けば、ADR 0017 の管理ディレクトリ（`server/managed/<名前>/` の `package.json` と `package-lock.json`、`npm ci`）にそのまま載る。`npx wrangler` は入っていないと最新版を使うので、固定するなら管理ディレクトリから呼ぶ。
- 重さ（npm レジストリ、2026-10-16）: `wrangler@4.151.0` 本体 約 16MB、依存の `@cloudflare/workerd-darwin-arm64` 約 135MB、`miniflare` 約 23MB、ほかに `esbuild`。**合わせて 180MB を超える**ので、ADR 0017 の「重い依存」に当たる。`engines.node` は `>=22.0.0`。
- 公開だけのために `wrangler` を入れる理由は、Workers なら無い。

## 5. 期限の切れ方と、消す処理を誰が流せるか

### 410 を返す（置き場は残る）

- Workers: `assets.run_worker_first: true` で、静的ファイルを返す前に Worker が走る。Worker は期限を過ぎていれば 410、そうでなければ `env.ASSETS.fetch(request)` で中身を返す（[Worker Script のルーティング](https://developers.cloudflare.com/workers/static-assets/routing/worker-script/)）。既定では静的ファイルが Worker より先に返るので、この設定が無いと 410 にならない（[Migrate from Pages](https://developers.cloudflare.com/workers/static-assets/migration-guides/migrate-from-pages/) の `_routes.json and Pages Functions middleware` の節）。
- Pages: `functions/_middleware.js`（手で公開した `lmm-aidlc-581050.pages.dev` の形）。Functions はリクエストが Workers の枠に数えられる。
- **期限をコードに焼き込めば、誰も何も流さなくても期限で効く。** 中身（会議の発話を含みうる HTML）は Cloudflare に残り続ける点が弱い。
- Workers は版ごとのプレビュー URL があり、Pages はデプロイごとのハッシュ URL（`<hash>.<project>.pages.dev`）が残る（[Preview Deployments](https://developers.cloudflare.com/pages/configuration/preview-deployments/)）。期限の判定は版のコードの中にあるので、それらの URL でも 410 になる（推測。版が同じコードを持つため）。Workers ではプレビュー URL は `preview_urls: false` で出さないでおける（[Previews の custom domains](https://developers.cloudflare.com/workers/previews/custom-domains/)）。

### 置き場ごと消す

- Workers: `DELETE /accounts/{account_id}/workers/scripts/{script_name}`（上の 3）。版も静的ファイルも消える。
- Pages: プロジェクトの削除。デプロイが 100 を超えるプロジェクトは消せない既知の不具合がある（[Pages Known issues](https://developers.cloudflare.com/pages/platform/known-issues/)）。1 公開 1 プロジェクトなら当たらない。

### 消す処理を誰が流せるか

| 流す者 | できるか | 要るもの・注意 |
|---|---|---|
| 次に CLI（ローカルのサーバー）を使ったとき | できる | 手元のトークンで API の削除を呼ぶ。Mac を使わない間は消えないので、410 と併用する |
| Cloudflare の Cron Triggers | できる | 公開した Worker 自身に `scheduled()` を持たせ、期限後に自分を API で消す。そのために **API トークンを Worker の secret に入れる**必要がある（推測。Cron の資料に自己削除の手段は無く、削除は API だけ）。Cron は 1 アカウント 5 個（Free）/ 250（Paid）を全 Worker で共有するので、1 公開 1 Cron だと Free では 5 本しか持てない。掃除用の Worker を 1 本置いて全公開を見る形なら 1 個で足りる。変更の反映に最大 15 分かかる（[Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)） |
| 利用者が手で | できる | ダッシュボードで Worker を消す |

推測として、**期限を焼き込んだ 410 で期限そのものは確実に守り、中身を消すのは次に CLI を使ったときに API で行う**のが、外に長く効くトークンを置かずに済む形。Cron での自己削除は、トークンを Cloudflare 側に置くことと Cron の数の上限が引き換えになる。

## 6. Cloudflare Access（メールの PIN）を無料枠でかけられるか

かけられる。

- Zero Trust Free は **50 ユーザーまで、$0**（[Zero Trust の料金](https://www.cloudflare.com/plans/zero-trust-services/)の比較表「User Limit Free 50 users」）。席は Access でログインした人ごとに 1 つ消費し、手で外すか、無操作の期間（1 か月〜1 年）で自動に外せる（[Seat management](https://developers.cloudflare.com/cloudflare-one/team-and-resources/users/seat-management/)）。会議の相手に見せるたびに席が増えるので、50 は見せる相手の延べ人数の上限として効く。
- 前提として Zero Trust の組織を作る。その手順で**プランを選び支払い情報を入れる**（Free を選んでも必要。課金はされない）（[Zero Trust Get started](https://developers.cloudflare.com/cloudflare-one/setup/)）。利用者の手間として大きい。
- Workers では `workers.dev` とプレビュー URL に、Worker の設定から 1 クリックで Access をかけられる。Worker 単位でかけると、その Worker の `workers.dev`・カスタムドメイン・プレビューがまとめて守られる。API では `POST /accounts/{account_id}/access/apps` に destination `worker` を渡す（[Workers の Cloudflare Access](https://developers.cloudflare.com/workers/configuration/cloudflare-access/)）。
- Pages は既定ではプレビューだけが守られ、`*.pages.dev` 本体を守るには手順が要る（[Pages Known issues](https://developers.cloudflare.com/pages/platform/known-issues/) の「Enable Access on your `*.pages.dev` domain」）。
- **メールの PIN（OTP）は既定ではない。** 新しい組織の既定のログイン方法は Cloudflare アカウントになった（2026-06-18 の変更）。OTP は Identity providers で足す（`Access: Organizations, Identity Providers, and Groups Write`）。足した後は、ポリシーにメールアドレスを書けばそのアドレスに PIN が届く（[One-time PIN login](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/one-time-pin/)）。会議の相手は Cloudflare アカウントを持っていないことが多いので、OTP を足す前提になる。

## 7. AI クローラーの拒否

### 自前でできること（どのドメインでも効く）

- **robots.txt**: 静的ファイルとして置く。従うかはクローラー次第。
- **`X-Robots-Tag`**: Workers の静的ファイルなら `_headers` で付けられる（[Headers](https://developers.cloudflare.com/workers/static-assets/headers/)）。ただし `run_worker_first` で Worker が返す応答には `_headers` が効かないので、Worker のコードで付ける。`workers.dev` のプレビュー URL には Cloudflare が自動で `X-Robots-Tag: noindex` を付けるが、本番の `workers.dev` には付かない（[Previews](https://developers.cloudflare.com/workers/previews/)）。
- **UA での 403**: Worker（`run_worker_first`）で判定する。手で公開した例と同じ。

### AI Crawl Control（AI ボットのブロック）は既定のドメインに効くか

効かないと見るべき（推測）。

- AI Crawl Control も「Block AI bots」／AI bot policies も、ダッシュボードで**アカウントとドメインを選んで**開く、ゾーン単位の設定（`dash.cloudflare.com/?to=/:account/:zone/ai`、`/:account/:zone/security/settings`）。[AI Crawl Control](https://developers.cloudflare.com/ai-crawl-control/) は「Control how AI crawlers interact with your domain」「Available on all plans」。[Block AI Bots](https://developers.cloudflare.com/bots/additional-configurations/block-ai-bots/) も **Security Settings** の設定。
- `*.workers.dev`・`*.pages.dev` は Cloudflare の持つドメインで、利用者のアカウントのゾーンではないので、この設定を選ぶ場所が無い。`workers.dev` は「Free website として扱われる」とあるが、ゾーンの設定を利用者が変えられるとは書かれていない（[workers.dev](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/)）。
- 資料には `workers.dev`・`pages.dev` に効く／効かないの記述が無い。確かめるなら、実際のダッシュボードで workers.dev の Worker から AI Crawl Control を開けるかを見る。
- 利用者が自分のドメインを Cloudflare に載せてカスタムドメインで出すなら効く。ただしそれは「ドメインを前提にしない」に反する。

## 調べ残し

- 実際のアカウントで Direct Upload の 3 手順を通して、25MB 近い HTML が置けるかは試していない（25 MiB は 26,214,400 バイト。25MB = 25,000,000 バイトなら収まる）。
- `workers.dev` で AI Crawl Control が選べないことは、ダッシュボードで確かめていない。
- 新しいアカウントで `workers.dev` のサブドメインを最初に決める手順が API だけで済むかは調べていない。
