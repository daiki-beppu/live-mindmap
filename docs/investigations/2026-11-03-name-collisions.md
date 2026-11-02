# 名前の候補の衝突調査（Issue #1860）

- 問い: #1858 で絞った 8 個の候補（`nod`・`hum`・`vine`・`fern`・`said`・`lmap`・`heard`・`noted`）は、npm・GitHub・Homebrew・既存コマンド・同じ分野の製品名・商標で、他と衝突していないか。
- 調べた日: 2026-11-03（数値はすべてこの日の値。npm の DL 数は 2026-10-26〜2026-11-01 の 1 週間）。
- この文書は名前を決めない。推奨順位は付けず、衝突の事実と深刻さだけを書く。名前は別 ticket で人が選ぶ。

## 調べ方

| 場所 | 方法 |
|---|---|
| npm（素の名前） | `https://registry.npmjs.org/<name>`（最新版・説明・`time.modified`・`bin`）と `https://api.npmjs.org/downloads/point/last-week/<name>` |
| npm（`@<name>` スコープ） | `https://registry.npmjs.org/-/org/<name>/package`。存在しないスコープは `{"error":"Scope not found"}`（`zzqxnonexist12345` で確認）、存在してパッケージが無いスコープは `{}` を返す。user か org かはこの API では区別できない（`npmjs.com/org/<name>`・`/~<name>` は Cloudflare で 403 になり引けなかった）。加えて `@<name>/cli`・`@<name>/core` を registry で引いた（全候補 404） |
| GitHub（user・org） | `gh api users/<name>` |
| GitHub（同名リポジトリ） | `gh search repos "<name> in:name" --sort stars --limit 100` から名前が完全一致（大文字小文字を無視）のものを抜き出した。`nod`・`hum` は部分一致が多いため `search/repositories` を 10 ページ（上位 1000 件、検索 API の上限）まで見た |
| Homebrew | `https://formulae.brew.sh/api/formula/<name>.json`・`/api/cask/<name>.json`（全候補 404）。加えて `formula.json`（8,694 件）・`cask.json`（7,808 件）を落とし、名前を `-`・`_` 区切りの語として含むものを探した。インストール数は `api/analytics/install/90d.json` |
| 既存コマンド（この Mac） | `command -v <name>`・`man -w <name>`・`ls /usr/bin /bin /usr/sbin /sbin \| grep -x <name>`・`bash -c 'compgen -c <先頭3文字>'`（Tab 補完で並ぶもの） |
| 既存コマンド（Linux） | packages.debian.org の Contents 検索（`searchon=contents&mode=exactfilename&suite=stable`、trixie）と、パッケージ名の完全一致検索（`searchon=names&exact=1&suite=all`）。検索が効くことは `sed` で確かめた（`/usr/bin/sed` を含む 3 件） |
| 同じ分野の製品 | WebSearch と WebFetch。App Store・製品サイト・Product Hunt を引いた |
| 商標 | USPTO の Trademark Search（tmsearch.uspto.gov）の検索 API（`POST https://tmsearch.uspto.gov/prod-stage-v1-0-0/tmsearch`、`{"query":{"bool":{"must":[{"match":{"WM":"<name>"}}]}},"size":500}`）。wordmark が完全一致・`alive`・国際分類 9 類（ソフトウェア）か 42 類（SaaS）のものを数えた。J-PlatPat（日本）は対話式の画面だけで、スクリプトから引けなかった。EUIPO・WIPO は引いていない |

## 表

凡例: 「空き」= 衝突なし。「被り」= 何が・どの程度。「不明」= 引けなかった。

| 候補 | npm（素の名前） | npm（`@` スコープ） | GitHub user・org | GitHub 同名リポジトリ | Homebrew | 既存コマンド | 同分野の製品 | 商標（USPTO、9・42 類の生きた完全一致） |
|---|---|---|---|---|---|---|---|---|
| `nod` | 被り: `nod` 0.2.0（認可ライブラリ）、最終更新 2022-06、46 DL/週、`bin` なし | 被り: `@nod` に 20 パッケージ（`@nod/seed` 等、最終更新 2022-06）。`@nod/cli` は空き | 被り: User `nod`（161 repos、2008 年作成） | 空き（上位 1000 件に完全一致なし） | 空き | 空き。ただし Tab 補完で `node` と並ぶ（`nod*` → `node`）、`node` と 1 文字違い | 被り: Nod（Mac の AI ノートアプリ、会議を bot なしで書き起こし・要約） | 被り: 7 件（Nod, Inc. の AI ソフトウェア 2 件、Hopelab ほか） |
| `hum` | 被り: `hum` 2.1.7（grunt 補助）、最終更新 2022-06、51 DL/週、`bin` なし | 被り: スコープは存在、パッケージ 0（user か org か不明） | 被り: User `hum`（21 repos） | 被り（小）: mathias/hum 57★（2014 年で停止）、crbulakites/hum 44★ | 空き | 空き | 空き（`Hum` の会議製品は見つからず。近い名前に Humla、Mac の会議メモ） | 被り: 8 件（Hum Capital、Solid Space ほか。会議・文字起こしの分野ではない） |
| `vine` | 被り: `vine` 0.1.1（API builder、2013 年公開）、2,862 DL/週、`bin` なし | 被り: スコープは存在、パッケージ 0 | 被り: Org `vine`（10 repos） | 被り: vinejs/vine 1,282★（Node の検証ライブラリ、2026-10 更新）、VineLang/vine 402★、celery/vine 127★ | 被り（小）: cask `vine-server`（VNC、disabled） | 空き | 空き（会議・マインドマップ分野に Vine なし）。分野外: 終了した動画サービス Vine と、その復活版 DiVine（2025-11 ベータ） | 被り: 9 件（Twitter, Inc. の VINE が 3 件「REGISTERED AND RENEWED」、9・42 類を含む） |
| `fern` | 被り: `fern` 0.0.19（"clumpy utility thing"）、最終更新 2023-05、32 DL/週。別に `fern-api` の `bin` が `fern`（5.191.0、336,553 DL/週） | 被り: スコープは存在、パッケージ 0（Fern 社は `@fern-api` を使う） | 被り: User `fern`（4 repos） | 被り: fern-api/fern 3,830★（SDK 生成、2026-11 更新）、daboross/fern 915★（Rust のログ） | 被り: formula `fern-api`（`fern` コマンドを入れる、90 日 427 インストール） | 被り（条件付き）: この Mac・Debian には無いが、`npm i -g fern-api`・`brew install fern-api` で `fern` コマンドが入る | 空き（会議分野に Fern なし） | 被り: 6 件（Fern Health、Fernwayer ほか。会議分野ではない） |
| `said` | 被り: `said` 0.2.0（CLI の出力を文字列で返す）、最終更新 2022-06、22 DL/週、`bin` なし | 被り: スコープは npm user `said` のもの（`tvdb.js` 等の非スコープ 11 パッケージ、`@said/*` は無し） | 被り: User `said`（9 repos） | 被り（小）: yunik1004/SAiD 136★（音声駆動の顔アニメ研究）、ほか 35★ 以下 | 空き | 空き。ただし `/usr/bin/say` と 1 文字違い | 空き（同名の会議製品は見つからず） | 被り（小）: 1 件（サングラス等を含む個人の登録、9 類） |
| `lmap` | 被り: `lmap` 0.1.24（Leaflet の地図可視化）、最終更新 2022-06、118 DL/週、`bin` なし | 空き（`Scope not found`） | 被り: User `lmap`（0 repos、2012 年作成） | 被り（小）: MrLion7/Lmap 60★（masscan+nmap のスキャナ）、TrustAI-laboratory/LMAP 33★（LLM 脆弱性スキャナ） | 空き | 空き。ただし `nmap`（brew で 90 日 88,722 インストール）と 1 文字違い | 空き（会議分野になし）。分野外: IETF の LMAP（RFC 7594、ブロードバンド性能の大規模計測） | 空き（完全一致 1 件は失効） |
| `heard` | 空き（`package heard not found`） | 空き（`Scope not found`） | 被り: User `heard`（0 repos、2013 年作成） | 被り: heardlabs/heard 218★（macOS の Claude Code・Codex 向け音声レイヤー、`heard` CLI、2026-10-30 push）、dabit3/heard 241★、rerender2021/heard 66★（whisper の字幕生成） | 空き | 空き。ただし Tab 補完で `head`・`heap` と並ぶ、`head` と 1 文字違い | 被り: Heard（heard.dev。macOS で coding agent の進捗を読み上げ、声で返す。ソースから pip で `heard` CLI を入れる） | 被り: 7 件（Heard Technologies、Heard Holdings、SpeakRx ほか） |
| `noted` | 被り: `noted` 0.1.4（通知コントローラ）、最終更新 2022-06、52 DL/週、`bin` なし | 被り: スコープは存在、パッケージ 0 | 被り: Org `noted`（5 repos） | 被り（小）: Bingxi-Jiang/Noted 162★（リアルタイム文字起こしアプリ）、scottashipp/noted 99★（メモの CLI） | 空き | 空き | 被り: Noted.（Digital Workroom Ltd。iPhone・iPad・Mac・Watch。会議・講義の録音と文字起こし、評価 4.5・3.7K 件、2026-10 更新） | 被り: 4 件。うち Simple Design Ltd. の NOTED（登録 7128575、9 類「会議の議題」「音声を記録するメモ」のソフトウェア）は分野が重なる |

## 候補ごとの所見

深刻さは次の 3 段で書く。

- **重い**: 同じ CLI 名がインストールされうる、または同じ分野（会議・文字起こし・音声・agent 向け macOS ツール）の製品・商標と混同される。
- **中**: 検索で埋もれる、打ち間違い・補完で既存コマンドとぶつかる、分野外の有名な名前がある。
- **軽い**: 小さく放置されたパッケージ・リポジトリだけ。

### `nod`

- 重い: 同じ分野の製品がある。Nod は「The AI notepad for Mac that never joins as a bot」で、Mac のシステム音声から会議を書き起こし・要約する（Product Hunt、Capterra、BetaList）。live-mindmap と同じく macOS で bot を入れずに会議を拾う道具で、混同されやすい。USPTO にも Nod, Inc. の AI ソフトウェアの登録（6444330・7555813）がある（会議製品の Nod と同じ会社かは確かめていない）。
- 中: `nod` と打って Tab を押すと `node` が補完される（この Mac の `compgen -c nod` は `node` だけ）。`node` の打ち間違いとしても読める。
- 軽い: npm の素の名前と `@nod` スコープはどちらも他人のもの（2022 年で止まっている）。npm で配るなら別名が要る。

### `hum`

- 中: GitHub の `hum` で検索すると humanizer・hummingbot など部分一致の大きなリポジトリに埋もれる（完全一致は上位 1000 件のうち 2 件、57★・44★）。
- 軽い: npm の素の名前・スコープは他人のもの（放置気味）。商標は 8 件あるが金融・不動産・建築などで、会議分野ではない。同名の会議製品は見つからなかった（近い名前に Humla）。
- CLI 名の衝突は見つからなかった（この Mac・Debian・Homebrew）。

### `vine`

- 中: 分野外の有名な名前。Twitter, Inc. の VINE 商標が 9・42 類で更新されて生きており（4463660・4589497・4633017）、復活版 DiVine が 2025-11 にベータで出ている。検索では動画サービスに埋もれる。開発者の間では vinejs/vine（1,282★）が Node の検証ライブラリとして知られる。
- 軽い: npm の素の名前は週 2,862 DL あるが `bin` は無く、CLI 名はぶつからない。Homebrew の `vine-server` は disabled の別物。
- 同じ分野（会議・マインドマップ）の製品は見つからなかった。

### `fern`

- 重い: CLI 名がぶつかる。Fern 社の `fern-api`（npm で週 336,553 DL、Homebrew formula あり）が `fern` コマンドを入れる。開発者・agent の環境に既に `fern` が入っていることがあり、同じ PATH に置けない。
- 中: GitHub・検索では fern-api/fern（3,830★）と JetBrains の fernflower、Vim の vim-fern に埋もれる。
- 同じ分野の製品は見つからなかった。商標 6 件は医療・旅行・展示会などで会議分野ではない。

### `said`

- 中: `/usr/bin/say`（macOS の読み上げ）と 1 文字違い。`say` は音声まわりの道具で、このツールも音声を扱うため、打ち間違えると別の動作（読み上げ）が起きる。
- 軽い: npm の素の名前は小さな放置パッケージ、npm の `said` は別人の user。GitHub の完全一致は 136★ 以下。商標 1 件はサングラス等。
- 一般語のため検索で埋もれる。同じ分野の製品は見つからなかった。

### `lmap`

- 中: `nmap`（Homebrew で 90 日 88,722 インストール）と 1 文字違い。GitHub の完全一致上位 2 件（60★・33★）はどちらも nmap 風のスキャナで、名前の連想が「ネットワークの走査」に寄っている。IETF の LMAP（RFC 7594）もある。
- 軽い: npm の素の名前は小さな地図ライブラリ（`bin` なし）。`@lmap` スコープ・Homebrew・商標は空き。
- 同じ分野の製品は見つからなかった。調べた中で空きが最も多い。

### `heard`

- 重い: 同じ利用者層・同じ OS・同じ CLI 名の道具がある。Heard（heard.dev、heardlabs/heard 218★、2026-10 も更新中）は macOS の Claude Code・Codex 向けの音声レイヤーで、`heard install claude-code` のように `heard` CLI を使う。live-mindmap も主に AI エージェントが CLI を打つ macOS の音声ツールなので、インストール先と検索の両方でぶつかる。配布はソースからの `pip install -e .` と Mac アプリで、npm・Homebrew の `heard` はまだ空いている。
- 中: Tab 補完で `head` と並び、`head` と 1 文字違い。GitHub には rerender2021/heard（whisper の字幕生成）もある。商標 7 件（Heard Technologies は精神医療、Heard Holdings は飲食の POS、SpeakRx は患者の会話）。
- npm の素の名前・`@heard` スコープは空き。

### `noted`

- 重い: 同じ分野の製品と商標がある。Noted.（Digital Workroom Ltd）は会議・講義を録音して文字起こしする Apple 向けアプリで、Mac 版もあり評価 3.7K 件、2026-10 も更新されている。USPTO には Simple Design Ltd. の NOTED（7128575、9 類、会議の議題・音声メモのソフトウェア）が生きている。
- 軽い: npm の素の名前は放置パッケージ、`@noted` スコープと GitHub の org `noted` は他人のもの。CLI 名の衝突は見つからなかった（scottashipp/noted 99★ はメモの CLI だが Homebrew・Debian には無い）。

## 出典

npm（2026-11-03 取得）

- https://registry.npmjs.org/nod ・ /hum ・ /vine ・ /fern ・ /said ・ /lmap ・ /heard（`{"error":"Not found"}`）・ /noted
- https://api.npmjs.org/downloads/point/last-week/<name>（nod 46、hum 51、vine 2,862、fern 32、said 22、lmap 118、noted 52、heard は not found）
- https://registry.npmjs.org/fern-api/latest（`"bin": {"fern": "cli.cjs"}`、5.191.0）、https://api.npmjs.org/downloads/point/last-week/fern-api（336,553）
- https://registry.npmjs.org/-/org/<name>/package（nod: 20 パッケージ、hum・vine・fern・noted: `{}`、said: 非スコープ 11 パッケージ、lmap・heard: `Scope not found`）
- https://registry.npmjs.org/@<name>%2fcli ・ %2fcore（全候補 404）

GitHub（2026-11-03 取得）

- `gh api users/<name>`（nod User 161 repos、hum User 21、vine Organization 10、fern User 4、said User 9、lmap User 0、heard User 0、noted Organization 5）
- `gh search repos "<name> in:name" --sort stars --limit 100`、`gh api "search/repositories?q=<name>+in:name&sort=stars&per_page=100&page=1..10"`
- https://github.com/fern-api/fern 、https://github.com/vinejs/vine 、https://github.com/heardlabs/heard （`gh api repos/heardlabs/heard` と README）

Homebrew（2026-11-03 取得）

- https://formulae.brew.sh/api/formula/<name>.json ・ /api/cask/<name>.json（全候補 404）
- https://formulae.brew.sh/api/formula.json ・ /api/cask.json（`fern-api`: "Stripe-level SDKs and Docs for your API"、5.191.0。`vine-server`: VNC server、disabled）
- https://formulae.brew.sh/api/analytics/install/90d.json（node 719,160、nmap 88,722、fern-api 427）

既存コマンド

- この Mac（Darwin 27.0.0）: 8 候補とも `command -v`・`man -w`・`/usr/bin /bin /usr/sbin /sbin` で該当なし。`/usr/bin/say`・`/usr/share/man/man1/say.1` あり。`compgen -c nod` → `node`、`compgen -c hea` → `head headerdoc2html heap`
- https://packages.debian.org/search?searchon=contents&keywords=<name>&mode=exactfilename&suite=stable&arch=any（8 候補とも "Sorry, your search gave no results"）
- https://packages.debian.org/search?keywords=<name>&searchon=names&exact=1&suite=all&section=all（8 候補とも完全一致のパッケージなし）

同じ分野の製品

- Nod: https://www.producthunt.com/p/nod-9/nod-10 、https://www.capterra.com.au/software/1109565/Nod 、https://betalist.com/startups/hellonod （公式サイトとされる hellonod.app は第三者の掲載でしか確かめていない）
- Noted.: https://apps.apple.com/us/app/noted/id1149425482 （iPhone・iPad・Vision・Watch、4.5・3.7K 件、7.1.1）、https://apps.apple.com/us/app/noted/id1446580517?mt=12 （Mac、macOS 14.6 以降）、開発元 https://www.notedapp.io/
- Heard: https://heard.dev/ 、https://github.com/heardlabs/heard
- Fern: https://buildwithfern.com/
- Humla（`hum` の近い名前）: https://www.producthunt.com/products/humla
- DiVine（Vine の復活版）: https://www.wnem.com/2025/11/15/video-platform-vine-is-being-rebooted-divine/
- LMAP: https://www.rfc-editor.org/rfc/rfc7594
- `hum`・`vine`・`fern`・`said`・`lmap` の会議・マインドマップ製品は WebSearch で見つからなかった（「見つからなかった」で、無いことの証明ではない）

商標

- USPTO Trademark Search の API（`POST https://tmsearch.uspto.gov/prod-stage-v1-0-0/tmsearch`、各候補 500 件まで）。9・42 類の生きた完全一致: nod 7、hum 8、vine 9、fern 6、said 1、lmap 0、heard 7、noted 4
- 名指しで引いた登録: NOTED 7128575（Simple Design Ltd.、9 類、会議の議題・音声メモ）、NOD 6444330・7555813（Nod, Inc.、9・42 類、AI ソフトウェア）、VINE 4463660・4589497・4633017（Twitter, Inc.）
- J-PlatPat（https://www.j-platpat.inpit.go.jp/）: スクリプトから引けず、日本の商標は調べていない。EUIPO・WIPO も調べていない。有料の調査はしていない
