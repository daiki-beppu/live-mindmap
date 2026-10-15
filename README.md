# live-mindmap

会議中にAIが議論を可視化し、その可視化を見ながら人間が議論する —— **AIファシリテーター / AIホワイトボード**。

Zoom / Google Meet などの会議音声をリアルタイムで文字起こしし、AIが会話を継続的に解析してマインドマップを自動で整理・更新する Web サービス。
「会議後にAI議事録を読む」のではなく、会議中に常に更新されるマップを参加者全員が見ながら議論できる体験を目指す。

## コア体験

話す → 数秒〜数十秒後にマインドマップが勝手に整理・更新される

## マップで扱う要素

- 議題・論点
- アイデア
- 選択肢
- 決定事項
- 未決事項
- 課題
- TODO / 担当者

## 差分更新

AIは毎回マップを作り直さず、既存構造に対して次の操作を行う。

`追加 / 更新 / 統合 / 移動 / 解決 / 削除 / 何もしない`

同じ話題に戻った場合は新しいノードを増やさず、既存ノードに続きを追加する。

## 根拠のトレーサビリティ

ノードをクリックすると、その内容の根拠になった元発言・発言者・時刻を確認できる。

## ロードマップ

### MVP

会議音声取得 → リアルタイム文字起こし → AI構造化 → Webマインドマップ自動更新

（自動参加Botは作らない）

### その後

- 会議URLを渡すだけで「AI Map Bot」が参加し、クラウド上の仮想ブラウザでマップを表示・画面共有する
- 必要に応じて Mac アプリを追加

## 方針

- 既存マインドマップアプリ（MindNode 等）への連携ではなく、会議専用のマインドマップUIを自作する
- Web サービスを本体とする

## ライブのセッション

```sh
pnpm dev   # ヘルパーをビルドし、サーバー（127.0.0.1:4319、LIVE_MINDMAP_PORT で変更）とブラウザの表示を並行して起動する
```

止めるときは、起動した端末で Ctrl-C を押す。端末が手元に無いとき（エージェントが裏で起動したときなど）は `pnpm cli server stop` で止める。同じ `LIVE_MINDMAP_PORT` のサーバーだけを、そのサーバーが名乗った PID で止める（ブラウザの表示の Vite は止めない）。セッションが進行中なら断るので、先に `pnpm cli stop` で書き出す。`pkill` などのパターンでは止めない（別の作業のプロセスまで止まる）。

別のターミナルから、CLI でセッションを操作する（`pnpm --filter @live-mindmap/server cli ...`）。同時に扱うセッションは 1 つ。

```sh
cli check                                 # 開始せず依存の状態を JSON で確認する（--for start|resume|play、既定 start。play の確認はサーバー不要）
cli install <名前>                        # 常駐サーバーに chromium・claude・speech-ja の導入を依頼し、進捗と結果を出す
cli update [<名前>]                       # 版違いの管理依存だけを固定版へそろえる（省略時は Chromium・Claude SDK。speech-ja は OS が更新するので不要）
cli apps                                  # 会議アプリの一覧（JSON）。bundle id を調べる
cli start --app us.zoom.xos [--title 週次] [--no-audio] [--no-screen] [--vocab <file>]  # サーバーがヘルパーを子プロセスで起動する。セッションのフォルダを出す。既定では、トラックごとの録音を、そのフォルダに残す（--no-audio で録音しない）。共有画面は既定で取り込む（--no-screen で取り込まない。ログには screen-off（指定）を 1 件残す。画面収録の許可が無いときは、音声だけで続けて screen-off（許可なし）を残し、画面に一文を 1 回出す）。--vocab は語のファイル（1 行に 1 語、空行は無視）で、足した語の読みをヘルパーの readings で作り、崩れた発言を直った表記にする（字幕・マップ・ログの remark の text。直す前の本文は raw に残る）。足した語は log.jsonl の vocab の行に残る。足せるのは開始時だけ（resume では受け取らない）
cli recorded <file> [--title 名前] [--vocab 語のファイル] [--model 名前] [--local] [--realtime]   # 音声（動画）1 本の録画から、常駐サーバーでセッションを組む。終わるまで待ち、進み具合（入れた位置 / 全体の長さ・マップの更新回数）を標準エラーに出し、終わったらセッションのフォルダと map.* のパスを出す。フォルダには渡したファイルの音声を 相手.m4a として書く（動画からは音声だけ。元のファイルはコピーしない。音声のトラックが 2 本以上あれば最初の 1 本だけを使い、そのことと、分けたいときは --self を使えることを標準エラーに知らせる）。動画に映像があれば、自動で共有画面として使う（止めるフラグは無い。ライブと同じ変化の判定・画像・OCR で、時刻は音声と同じ。映像が読めなければ、そのことを標準エラーに知らせて音声だけで続ける。音声だけのファイルは共有画面なし）ので、map-audio.html もできる。フォルダ名と log.jsonl の時刻は、ファイルに記録された作成日時を基準にする（取れないときは流し始めた時刻。同じ名前のフォルダがあれば -2、-3… を付けた新しいフォルダに書く）。--title を省くとファイル名（拡張子なし）が題名になる。--realtime を付けると、発言と共有画面の変化を音声の時刻どおりに等速で入れる（play --realtime と同じ意味。発言の列は待ち時間なしと同じ）。Ctrl-C ではそこまでの分で終えて書き出す。ライブの最中は断る。resume は使えない。話者は分けない（すべて 相手）
cli stop                                  # ヘルパーを止め、map.md・map.json・map.drawnix・map.png・map.html を書き出して、そのパスを出す（録音が残っていれば、その後に音声つきの map-audio.html も）
cli status                                # 取り込みの状態（動いている／途切れている／止まった／セッションなし）・セッションのフォルダ・起動し直した回数・最後の途切れの時刻と、閲覧の共有の状態（共有中／切れた／無し）・URL・許可の範囲を出す
cli share a@x.com '*@example.co.jp'       # 閲覧をメール・ドメインで絞って共有を開く（LIVE_MINDMAP_SHARE_ALLOW のカンマ区切りの既定の許可に足す）。--anyone とは同時に渡せない
cli share --anyone                        # 閲覧の共有を誰でも見られる範囲で開き、URL・許可の範囲・稼働の保証が無い旨を出す（範囲が空なら開かずに失敗する。管理依存の cloudflared が要る）。セッションの終了でも閉じる
cli share --stop                          # 閲覧の共有を閉じる（共有していなくても成功する）
cli resume                                # 止まった状態（起動し直しを諦めた状態）から、ヘルパーを起動し直して同じセッションを続ける。動いているときに呼ぶとエラー
cli export --format json                  # 終了後も、最新のセッションのマップを取り出せる（表示も最後のマップのまま残る）
cli review [/Users/<名前>/.live-mindmap/sessions/<開始時刻>] [--self-only]  # 見返し用の map.html（フォルダに録音があれば、その後に音声つきの map-audio.html も）を、そのセッションの log.jsonl から作り直してパスを出す（省略すると log.jsonl を持つ最新のセッション。サーバーは要らない。進行中でもその時点までのログで作る。`--self-only` を付けると、`自分*.m4a` があるときだけ、`自分` の声だけを埋め込んだ `map-audio-自分.html` だけを作る）
```

- `map.png`（`play` の終了時も同じ）は、サーバーが Playwright のヘッドレスブラウザで自分の表示ページを開いて撮る。ブラウザを開いていなくても撮れる。変わったノードの強調・仮のノード・右の列は写さない。画像はノードを囲む範囲だけを切り抜く。初回だけ、サーバーを起動した状態で `pnpm cli install chromium` を打ち、管理ディレクトリ（`~/.live-mindmap/deps/`）に Chromium を入れる。撮れなかったとき（Chromium が無い等）は、map.png だけ除いて終わり、理由を標準エラーに出す。
- `map.html`（`play` の終了時も同じ）は、見返し用の 1 ファイルの HTML。書き出しの時点で web を Vite の single-file ビルドにかけ、`log.jsonl` の出来事を埋め込む。同梱したライブラリのライセンスの文言（全文）も、画面には出さずに HTML の中に残す。ダブルクリック（file://）で開くと、サーバーなしで、最後の時点のマップ・「変わったこと」・根拠が、ライブと同じ画面の部品で見える。開いた直後は最後の時点で止まっていて、シークバー・▶・反映 1 つ戻る・反映 1 つ進むで時刻を動かせる（音声なし）。書き出せなかったときは、map.html だけ除いて終わり、理由を標準エラーに出す。
- `map-audio.html` は、セッションのフォルダ直下に `相手*.m4a`・`自分*.m4a` があるときだけ、`map.html` の後に書く音声つきの版（`stop` と `review`。`play` と `--no-audio` のセッションには録音が無いので書かない。録音が無いときは理由を表示しない）。書き出しでヘルパーの `mix` を呼んで録音を 1 本にし、base64 で HTML に埋め込む。開くと、▶ でその時刻から録音が鳴り、マップと字幕が音声の `currentTime` に合わせて進む（速さは 1 倍だけ）。シーク・反映 1 つ戻る・進むは音声もその時刻へ移す。`mix` が失敗したときは、`map-audio.html` だけ除いて終わり（`review` の終了コードは 0）、「map-audio.html を書き出せませんでした: <理由>」を標準エラーに出す。
- `map-audio-自分.html` は、`cli review --self-only` だけが書く、`自分` の声だけを埋め込んだ版（ヘルパーの `mix --track 自分`）。`map.html`・`map-audio.html` には触らず、既にあれば確認なしで上書きする。`自分*.m4a` が無い（`相手*.m4a` だけ、`play`、`--no-audio` を含む）と「自分の録音がありません」で、`mix` が失敗したときも、何も書かずに 0 以外で終わる。パスを 1 行出す。
- 録音は、セッションのフォルダの `相手.m4a`・`自分.m4a`（AAC・モノラル）。録音の 0 秒は発言の時刻（`map.json` の start / end）の 0 秒と同じなので、発言の時刻から音声を聞き返せる。`stop` は、ヘルパーが録音を閉じるのを待ってから書き出す。ヘルパーが 5 秒以内に終わらず強制終了したときは、録音の書き終わりを確認できなかったことを標準エラーに出す（録音が不完全なことがある）。`stop` が正常に書き出したときに出すパスは、録音を残したセッションでは 6 つ（map.md〜map.html、map-audio.html）、`--no-audio` のセッションでは 5 つ（map.md〜map.html）で、録音そのもののパスは出さない。
- ヘルパーの WebSocket にはサーバーだけがつなぐ。ポートはサーバーが空きを選んで渡す。
- ヘルパーの実行ファイルは、最適化ありのビルドの `helper/.build/release/live-mindmap-helper`（`pnpm dev` が `swift build -c release` でビルドする）。最適化なし（debug）のビルドは CPU を 5 倍ほど使い、負荷の高い Mac では入力の滞留で数分おきに止まるので、会議では使わない。`LIVE_MINDMAP_HELPER` で差し替えられる。既定の実行ファイルが無いままサーバーを起動すると、ビルドのコマンドを示して終わる。
- `pnpm dev` の実行中は 4319 をサーバーが使うので、`play` を同時に動かすときは `LIVE_MINDMAP_PORT` を変える（表示の proxy 先も同じ値を使う）。

### 初回の準備

CLI で導入する対象は次の 3 つです。容量は CLI が表示する目安です。

| 名前 | 導入するもの | 容量の目安 |
|------|--------------|------------|
| `chromium` | map.png の撮影に使う Chromium headless shell | 約211MB |
| `claude` | Claude Agent SDK | 約224MB |
| `speech-ja` | 日本語の音声認識モデル | OS が管理し、CLI は容量の目安を表示しない |

Chromium と Claude SDK は、既定では `~/.live-mindmap/deps/` に入ります。`LIVE_MINDMAP_DEPS` で管理ディレクトリを変更できます。変更するときは、サーバーと CLI に同じ値を設定してください。消したいときは、この管理ディレクトリを削除します。OS が管理する `speech-ja` は、この削除の対象に含まれません。

導入には常駐サーバーが必要です。まず `pnpm dev` を起動し、別のターミナルから必要な対象を導入します。`play` だけ使う人も、導入時にはサーバーを起動してください。

```sh
pnpm cli check                            # ライブの開始に必要なものを確認する
pnpm cli install chromium
pnpm cli install claude                   # Claude を使う場合
pnpm cli install speech-ja                # ライブの日本語音声認識を使う場合
```

開始時に必須の依存が足りないときは、CLI は不足内容と導入コマンドを表示し、終了コード3（exit 3）で止まります。エージェントはこの案内を受けたら利用者に確認し、同意を得てから導入してください。Chromium は任意の依存なので、未導入でも開始でき、撮影時には上記のとおり map.png だけが省略されます。

導入時には、パッケージ取得のために npm のレジストリへ、Chromium の取得のために Playwright の CDN へ通信します。`speech-ja` の取得先は Apple です。

### 取り込みの途切れ（ヘルパーが予期せず終わったとき）

ヘルパーが予期せず終わっても（`stop`・サーバーの終了によるものを除く）、サーバーは自動でヘルパーを起動し直し、同じセッション（同じマップ・ログ・差分更新）に発言を流し続ける（CONTEXT.md「取り込みの途切れ」）。起動（起動し直しを含む）から 60 秒以内に終わるのが 3 回続いたら、起動し直すのをやめて止まった状態にする。マイクの入力の構成の変化（入力の機器の切り替えなど。ヘルパーの終了コード 75）による終了はこの 3 回に数えず、起動し直し続け、60 秒に 10 回を超えて続いたときだけ諦めて止まった状態にする。セッションは終わらないので、`cli resume` で続けるか、`cli stop` で（ヘルパーの終了を待たずに）書き出して終えられる。

- 画面には、字幕の横に控えめな一言（「音声の取り込みが途切れました。再開しています」「再開しました」「音声の取り込みが止まっています」）が出る。途中から接続したブラウザにも、今の状態が届く
- サーバーの標準エラーにも、止まった・起動し直した・諦めたが 1 行ずつ出る。`log.jsonl` にも記録が残り、復元は壊れない
- 起動し直すたびに、録音ファイルの番号が増える（1 回目は `相手.m4a`・`自分.m4a`、2 回目は `相手-2.m4a`・`自分-2.m4a`、…）。前の回のファイルは上書きされない
- 起動し直した後の発言の時刻は、最初の起動からの続きになる（ヘルパーが決めた時刻の原点をサーバーが引き継ぎ、起動し直すヘルパーに `--origin` で渡す）

### 実機での確認手順（人が行う）

1. `pnpm dev` を起動し、ブラウザで表示（`http://localhost:5173`）を開く
2. Zoom かブラウザの会議（社外秘を含まないもの）を開き、音を出す
3. `cli apps` にそのアプリが出ることを確かめ、`cli start --app <bundle id>` で開始する（初回はマイクの許可が要る）
4. 話して、ブラウザのマップが組み上がることを見る
5. `cli stop` で終了し、出力された 6 つのパス（map.png はマップだけの画像、map-audio.html は音声つきの見返し）のファイルがあること、表示が最後のマップのまま残ること、`cli export --format json` で同じマップが取り出せることを確かめる
6. セッションのフォルダに `相手.m4a` と `自分.m4a` の 2 本が残っていることを確かめる。`map.json` の発言の start（秒）の位置から再生し、その発言が聞こえること（`相手` の発言は `相手.m4a`、`自分` の発言は `自分.m4a`）を確かめる
7. もう一度 `cli start --app <bundle id> --no-audio` で開始して `cli stop` し、そのセッションのフォルダに `相手.m4a`・`自分.m4a` ができないことを確かめる

## 差分更新のモデルを選ぶ

コマンドとフラグの正本は `pnpm cli --help` と各コマンドの `--help` です。

```sh
pnpm cli models
pnpm cli start --app us.zoom.xos --model claude
pnpm cli start --app us.zoom.xos --local
pnpm cli play <文字起こし.transcript.json> --model apple --realtime
```

`start` と `play` の通常時の選択順は、`--model <名前>` → 環境変数 `LIVE_MINDMAP_MODEL` → 設定ファイルの `default` → 組み込みの `claude` です。`--local` は `apple` を選び、別モデルの `--model` との併用を拒否します。`--model apple` でもローカルモードになります。組み込みは `claude` と `apple`。それ以外は設定に付けた名前で選びます。

設定は `~/.live-mindmap/config.json` の JSON で、`LIVE_MINDMAP_CONFIG` でファイルの場所を変更できます。`LIVE_MINDMAP_MODEL` はモデル名の選択用で、設定ファイルの場所とは別です。`models` は組み込みと設定したモデルの名前・経路・ローカル可否・現在の利用可否を表示します。Apple の可用性は調べますが、ほかの経路の認証や宛先への接続成功を保証する一覧ではありません。

`eval` は別の入口です。`--model <名前>` を明示したときだけ元ログをそのモデルで再生し、新しいランを評価します。指定なしなら、環境変数や `default` に関係なく保存済み結果を集計します。`eval` に `--local` はありません。評価の手順は [bench README](server/bench/README.md) を参照してください。

### 判定のモデルを選ぶ

判定のモデルは差分更新のモデルとは別に、`start` と `play` の開始時に一度だけ選びます（会議中は変えません）。選択順は、`--judge <名前>` → 環境変数 `LIVE_MINDMAP_JUDGE` → 設定ファイルの `judge` → 組み込みの `jev` です。`--judge off` で判定を使いません。

組み込みは次の 3 つです。

| 名前 | 判定の宛先 | 鍵の環境変数 | 時間切れ |
|------|-----------|--------------|----------|
| `jev`（既定） | TypeSafe の System One API | `TYPESAFE_AI_API_KEY` | 1 秒 |
| `clef-flash` | Cloudflare Workers AI の Clef-flash | `CLOUDFLARE_API_TOKEN` と `CLOUDFLARE_ACCOUNT_ID` | 2 秒 |
| `clef` | Cloudflare Workers AI の Clef | `CLOUDFLARE_API_TOKEN` と `CLOUDFLARE_ACCOUNT_ID` | 2 秒 |

```sh
export CLOUDFLARE_API_TOKEN=...
export CLOUDFLARE_ACCOUNT_ID=...
pnpm cli start --judge clef-flash
```

設定ファイルの `judge` で選び、`judges` で時間切れを上書きしたり、System One API の形の判定のモデルを足したりできます。

```json
{
  "judge": "clef",
  "judges": {
    "clef": { "timeoutMs": 3000 },
    "my-judge": { "route": "system-one", "apiKeyEnv": "MY_JUDGE_API_KEY", "url": "https://judge.example.com/v1/systemone", "timeoutMs": 1500 }
  }
}
```

- 組み込みの名前で `timeoutMs` だけを書くと、宛先・モデル名・鍵はそのままで時間切れだけが変わります。`route` と `apiKeyEnv` を書いた項目は、組み込みを丸ごと置き換えます。
- 自分で足す判定のモデルは `route`（`system-one`）と `apiKeyEnv` が要ります。`timeoutMs` は省略すると 1 秒です。

選んだ判定のモデルの鍵（Clef は 2 つの環境変数の両方）が無い、または空のときは、標準エラーに 1 行知らせて判定なしで始めます。ローカルモードでは、`--judge`・`LIVE_MINDMAP_JUDGE`・`judge` でクラウドの判定のモデルを明示すると開始を断り、何も明示しなければ判定なしで始めます。

### Claude の認証

`claude` を選ぶと Claude（Agent SDK 経由）を呼びます。自分の Anthropic API キーを環境変数で渡してください。費用は API キーの持ち主に請求されます。

```sh
export ANTHROPIC_API_KEY=sk-ant-...
pnpm dev
```

Claude のサブスク（Free / Pro / Max）の認証での利用は案内していません。Anthropic の規約で、第三者のアプリがサブスクの認証で要求を送ることが認められていないためです（[ADR 0004](docs/adr/0004-mit-license-no-monetization.md)）。

### Haiku 5.5 を選ぶ

Haiku 5.5 は組み込みの名前ではありません。既定は Sonnet 5.5（`claude`）のままで、設定に書いたときだけ選べます。`my-haiku` は利用者が付ける名前です。

```json
{
  "models": {
    "my-haiku": {
      "route": "claude",
      "model": "claude-haiku-5-5"
    }
  }
}
```

```sh
pnpm cli start --app us.zoom.xos --model my-haiku
```

モデル名が `claude-haiku-5-5` のとき、アプリが自動で `effort: "low"` と、決定を TODO で置き換えないための追記を使います。設定項目はありません。この設定例の品質は保証しません。Sonnet 5.5 medium と比べて測った差は次のとおりです。

- 料金は 1 会議でおよそ 1/8〜1/12（$0.08 前後）
- 画面のある会議では並びますが、画面のない会議では決定を 2 本で 2 件少なく拾います
- 反映までの遅れの p90 は 10.9 秒です（Sonnet 5.5 は 8.0 秒）

### ChatGPT のサブスク認証

ChatGPT は Sign in with ChatGPT で Plus / Pro のサブスクを使います。Claude の API キーとは別の認証です。

```sh
pnpm cli login chatgpt
```

ブラウザで認可すると、資格情報を `~/.live-mindmap/auth/chatgpt.json` に保存します。次は `config.json` の例です。`my-chatgpt` は利用者が付ける名前で、組み込みのモデル名ではありません。

```json
{
  "default": "my-chatgpt",
  "models": {
    "my-chatgpt": {
      "route": "chatgpt",
      "model": "gpt-6-luna",
      "images": false
    }
  }
}
```

```sh
pnpm cli start --app us.zoom.xos --model my-chatgpt
```

Plus の 5 時間ごとの利用上限は、プランを使う他のアプリと共有されます。上限に当たると、差分更新を一時停止します。残りの枠は ChatGPT の設定で確認してください。この設定例の品質は保証しません。短い合成会議区間での成功は、会議全体の品質や等速再生の遅れを保証するものではありません。経路の選定と実測範囲は [ADR 0019](docs/adr/0019-chatgpt-subscription-direct-responses-api.md) に記録しています。

### 外部ランタイムの OpenAI 互換設定

Ollama・LM Studio・llama.cpp などは、OpenAI 互換の口を設定して通常のモードで使えます。localhost で動かしてもローカルモードの対象にはなりません。接続できることと差分更新の品質は別で、品質は保証しません。

次は、用意したモデルを `my-runtime` という名前で選ぶ例です。`model` をランタイムにあるモデル名へ置き換えてください。URL は `/v1` までとし、アプリが `/chat/completions` を付けます。

```json
{
  "models": {
    "my-runtime": {
      "route": "openai-compatible",
      "url": "http://127.0.0.1:11434/v1",
      "model": "your-installed-model",
      "images": false,
      "extraBody": {
        "chat_template_kwargs": { "enable_thinking": false }
      }
    }
  }
}
```

```sh
pnpm cli play <文字起こし.transcript.json> --model my-runtime
```

ランタイム側の文脈長は **8192** を目安に設定します。live-mindmap の設定キーではありません。例の追加 body は、`chat_template_kwargs.enable_thinking` に対応するランタイムで thinking を切るためのものです。アプリは追加 body を転送しますが、Ollama を含むすべてのランタイムで同じ項目が受理され、thinking が切れるとは限りません。ランタイムとモデルの対応項目に合わせて変更し、無効化を確認してください。認証が必要な宛先は `apiKeyEnv` にキーを入れる環境変数名を指定します。

モデルを導入する前に空き容量を確認してください。モデル本体の大きさに加え、実行中のメモリ不足によるスワップ分も見込みます。必要量はモデル・量子化・文脈長・同時に動かすアプリで変わるため、モデルファイル分だけの空き容量では足りないことがあります。

## ローカルモード

`--local` / `--model apple` が約束するのは、会議の中身（音声・発言・マップ・共有画面と、その派生物）を Mac の外へ送らないことです。差分更新は live-mindmap が起動する Apple Intelligence の子プロセスだけを使います（[ADR 0014](docs/adr/0014-local-mode-only-own-child-processes.md)）。保存した録音・ログ・画像・書き出しファイルの管理や共有は利用者に委ねます。同期フォルダへ移す、外へアップロードするなど、保存後の扱いも利用者が決めてください。

会議の中身を含まない通信はこの約束に含みません。たとえば **SpeechAnalyzer の日本語モデルの初回取得**です。Chromium の初回導入や依存パッケージの取得も、会議の中身を送る通信とは別です。ローカルモードはすべてのネットワーク通信がゼロになるという約束ではありません。

Apple Intelligence は **試験的**です。決定・TODO の拾いすぎや取りこぼしがあり、合成会議1本で差分更新7回のうち4回が出力上限（600トークン）などで失敗した実測があります（#795で見直し中）。初版では共有画面の画像をモデルへ渡しません（`images: false` と同じ）。試験的を外す評価条件は [bench README](server/bench/README.md#apple-intelligence-の試験的を外す条件) にあります。

利用できないときは、Apple Intelligence がオフ・非対応の機種・macOS 27 未満・モデル準備中の理由と次の操作を表示して開始を拒否します。それ以外の理由はそのまま表示します。管理者による無効化は公開 API で見分けられず、独立した拒否理由にはしていません。

### helper も含めて通信を確かめる

1. `pnpm dev` を起動します。別のターミナルで `pnpm cli apps` から会議アプリの bundle id を確認します。
2. `pnpm cli start --local --app us.zoom.xos` のように実会議を開始します。
3. `pgrep -fl live-mindmap` と `ps -axo pid,ppid,command` で、この起動に属するサーバー（Node）・`live-mindmap-apple`・`live-mindmap-helper` の PID と親子関係を確認します。Node が一覧に出なければ `pgrep -fl 'node.*src/server.ts'` でも調べます。別セッションや別worktreeのプロセスを混ぜないよう、コマンドと親 PID を確認します。
4. 対象 PID ごとに別のターミナルで `nettop -p <PID>` を開き、話している間の接続先を観測します。`lsof -i -a -p <PID>` も補助的に使います。子プロセスが再起動したら PID を取り直します。会議の中身を扱う接続と、上記の対象外通信を区別して記録します。
5. `pnpm cli stop` で終了します。

#667 の実測では macOS 27 上の `play --local --realtime` 中に、Node と Apple 子プロセスを `nettop`（約1秒間隔）と `lsof`（約0.2秒間隔）で観測し、観測された接続はすべてループバック（127.0.0.1）でした。`play` は音声取り込みの helper を起動しないため、この実測に helper は含まれません。上の手順は `start --local` で helper も確認するためのもので、実施済みという意味ではありません。

## ライセンス

[MIT](LICENSE)。`cli install claude` で入れる `@anthropic-ai/claude-agent-sdk` は Anthropic の規約に従います。
