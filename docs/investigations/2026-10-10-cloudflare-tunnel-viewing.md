# Cloudflare Tunnel でローカルのサーバーを閲覧だけ開く方式（Issue #737）

地図 [#734](https://github.com/daiki-beppu/live-mindmap/issues/734) の調査チケット [#737](https://github.com/daiki-beppu/live-mindmap/issues/737)。ローカルの表示（HTTP と `/ws` の WebSocket）を、Cloudflare Tunnel で会議の参加者と自分の別端末に閲覧だけ開く方式を、一次資料（developers.cloudflare.com、Cloudflare の規約、`cloudflare/cloudflared` のソース 2026.10.0、npm の `cloudflared`）とこのリポジトリのコードで調べた。調べた日は 2026-10-10。実際に tunnel を張っての計測はしていない。**［未確認］** と付けたものは一次資料で裏が取れていない。

## 結論

- **既定は quick tunnel ＋ `--allowed-mail`（メールのワンタイム PIN）**。アカウントもドメインも要らず、`cloudflared` 2026.9.2 で入った `--allowed-mail` で、指定したメールアドレス（`*@example.com` の形でドメイン単位も可）の人だけが入れる。URL は起動ごとに変わるので、会議ごとに渡し直す形になる。Cloudflare は quick tunnel を「テストと開発のため」と位置付け、稼働の保証は無い。会議のたびに閲覧を一時的に開く使い方なら、この位置付けの中に収まると読める（規約上の判断は「規約」の節）
- **named tunnel ＋ Access は、URL を固定したい人の上級の選択肢**。Cloudflare のアカウントと、Cloudflare に載せたドメインが要る。Access（ワンタイム PIN）は Zero Trust の無料プランで 50 ユーザーまで使える。設定はダッシュボードかトークンで、live-mindmap の CLI から 1 コマンドでは済まない
- **URL を知っていれば誰でも見られる形（`--allowed-mail` なしの quick tunnel）は既定にしない**。URL が会議のチャットや画面共有で漏れれば、会議の中身（発言・マップ）が誰にでも見える
- **WebSocket は通る**（Cloudflare は全プランで WebSocket を通し、`cloudflared` は upgrade を origin へ中継する）。ただし Cloudflare 側の再起動などで切れることが明記されているので、今の web の「1 秒後につなぎ直す」と、server の「つないだら保持している値を先に送る」がそのまま効く
- **`cloudflared` は npm の `cloudflared` パッケージに頼らない**。これは Cloudflare 製ではない第三者（JacobLinCool）のラッパーで、postinstall で「最新版」を GitHub から落とし、チェックサムを確かめない。ADR 0017 の「固定版を管理ディレクトリに入れる」に合わせるなら、リリースの tgz（darwin-arm64 で約 19.8MB）を版とハッシュで固定して `~/.live-mindmap/deps/cloudflared/` に入れる形になる
- **server 側の対応は 3 つ要る**。(1) 閲覧用の口は `/ws` の配信だけにし、`/session/*` を tunnel に出さない。(2) 今の Origin の制限はローカルの Origin しか通さないので、tunnel の Origin（`https://<名前>.trycloudflare.com`）を閲覧の口でだけ通す。(3) 今の画面は Vite の dev サーバー（5173）が配っているので、tunnel の先を Vite にするなら `server.allowedHosts` を足す必要がある。閲覧用には、server が web のビルドを配る口を作る方がよい

## 方式の比較

| | quick tunnel（制限なし） | quick tunnel ＋ `--allowed-mail` | named tunnel（Access なし） | named tunnel ＋ Access（OTP） |
|---|---|---|---|---|
| 要るもの | `cloudflared` だけ。アカウント・ドメイン不要 [1] | 同左。`cloudflared` 2026.9.2 以降 [1][7] | Cloudflare アカウント＋Cloudflare に載せたドメイン [3] | 同左＋Zero Trust の組織（無料プランで 50 ユーザーまで）[4][5] |
| URL | `https://<ランダム>.trycloudflare.com`。起動ごとに変わり、`cloudflared` を止めると使えなくなる [1] | 同左 | 自分のドメインのホスト名で固定 [3] | 同左 |
| 入れる人 | URL を知る全員 [1] | 指定したメール（アドレスかドメイン）の人。メールに届く PIN を入れる。閲覧者は Cloudflare のアカウント不要 [1] | URL を知る全員 | Access のポリシーに合う人（Emails / Emails ending in など）[6]。PIN は 10 分で失効・1 回限り [8] |
| 入れる人の変更 | — | `cloudflared` を止めて別の quick tunnel を立て直す（URL も変わる）[1] | — | ダッシュボードでポリシーを変える |
| ログインの持続 | — | `cloudflared` のプロセス内のセッション。cookie の寿命は 4 時間（ソースの定数）[9] | — | Access のセッション時間（既定値は**［未確認］**） |
| 同時接続・制限 | 処理中のリクエスト 200 まで、超えると 429。SSE 不可。稼働保証なし。接続は 1 本（HA なし）[1][9] | 同左。非対話のクライアント（curl など）は通らない [1] | アカウントあたり 1,000 tunnel、tunnel あたり 25 レプリカ [10] | 同左。Access のアプリは 500 まで [10] |
| WebSocket | 通る（下の節） | 通る。認証の cookie は `__Host-` 付きで同じホストの `/ws` にも付く [9]。4 時間を過ぎた後の再接続の挙動は**［未確認］** | 通る | 通る（Access の背後の WebSocket の挙動の細部は**［未確認］**） |
| 規約上の位置付け | 「テストと開発のため」。本番は named tunnel を使うよう案内 [1]。オンラインサービスの利用規約に従い、Cloudflare が利用を調べる権利を持つ（`cloudflared` の起動時の文面）[9] | 同左 | 通常の Cloudflare の契約。無料プランの CDN で動画や大きなファイルの配信が偏ると制限されうる [11] | 同左 |
| 利用者の手間 | なし | 閲覧者のメールを CLI に渡す | ドメイン・tunnel の作成（ダッシュボードか `cloudflared tunnel login`）、ホスト名の設定 [3] | 加えて Access のアプリとポリシーの作成 |
| 向く使い方 | 自分の別端末で一時的に見る（ただし URL が漏れれば誰でも見える） | 会議の参加者に会議中だけ見せる（既定の候補） | 推奨しない | URL を固定したい・チームで常用する人 |

## 各問いへの答え

### quick tunnel と named tunnel の違い

- quick tunnel は `cloudflared tunnel --url http://localhost:<port>` で、`trycloudflare.com` のランダムなホスト名が出る。アカウントもドメインも要らない。ホスト名は作るたびに変わり、プロセスを止めると URL は使えなくなる [1]
- 制限: 稼働の保証なし、処理中のリクエストは 200 まで（超えると 429）、SSE は使えない [1]。`cloudflared` のソースでは、quick tunnel は「本番に使うものではない」として接続を 1 本に固定している（`HaConnections` を 1 に設定）[9]
- 帯域の上限は、quick tunnel の資料にも一般の資料にも数値が無い **［未確認］**。live-mindmap の閲覧で流れるのは JSON の差分とスナップショットだけで、動画は流さない。見返しの動画（`@videojs/react`）を tunnel で配る場合は、無料プランの CDN の「動画・大きなファイル」の条項 [11] に触れうるので、閲覧の範囲は会議中のマップと字幕に限るのが無難
- named tunnel はアカウントと「Cloudflare 上のドメイン（アプリを公開するのに必要）」が要る [3]。Cloudflare は remotely-managed（ダッシュボード・トークン）を推し、locally-managed（`cloudflared tunnel create`）は「ローカルの開発・テスト・古い構成など特定の場面向け」としている [2]。ホスト名は固定で、プロセスが止まっていると閲覧者には 1016 エラーが出る [12]
- 規約: quick tunnel は「テストと開発のため」で、本番は通常の tunnel を使うよう案内している [1]。`cloudflared` は起動時に「アカウントなしの tunnel は稼働保証が無く、Cloudflare Online Services Terms of Use に従い、Cloudflare は規約違反の利用を調べる権利を持つ。本番に使うなら named tunnel を」と出す [9]。quick tunnel 専用の禁止条項は、Application Services の個別規約には見当たらなかった [11]。会議中だけ一時的に開く使い方が「本番」に当たるかは、資料からは判断できない **［未確認］**。ただし live-mindmap がこれを常用の機能として案内するなら、稼働保証が無いこと（会議中に落ちうる）を利用者に伝える必要がある

### 入り方を絞る手段

- **quick tunnel の `--allowed-mail`**（`cloudflared` 2026.9.2 で有効化、2026.10.0 が最新）[7]: `cloudflared tunnel --url ... --allowed-mail alice@example.com`。繰り返すかカンマ区切りで複数、`'*@example.com'` でドメイン単位 [1]。閲覧者はページでメールを入れ、届いた PIN を入れる。Cloudflare のアカウントは不要 [1]。入れる人を変えるには `cloudflared` を止めて立て直す（URL も変わる）[1]。ソースでは、認証は origin に届く前に `cloudflared` が掛け、認証用の cookie は origin へ渡す前に取り除き、セッションの cookie は `__Host-cloudflared-qt-auth-session`・寿命 4 時間で、署名の鍵はプロセスごとに作る（プロセスを立て直すと全員がログインし直し）[9]
- **Cloudflare Access**（named tunnel 向け）: ポリシーの Allow / Bypass / Service Auth、条件に Emails・Emails ending in・Everyone など [6]。ワンタイム PIN は IdP として有効にし、メールで PIN が届く。PIN は 10 分で失効し、1 回限り [8]。ポリシーの条件に「Login Methods = One-time PIN」を置くと、メールを持つ全員が通ってしまうと注意がある [6]。`cloudflared` の origin のパラメータ `access`（`required`・`teamName`・`audTag`）で、`cloudflared` 側でも Access の JWT を確かめてから origin へ渡せる [13]
- **無料枠**: Zero Trust の Free プランは「$0 forever」で 50 ユーザーまで [5]。Access のアカウントの上限はアプリ 500 [10]
- **URL を知れば誰でも見られる形のリスク**: 会議の発言・マップがそのまま読める。URL は推測しにくいランダムな名前だが、会議のチャット・画面共有・録画・ブラウザの履歴から漏れうる。ローカルモード（ADR 0014）は「会議の中身が Mac の外に出ない」約束なので、tunnel を開くこと自体がその約束に反する（地図の合意どおりローカルモードでは開かない）

### WebSocket が通るか、遅延と切断

- Cloudflare は proxy する WebSocket を全プランで追加設定なしに通す [14]。`cloudflared` は upgrade の要求を origin へ `Upgrade: websocket` で中継する（`proxy/proxy.go`）[9]。quick tunnel の資料は WebSocket に触れていない [1] が、制限として挙がるのは SSE だけである
- 切断: 「何も流れない時間が続くと Cloudflare は WebSocket を閉じる」（既定の秒数は資料に無い **［未確認］**）。「Cloudflare が新しいコードを出すとき、サーバーを再起動し WebSocket は切れる」。keepalive（ping/pong）を勧めている [14]。quick tunnel は接続 1 本で稼働保証も無い [1][9]
- live-mindmap の側: web の `useLiveFeed.ts` は切れたら 1 秒後につなぎ直し、切れている間も最後のスナップショットを持つ。server の `Viewers.connect` はつないだら保持している値（スナップショット・話している文字・取り込みの状態）を先に送る（`server/src/viewers.ts`）。このため切断からの戻りは今の作りで足りる。会議中は話している文字が絶えず流れるので無通信の切断は起きにくいが、無言が長い区間に備えて server から ping を送るかは仕様で決める（今の `effect/socket` の配信に ping は無い）
- 遅延: Cloudflare の最寄りの拠点を経由する分だけ増える。数値の資料は無く、計測もしていない **［未確認］**。表示は字幕とマップの更新で、数百 ms の遅れは見た目に効きにくいと見込む（推測）

### `cloudflared` の入れ方と ADR 0017

| 入れ方 | 版の固定 | 確かめ | 大きさ | ADR 0017 との相性 |
|---|---|---|---|---|
| npm の `cloudflared`（0.7.3、JacobLinCool 作）[15] | 既定は「latest」、`CLOUDFLARED_VERSION` の環境変数で指定 [15] | ダウンロードにチェックサムの確認なし（`src/install.ts`）[15] | 本体と同じ | 悪い。postinstall で落とすので、ADR 0017 の `npm ci --ignore-scripts` では入らない。lock で版が決まらない |
| GitHub のリリースの tgz を版とハッシュで固定して管理ディレクトリへ | live-mindmap が版と SHA256 を持つ。リリースの本文に SHA256 が載る [7] | 自前で SHA256 を照合 | darwin-arm64 の tgz で 19,809,074 バイト、amd64 で 21,741,581 バイト（2026.10.0）[7] | よい。`cli install cloudflared` で入れ、開始前の確かめで欠けを知らせる。欠けても閲覧の共有が無いだけなので、ADR 0017 の「一部の出力が減るだけのもの」に当たり、警告して開始する形にできる |
| 利用者に入れてもらう（Homebrew の `cloudflared` は 2026.9.3）| 利用者の手元しだい | — | — | ADR 0017 は「手元のものを流用しない」を選んでいる。ただしその理由は差分更新の振る舞いが版に左右されることで、`cloudflared` には当たりにくい。`--allowed-mail` は 2026.9.2 以降が要るので、版の下限の確かめは要る |

- 推奨は 2 段目（固定版の tgz を管理ディレクトリへ）。ADR 0017 の lock は npm 向けの形なので、バイナリをハッシュで固定する口は新しく足すことになる
- 「start の前にそろえる」との関係: tunnel を開くかは会議ごとに決まるので、`start` の選択肢（例: 閲覧を開く指定）があるときだけ確かめ、欠けていれば exit 3 で止めるか、警告して閲覧なしで始めるかを仕様で決める（ADR 0017 では、欠けても一部が減るだけのものは警告して開始）

### server の側で要る対応

コードの事実（2026-10-10 の main）:

- server は `127.0.0.1:4319` で待ち受け、`/apps`・`/session/start|stop|status|resume` と、配信の `/`・`/ws` を同じポートで受ける（`server/src/http.ts`、ADR 0009）
- Origin の制限は 1 つのミドルウェアで、Origin が付いていてローカル（`localhost`・`127.0.0.1`・`[::1]`）でなければ 403。**Origin が付いていない要求（curl など）は通す**（`http.ts` の `OriginRestriction`）
- ブラウザは `/ws` につないで受けるだけで、何も送らない。server は `reader.pull` を切断の検知にだけ使い、届いた値は捨てる（`web/src/useLiveFeed.ts`、`server/src/viewers.ts`）。web から他の `fetch` は無い
- 画面（HTML と JS）は server ではなく Vite の dev サーバー（`http://localhost:5173`）が配り、`/ws` だけを server へ proxy している（`web/vite.config.ts`）

要る対応:

1. **閲覧の口を分ける**。tunnel の先を今の server のポートにすると、`/session/*` も外から届く。Origin の付かない要求は今の制限を素通りするので、URL を知る人（`--allowed-mail` なら認証を通った人）が会議を止められる。閲覧用は、配信（`/ws`）と画面の静的ファイルだけを受ける別の待受け（別ポート、今の `serveFeed` に近い形）にし、tunnel はそこへ向ける。named tunnel なら ingress の path でも絞れるが、quick tunnel では絞れないので、server 側で分けるのが確実
2. **Origin**: tunnel を通ったブラウザの Origin は `https://<ホスト名>`（quick tunnel なら `*.trycloudflare.com`）。今の制限では 403 になる。閲覧の口でだけ、立てた tunnel のホスト名を許す（`*.trycloudflare.com` を丸ごと許すのではなく、起動時に `cloudflared` が出した 1 つのホスト名に限る）
3. **Host ヘッダー**: `cloudflared` は既定で Host を書き換えず、公開側のホスト名のまま origin へ渡す（`httpHostHeader` を設定したときだけ置き換え、元の値を `X-Forwarded-Host` に入れる）[9][13]。server は Host を見ていないので影響しない。Vite の dev サーバーを tunnel の先にする場合は、Vite が `server.allowedHosts`（既定 `[]`）に無い Host を拒むので、tunnel のホスト名を足す必要がある [16]。Vite は proxy の前に WebSocket の Origin を確かめない [16]
4. **画面の配り方**: 参加者に Vite の dev サーバーを出すと、開発用のモジュール・HMR の口まで外に出る。server が web のビルド（エクスポートで使っている `vite-plugin-singlefile` のような 1 ファイルか、`vite build` の出力）を閲覧の口で配る方がよい（推測。仕様で決める）
5. **CORS**: 画面と `/ws` が同じホストから出るなら CORS は要らない。WebSocket には CORS の仕組みが無く、守りは Origin の確かめになる
6. **送り返しを受け付けない**: 今もブラウザからの値は捨てているので、閲覧の口でも同じにする（送られた値を解釈しない）。ADR 0003 の「ブラウザは表示だけ」と合う

## 出典

1. Cloudflare, Quick Tunnels — https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/
2. Cloudflare, Locally-managed tunnels — https://developers.cloudflare.com/tunnel/features/locally-managed-tunnels/
3. Cloudflare, Tunnel: Get started — https://developers.cloudflare.com/tunnel/get-started/
4. Cloudflare, Cloudflare Tunnel（Cloudflare One） — https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/
5. Cloudflare, Access の製品ページ（Free プラン「$0 forever」「50 user limit」）— https://www.cloudflare.com/sase/products/access/
6. Cloudflare, Access policies — https://developers.cloudflare.com/cloudflare-one/access-controls/policies/
7. cloudflare/cloudflared, `RELEASE_NOTES` と最新リリース 2026.10.0（2026-10-05）の資産と SHA256 — https://github.com/cloudflare/cloudflared/releases/tag/2026.10.0
8. Cloudflare, One-time PIN login — https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/one-time-pin/
9. cloudflare/cloudflared 2026.10.0 のソース: `cmd/cloudflared/tunnel/quick_tunnel.go`（起動時の規約の文面、接続 1 本）、`quicktunnelauth/session.go`（cookie 名・4 時間）、`quicktunnelauth/isolation.go`（認証の cookie を origin へ渡さない）、`ingress/origin_proxy.go`（Host の扱い）、`proxy/proxy.go`（WebSocket の中継）— https://github.com/cloudflare/cloudflared/tree/2026.10.0
10. Cloudflare, Cloudflare One account limits — https://developers.cloudflare.com/cloudflare-one/account-limits/
11. Cloudflare, Service-Specific Terms: Application Services（Content Delivery Network の節）— https://www.cloudflare.com/service-specific-terms-application-services/
12. Cloudflare, Tunnel routing — https://developers.cloudflare.com/tunnel/concepts/routing/
13. Cloudflare, Tunnel origin parameters — https://developers.cloudflare.com/tunnel/reference/origin-parameters/
14. Cloudflare, WebSockets — https://developers.cloudflare.com/network/websockets/
15. npm `cloudflared` 0.7.3（JacobLinCool/node-cloudflared）: README・`package.json` の postinstall・`src/install.ts`・`src/constants.ts` — https://github.com/JacobLinCool/node-cloudflared
16. Vite, Server Options（`server.allowedHosts`・`server.proxy`）— https://vite.dev/config/server-options
