# Drive for Desktop のフォルダをセッションの置き場所にして困ること（Issue #1274）

地図 [#1232](https://github.com/daiki-beppu/live-mindmap/issues/1232) の調査チケット [#1274](https://github.com/daiki-beppu/live-mindmap/issues/1274)。**Drive への保管**を「セッションの置き場所そのものを Drive にする」形で行うとき、第一候補の Google Drive for Desktop のフォルダ（`~/Library/CloudStorage/GoogleDrive-<account>/` の下）に `LIVE_MINDMAP_SESSIONS` を向けて、会議中・会議後の live-mindmap が困らないかを調べた。調べた日は 2026-10-17、main は `37d8a04`。

出典は Google の Drive for Desktop のヘルプ・管理者向けの文書・リリースノートと、Apple の File Provider の文書・技術ノート・xnu のソース（末尾の「出典」）。live-mindmap がどう書き、どう読むかはこのリポジトリのコードで確かめた。手元の観察は、Drive for Desktop の設定の読み取りと置き場所の最上位の一覧、スクラッチの一時フォルダでの実験だけで、**Drive のフォルダにも `gdrive:` にも書き込んでいない**。**［未確認］** と付けたものは一次資料でも手元でも裏が取れていない。

## 結論

- **ストリーミング（既定）の Drive フォルダを、会議中に書き続ける置き場所にするのは勧めない**。Google 自身が「同期していない変更は手元のキャッシュにあり、キャッシュが消えたり壊れたりすると失われうる」「書き込みの多いアプリはミラーリングの方が速い」と書いている [1][2]。live-mindmap は会議中、`log.jsonl` に 1 行ずつ追記し、そのたびに `export.json` を丸ごと書き直す（3 時間の会議で約 5 万回）。録音の m4a は会議の間ずっと開いたまま伸び、閉じるまで再生できない（手元で確かめた）
- **ミラーリングなら、書く側の心配はほぼ普通の手元のフォルダと同じになる**。ただしミラーリングのフォルダは利用者が選ぶ CloudStorage の外の普通のフォルダで、マイドライブ全体が手元にも残る [2]。「手元と Drive の両方に残る形は望まない」という地図の方向とは合わない
- **会議後の読み直しは、ストリーミングでは「止まって待つ」か「失敗する」**。キャッシュから追い出されたファイル（dataless）を読むと、ダウンロードが済むまでシステムコールが止まり、届かなければ `ETIMEDOUT` などで失敗する [6][7]。オフラインでは、手元に無いファイルは読めない [3]。見返し（`cli review`）・`cli restore`・`cli publish`・`bench/sessionStats.ts` は録音や `log.jsonl` を丸ごと読む。語彙の溜まり `vocabulary.json` はセッションの開始時に読むので、開始が止まる・溜まりを使えない警告になる、のどちらかになりうる
- **置き場所の外にも Drive に出てしまう物がある**。サーバーの PID の記録と、モデルの受け渡しのトークン（秘密の値）は、置き場所の**隣**（`<置き場所>.server/`・`<置き場所>.model-transfer/`）に書く。置き場所を Drive に向けると、これらも Drive に上がる。どの形を採っても、先にこの 2 つを `~/.live-mindmap/` の固定の場所へ移す必要がある
- **勧める形: 会議中は手元に書き、締めた後に Drive のフォルダへ移す**（作業の場所と保管の場所の 2 つの根）。Drive for Desktop はストリーミングのまま「書き終えたファイルを受け取る場所」として使えば、上の書き込みの問題を避けられ、手元には残らない（キャッシュは macOS が管理する）。読み直しの問題は残るので、`review`・`restore`・`publish` で Drive から読むときの失敗の文面と、開始前の確かめでの `vocabulary.json` の扱いを決める必要がある

## live-mindmap がセッションのファイルをどう書き、どう読むか

### 書き方（コードで確かめた）

| ファイル | 書く者 | 書き方 | 頻度 |
|---|---|---|---|
| `log.jsonl` | サーバー（`server/src/sessionFiles.ts` の `writeLogLine`） | `fs.writeFileString(..., { flag: "a" })`。1 行ごとに開いて追記して閉じる。開きっぱなしの手は持たない | ログの行ごと。手元の 3 時間強のセッションで 52,469 行・16 MB |
| `export.json` | サーバー（同 `writeExport`） | `fs.writeFileString` で丸ごと上書き（一時ファイル→rename ではない。truncate してから書く） | ログの行ごと（同じロックの中で、ログの 1 行の直後）。上のセッションで約 5 万回・最後は 444 KB |
| `相手.m4a`・`自分.m4a`（起動し直しで `-2` などが増える） | ヘルパー（`helper/Sources/HelperCore/Recording.swift` の `TrackRecorder`、`AVAudioFile(forWriting:)`） | 会議の間ずっと開いたまま追記し、`finish` で閉じる。AAC の m4a で、閉じるまで再生できない（下の実験） | 音声のバッファごと。上のセッションで各 90 MB |
| `screens/*.jpg` | サーバー（`writeScreen`） | 1 枚ずつ新しいファイルに書く | 共有画面が変わるたび。上のセッションで 1,450 枚・46 MB |
| `map.md`・`map.json`・`map.drawnix`・`map.png`・`map.html`・`map-audio.html` | サーバー・`cli`（`writeExportsAndCapture`・`writeReviewPages`） | 締めたとき（と `cli review` のとき）に丸ごと上書き。`map-audio.html` 用の mix は OS の一時フォルダに書いて読み、セッションのフォルダには書かない（`server/src/review.ts`） | 1 回。`map-audio.html` は上のセッションで 78 MB |
| `<置き場所>/vocabulary.json` | サーバー・`cli`（`server/src/vocabularyPool.ts` の `writePool`） | `vocabulary.json.tmp` に書いて `rename`（一時ファイル→置き換え） | セッションの開始・終了、`cli restore`、`cli vocab forget` |
| `<置き場所>.server/<port>.pid` | サーバー（`server/src/serverProcess.ts`） | 上書き。サーバーが閉じるときに消す | サーバーの起動ごと |
| `<置き場所>.model-transfer/<port>.token` | サーバー（`server/src/modelTransferToken.ts`） | 同じフォルダの中の一時フォルダに `wx`・`0600` で書いて `rename`。フォルダは `0700`。サーバーが閉じるときに消す | サーバーの起動ごと。中身はモデルの受け渡しに使う 32 バイトの乱数の秘密 |

セッションのフォルダは `createSessionDir(sessionsDir)` が置き場所の直下に作る（名前は開始時刻、重なれば `-2`…）。ヘルパーにはそのフォルダのパスを引数で渡す（録音の書き出し先）。

### 読み直す物（会議中・会議後）

| 読む者 | 読む物 |
|---|---|
| サーバーのセッションの開始（`sessionSinks.ts` の `startPoolSession(dirname(dir))`） | `vocabulary.json` 全体 |
| サーバーの差分更新（`readScreen`） | 会議中に書いた `screens/*.jpg`（書いた直後なので手元にある） |
| サーバーの締め（`updatePoolFromSession`・`writeReviews`） | `log.jsonl` を 1 行ずつ、録音（ヘルパーの `mix` が AVFoundation で読む） |
| `cli export` | 置き場所の直下を一覧し、最新のセッションの `export.json` |
| `cli restore` | 最新のセッションの `log.jsonl` 全体。`export.json` と `vocabulary.json` を書き直す |
| `cli review [session]` | `log.jsonl` 全体と録音（mix） |
| `cli publish [session]` | `log.jsonl` 全体（公開する HTML は OS の一時フォルダで作る） |
| `cli vocab list/forget` | `vocabulary.json` |
| `cli server stop`・`cli start` などのモデルの受け渡し | `<置き場所>.server/`・`<置き場所>.model-transfer/` |
| `server/bench/sessionStats.ts <dir>...` | `log.jsonl` と録音（ffmpeg で音量を測る） |
| 利用者 | `map.html`・`map-audio.html` などをブラウザで開く |

「最新のセッション」は `latestSession` が置き場所の直下を `readDirectory` し、名前の順で最後のフォルダを選ぶ（`server/src/cli.ts`）。一覧を取るだけなら中身は落とさない（ディレクトリの一覧は File Provider に一覧を頼む [6][11]）。

### 手元で確かめたこと

| やったこと | 結果 |
|---|---|
| `~/Library/CloudStorage/` の一覧 | `Dropbox` と `GoogleDrive-<account>`。後者は `dr-x------`（直下には作れない） |
| `GoogleDrive-<account>/` の一覧 | `マイドライブ` の 1 つだけ。名前は日本語に訳されて、**NFD**（`ト` + 結合用の濁点 `e3 82 99`）で入っている |
| `defaults read com.google.drivefs.settings`（メールは伏せた） | `mount_point_path` が `~/Library/CloudStorage/GoogleDrive-<account>` |
| Drive for Desktop の版・macOS | Drive for Desktop 121.0、macOS 27.0.1。File Provider の拡張 `com.google.drivefs.fpext(121.0)` が登録されている |
| `ls -lO` で `マイドライブ` 直下のファイルの印 | 15 ファイルすべて `compressed,dataless`。**この Mac はストリーミングの設定**で、ファイルは手元に中身が無い |
| `~/Library/Application Support/Google/DriveFS/<id>/content_cache` の大きさ | 52 KB（中身はほぼ持っていない） |
| スクラッチで、NFD の名前のフォルダを NFC の文字列で `existsSync` | 見つかる（APFS は正規化を区別しない）。`readdirSync` が返す名前は NFD で、NFC の文字列とは `===` で一致しない |
| スクラッチで、`AVAudioFile(forWriting:)` の AAC m4a に 5 秒書き、閉じる前に複製して `afinfo` | 閉じる前の複製は `AudioFileOpenURL failed`（開けない）。閉じた後は 5.0 秒と読める。閉じる前 79,477 バイト → 閉じた後 79,810 バイト（閉じるときに頭の情報を書き足す） |
| 手元の最大のセッション（`~/.live-mindmap/sessions/` の 1 つ、件数と大きさだけ） | 録音 2 本で 180 MB（64 kbps なので約 3.1 時間）、`log.jsonl` 52,469 行・16 MB、`map-audio.html` 78 MB、`screens/` 1,450 枚。置き場所全体で 1.0 GB |

## 各問いへの答え

### 会議中に書き続けるファイル（書き途中の同期・競合・ロック・アップロードの重さ）

一次資料にあること:

- ストリーミングは macOS 12.1 以降で Apple の File Provider を使い、置き場所は `~/Library/CloudStorage` で変えられない [3]。今の版は macOS 13 以上が要るので、ストリーミングは必ず File Provider になる [5]
- File Provider は、低い層の書き込みのイベントを同期の単位にまとめ、変更されたファイルの**複製**を拡張に渡すので、書き続けていても一貫した版を上げられる。一時ファイル→rename の「安全な保存」は見分けて、同じファイルとして扱う [6]
- Drive for Desktop は 99.0（2024-10）から、大きいファイルを変えたとき**変わった部分だけ**を上げる [5]
- Google は「書き込みの多いアプリ・動画や高解像度の写真の編集は、ミラーリングの方が速い」「ファイルをストリーミングしにくい API の組み合わせを使うアプリがある」と書く [2]
- 版の履歴: 「保存し続ける」を付けない版は、30 日経つか、新しい版が 100 個できると消えることがある [9]
- 上限: 1 日 750 GB のアップロード、1 ファイル 5 TB、1 フォルダ直下 50 万項目 [10]。上限に当たると後で自動で再試行する [4]
- 同期できなかった変更は、元の親フォルダに編集を含んだ複製ができる（手元の変更がクラウドの変更と両立しないとき）[4]。上げられなかったファイルは `~/Library/Application Support/Google/DriveFS/lost_and_found/<account_token>` に写される [4]

live-mindmap に当てはめると:

- **`log.jsonl` と `export.json`**: どちらも 1 行ごとに変わる。File Provider が変更をまとめるので毎回上がるとは限らないが、まとめ方の間隔は文書に無い **［未確認］**。仮に上げるたびに版ができるなら、`export.json` は会議の数分で 100 版を超え、古い版はすぐ消える（害は無いが、版の履歴は役に立たない）。`export.json` は truncate してから書くので、上がった瞬間によっては空や途中の版が上がりうる（最後には完全な版が上がる）。これは今の手元でも同じ性質で、Drive 特有ではない
- **録音の m4a**: 会議中ずっと開いたまま伸び、閉じるまで再生できない（上の実験）。File Provider は開いている間の複製を上げうるので、Drive に途中の「開けない m4a」の版が残りうる。差分のアップロードが効けば転送量は抑えられるが、開いている間の振る舞いは文書に無い **［未確認］**。会議の途中で Mac が落ちれば録音は手元でも開けないので、そこは Drive 特有の害ではない
- **競合**: セッションのフォルダは 1 台の Mac の 1 つのプロセスだけが書くので、別の端末との競合は起きにくい。起きうるのは `vocabulary.json`（全セッション共有）を 2 台の Mac で使うときと、利用者が Drive の Web で同じファイルを動かしたとき。複製の名前の付き方は文書に無い **［未確認］**。複製ができても live-mindmap は元の名前しか読まないので、黙って片方の変更が無視される
- **ロック**: live-mindmap は `flock` などのロックを使っていない（書く者が 1 つだけの前提）。File Provider がロックとどう付き合うかは「ファイルの調整と勧告的なロックに統合する」とだけあり、細部は文書に無い [6]
- **`rename`**: `vocabulary.json` とトークンは一時ファイル→rename。File Provider は安全な保存を見分ける [6] が、rename が不可分であることを保証する文は無い **［未確認］**。トークンのフォルダの `0700`・ファイルの `0600` が File Provider の下で保たれるか、Drive に上がるときに権限がどうなるかも文書に無い **［未確認］**（そもそも秘密を Drive に上げるべきではない）

### オフライン（会議中に落ちる・最初から無い）

- ストリーミングでも、オフラインで書いた物は手元のキャッシュに置かれ、つながったら上がる [1]。手元で作ったファイルは Drive for Desktop が動いていなくても読める [3]
- ただし「同期していない変更はキャッシュにあり、キャッシュが消えたり壊れたりすると失われうる」[2]。キャッシュを消すと、上げ終わっていないファイルは失われる [12]。アカウントを切り離すと、オフライン用のファイルは消える [1]
- キャッシュの大きさと場所は macOS が管理し、上限は決められない [1][12]。空きが足りないと同期できない [4]。macOS は空きが急に要るとき、**上げ終わったファイルだけ**を追い出す [6]
- 同期を一時停止している間は、ファイルを落とせない。File Provider では、落としていないファイルにはアクセスできない [3][1]
- ミラーリングは普通の手元のフォルダなので、アプリが落ちても手元のファイルは残る [2]

live-mindmap に当てはめると: 会議中に回線が落ちても、新しく書くファイル（ログ・録音・画面）の書き込みは通り、後で上がる。困るのは**読み**で、会議の開始時に `vocabulary.json` が手元に無い（追い出された・別の Mac で書かれた）と、オフラインでは読めない。今のコードはそのとき警告を 1 行出して溜まりを使わずに始める（`vocabularyPool.ts`）ので止まりはしないが、読みが `ETIMEDOUT` になるまでの待ちの長さは文書に無い **［未確認］**。また、この回の終了時に溜まりを書き直すと、前の回の語が入らない溜まりで上書きしうる（読めなかった回は `startPoolSession` が `undefined` を返し、番号の行を書かないので、終了時の更新は飛ぶ。上書きはしない。コードで確かめた）。

会議が長い・録音が大きい（3 時間で 180 MB、`map-audio.html` を含めると 300 MB 近い）ので、上げ終わるまでの間に Mac を閉じる・アカウントを切る・キャッシュを消すと失いうる。手元を正にしないなら、上げ終わったかを確かめる手段が要るが、Drive for Desktop の上げ終わりを外から確かめる公式の口は見つからなかった **［未確認］**。

### ストリーミングで追い出されたファイルの読み直し

- 中身の無いファイル（dataless）を読むと、カーネルはそのシステムコールを止めて拡張に中身を頼み、届いたら続ける [6]。ディレクトリの一覧も同じく止まる [6][11]
- Apple の技術ノート TN3150 は、dataless のファイルに慣れていないアプリの症状として、ファイルシステムの API の `ETIMEDOUT` と止まりを挙げる。中身を落とさない設定（`setiopolicy_np` の `IOPOL_MATERIALIZE_DATALESS_FILES_OFF`）にしたプロセスは `EDEADLK` を受ける [7][8]
- オフライン・同期の一時停止中は、落としていないファイルにはアクセスできない [1][3]
- 「オフラインで使用可能」にしたファイル・フォルダは手元に保たれる（ストリーミングの設定でだけ選べる）[1]

live-mindmap に当てはめると:

- **見返しの閲覧**（利用者がブラウザで `map-audio.html` 78 MB を開く）: オンラインなら落とす時間だけ待つ。オフラインなら開けない
- **`cli review`・`cli restore`・`cli publish`・`bench/sessionStats.ts`**: `log.jsonl`（十数 MB）と録音（百数十 MB）を読むので、落とすまで止まる。オフラインでは失敗し、今の文面は「`log.jsonl` がありません」ではなく `PlatformError` の 1 行（`describe`）になる。`ETIMEDOUT` を `PlatformError` がどの理由に写すか（`Unknown` か）は確かめていない **［未確認］**
- **`cli export`**: 一覧は止まりうるが小さい。`export.json` の 1 つだけを読む
- **ヘルパーの `mix`**: AVFoundation が読むので、同じく落とすまで止まる。止まりの長さは文書に無い **［未確認］**
- **`vocabulary.json`**: 上の「オフライン」のとおり。毎回の開始で読むので、追い出されることは少ないと思われるが、追い出しの規則は macOS が決め、文書に無い **［未確認］**
- **ミラーリングとの違い**: ミラーリングは全部が手元にあり、オフラインでも読める [2]。読みの問題は無い

一次資料で食い違う点が 1 つある。`getiopolicy_np(3)` とカーネルのソースは、プロセスの既定を「中身を落とさない（OFF）」と書くが、WWDC と TN3150 は普通の読みで落とすと書く [6][7][8]。手元のツール（`cat` など）で実際に落ちるかは、Drive のフォルダを読まない約束のため確かめていない **［未確認］**。

### パスの形

- `GoogleDrive-<account>` の `<account>` はメールアドレスで、`@` と `.` を含む。マイドライブの部分は、日本語の macOS では **`マイドライブ` という日本語の名前で、NFD で**入っている（手元で確かめた。一次資料には名前の形の記述が無い）。英語の macOS なら `My Drive`（空白入り）と思われる **［未確認］**
- Node・ヘルパーへの引数・`AVAudioFile` の URL は、どれも空白・`@`・日本語を受ける。APFS は正規化を区別しないので、NFC で打ったパスでも開ける（手元のスクラッチで確かめた）
- 困りうる点:
  - パスの文字列を `===` や `startsWith` で比べるコードを足すと、NFC と NFD で食い違う（今の live-mindmap には、置き場所のパスを比べる所は無い。`dirname(dir)` は同じ文字列から作る）
  - `GoogleDrive-<account>/` の直下は `dr-x` で書けない。置き場所はその下の `マイドライブ/<フォルダ>` にする必要がある。`LIVE_MINDMAP_SESSIONS` を `GoogleDrive-<account>` そのものに向けると、隣の `<置き場所>.server` が作れずにサーバーが起動に失敗する（コードからの推論）
  - メールアドレスがパスに入るので、ログや失敗の文面にパスを出すと、メールアドレスが出る（エージェントが会話に貼る・Issue に貼る）
  - シェルで打つときは空白（英語の `My Drive`）を引用符で囲む必要がある。エージェント向けの案内の例で引用符を落とすと動かない
  - 置き場所のパスは利用者ごと・言語ごとに違うので、既定値としてコードに書けない

### 置き場所を 2 つ（Drive と手元）に分けるとき、今のコードがどこまで対応するか

今のコードは「置き場所は 1 つの根、セッションのフォルダはその直下」を何か所かで前提にしている。

| 所 | 今の前提 | 2 つの根にするときに要ること |
|---|---|---|
| `server/src/config.ts` の `sessionsDirConfig` | 根は 1 つの環境変数 | 2 つ目の根の設定（例: 作業の場所と保管の場所、またはローカルモード用の根） |
| `sessions.ts` の `begin`・録画からのセッション、`cli.ts` の `play` | `createSessionDir(sessionsDir)` に 1 つの根を渡す | どちらの根に作るかを開始時に決める。ローカルモードかどうかは開始時に分かる（`input.model.local`）ので、そこで選べる |
| `sessionSinks.ts` の語彙の溜まり | `startPoolSession(dirname(dir))`・`updatePoolFromSession(dir, dirname(dir))`。**セッションのフォルダの親を溜まりの場所とみなす** | 溜まりの場所を `dirname(dir)` から外し、設定から渡す。そうしないと根ごとに溜まりが分かれる |
| `cli.ts` の `latestSession`（`export`・`restore`・`review`・`publish` の既定） | 1 つの根の直下で名前の順の最後 | 2 つの根を合わせて選ぶか、どちらの根を見るかを決める |
| `cli restore` | `updatePoolFromLog(sessionsDir, ...)` で設定の根の溜まりを更新 | 溜まりの場所を根と切り離す（上と同じ） |
| `cli vocab list/forget` | `vocabularyPoolPath(sessionsDir)` | 同上 |
| `serverProcess.ts`・`modelTransferToken.ts` | 根の**隣**に `.server/`・`.model-transfer/` | 根から切り離し、`~/.live-mindmap/` の固定の場所へ。根が Drive なら 1 つでもこの変更は要る（秘密を Drive に上げない） |
| `cli review <session>`・`cli publish <session>`・ヘルパー・`bench/sessionStats.ts` | フォルダのパスを引数で受ける | そのまま動く |
| 締めた後に移す形（作業の場所 → 保管の場所） | 無い | 締めの後（`writeExportsAndCapture` の後、ヘルパーが録音を閉じた後）にフォルダごと移す処理。CloudStorage と手元は同じ APFS のボリュームだが、File Provider の領域への `rename` が複製＋削除になるかは **［未確認］**。失敗・途中の中断で手元と Drive の両方に半端に残る場合の扱いが要る |

まとめると、根を分けるには、(1) 溜まりの場所を `dirname(dir)` から外す、(2) PID とトークンを根の隣から外す、(3) 「最新のセッション」の選び方を決める、の 3 つが要る。セッションのフォルダの中身を書く処理（`sessionFiles.ts`・ヘルパー）は、渡されたフォルダに書くだけなので変えなくてよい。

### 対案（rclone）との比較

rclone の呼び方は [#1269](https://github.com/daiki-beppu/live-mindmap/issues/1269) の調査（`research/drive-rclone` の `docs/investigations/2026-10-17-drive-rclone.md`）による。地図の方向（手元に残さない）に合わせて、rclone の形は「会議中は手元に書き、締めた後に `rclone copy`（またはセッションのフォルダに限った `move`）で Drive に送り、手元を消す」とする。

| 観点 | Drive for Desktop（ストリーミング）に直接書く | Drive for Desktop に締め後に移す | rclone で締め後に送って手元を消す |
|---|---|---|---|
| 会議中の書き込み | File Provider が書き続けのファイルを扱う。途中の版・開けない m4a の版が上がりうる。Google は書き込みの多いアプリにミラーリングを勧める | 手元に書くので今と同じ | 手元に書くので今と同じ |
| 回線が落ちたとき | 書き込みは通り、後で上がる。上がる前にキャッシュが消えると失う | 移した後は同じ（上がるまではキャッシュ） | 送る時点で失敗し、手元に残る。失敗が終了コードで分かる |
| 上げ終わりの確かめ | 外から確かめる公式の口が無い **［未確認］** | 同左 | `rclone copy` の終了コード 0 で確かめられる。確かめてから手元を消せる |
| 会議後の読み直し | 追い出されると落とすまで止まる。オフラインでは読めない | 同左 | 手元を消した後は読めない（`rclone copy` で戻す手順が要る）。live-mindmap は Drive から読む口を持たない |
| 手元に残る物 | macOS が管理するキャッシュだけ | 同左 | 送って消した後は何も残らない |
| 要る設定 | Drive for Desktop の導入とサインイン（この Mac は済み）。置き場所のパスは利用者ごと | 同左 | rclone の導入と `rclone config`（この Mac は済み）。行き先は `gdrive:live-mindmap` のような短い文字列 |
| live-mindmap の変更 | PID・トークンを根の隣から外す。開始前の確かめに置き場所の確かめを足す | 左に加え、作業の場所と保管の場所の 2 つの根、溜まりの場所の切り離し、締め後の移動 | 2 つの根の代わりに保管の Service（rclone を呼ぶ）、溜まりの場所はそのまま手元、手元を消す時機（#1271） |
| テスト | 置き場所を一時フォルダに向けるだけ（Drive for Desktop の振る舞いは再現できない） | 保管の場所を一時フォルダに向けるだけ | `:local:` と `RCLONE_CONFIG=/dev/null` で本物の rclone を流せる |
| ローカルモード | 置き場所を分けない限り Drive に上がる（Drive for Desktop が上げるので、live-mindmap が止められない） | 締め後に移さなければよい | 送る前に `log.jsonl` の `model.local` で拒める（`publish` と同じ） |
| 版の履歴 | 書き続けの間に版が増え、100 版・30 日で消える | 移した時の 1 版 | 送るたびに 1 版 |

## 推奨

1. **Drive for Desktop のフォルダを、会議中に書き続ける置き場所にはしない**。ストリーミング（この Mac の今の設定・既定）では、Google 自身が書き込みの多いアプリに勧めず、上げる前の変更はキャッシュにしかない。ミラーリングなら書きの問題は消えるが、マイドライブ全体が手元にも残るので、地図の「手元に残さない」と合わない。どうしても直接置くなら、ミラーリングの設定を前提にする
2. **形は「会議中は手元に書き、締めた後に保管の場所へ移す」にする**。保管の場所が Drive for Desktop のフォルダ（ストリーミング）なら、移した後は手元にキャッシュしか残らない。rclone で送って手元を消す形と、手元での書き方は同じになり、違いは「移す先と、上げ終わりを確かめられるか」だけになる。上げ終わりを確かめてから手元を消せる点で、rclone の方が失わない
3. **どの形でも先に直すこと**: サーバーの PID の記録とモデルの受け渡しのトークンを、置き場所の隣（`<置き場所>.server/`・`<置き場所>.model-transfer/`）から `~/.live-mindmap/` の固定の場所に移す。置き場所を Drive に向けた時点で、秘密のトークンが Drive に上がるため
4. **語彙の溜まり（`vocabulary.json`）の場所をセッションの置き場所から切り離す**。今は `dirname(dir)` で決まる。手元の `~/.live-mindmap/` に置けば、開始時の読みが Drive の追い出し・オフラインに左右されない。2 台の Mac で溜まりを共有したいかは利用者に聞く問い（共有したいなら Drive に置くことになり、競合の複製で片方の変更が黙って捨てられうる）
5. **Drive for Desktop を使うなら、開始前の確かめ（または保管のコマンドの中）で見ること**:
   - 保管の場所のフォルダがあり、書けるか（`GoogleDrive-<account>/` の直下は書けない）
   - そのパスが `~/Library/CloudStorage/GoogleDrive-*/` の下か（ストリーミングなら File Provider の領域）。ミラーリングのフォルダは普通のフォルダで見分けが付かない
   - 開始時に `vocabulary.json` を Drive から読むなら、読みに時間がかかる・失敗することを前提に、警告にして始める（今の振る舞いのまま）
   - オフラインかどうかは、開始前に確かめても会議中に変わる。書き込みは通るので、開始を止める理由にはしない
   - 「欠けても一部の出力が減るだけのもの」として扱い、保管できないことで会議を止めない（地図の決定「保管は任意」）
6. **会議後に Drive から読むコマンド**（`review`・`restore`・`publish`・`sessionStats`）は、オフラインで落とせないときの失敗の文面を「Drive から落とせませんでした（オフラインか、Drive for Desktop が止まっています）」のように分かる形にする。今は `PlatformError` の 1 行で、原因が読めない
7. **人の手で確かめること**（ticket の外）: 本物の Drive for Desktop のフォルダで、(a) 書き続けの m4a・追記の `log.jsonl` を置いたときに Drive にできる版の数、(b) 追い出されたファイルを `cat` で読んだときに落ちるか・オフラインで何秒でどの errno か、(c) 手元のフォルダから CloudStorage へ `rename` で移したときの振る舞い。いずれも本チケットでは Drive に書かない約束のため確かめていない

## 確かめられなかったこと

- Drive for Desktop が、開いて書き続けているファイルを、閉じるまで待つのか、途中で何度も上げるのか。File Provider の変更のまとめ方の間隔
- 競合の複製の名前の付き方（第三者の記事は `[Conflict]` や ` (2)` と書くが、Google の文書に無い）
- 上げ終わったかを外から確かめる公式の口
- dataless のファイルを読んだときの待ちの長さと、オフラインで返る errno（`ETIMEDOUT` か `EDEADLK` か）。`getiopolicy_np(3)` の既定（OFF）と、WWDC・TN3150 の「読めば落とす」の食い違い
- Effect の `PlatformError` が `ETIMEDOUT`・`EDEADLK` をどの理由に写すか
- File Provider の下での `rename` の不可分性、`flock` の振る舞い、`chmod 0700`・`0600` が保たれるか、FSEvents・`fs.watch` の振る舞い
- 手元のフォルダから CloudStorage の下へ `rename` したとき、複製＋削除になるか
- 英語の macOS での `My Drive` の名前と正規化。`GoogleDrive-<email>` という名前の形の一次資料
- ミラーリングの既定のフォルダの場所
- macOS がキャッシュからファイルを追い出す規則（いつ・どれから）

## 出典

1. Google ドライブ ヘルプ「Use Drive for desktop offline / ファイルをオフラインで使用する」（キャッシュの管理・オフラインでの編集・切り離し）: https://support.google.com/drive/answer/13470231
2. Google ドライブ ヘルプ「Stream & mirror files with Drive for desktop」（ストリーミングとミラーリングの違い・切り替え・書き込みの多いアプリ）: https://support.google.com/drive/answer/13401938 、比較表 https://support.google.com/drive/answer/16631477
3. Google ドライブ ヘルプ「Drive for desktop with File Provider on macOS」（macOS 12.1 以降の File Provider、`~/Library/CloudStorage` は変えられない、一時停止中は落とせない）: https://support.google.com/drive/answer/12178485
4. Google ドライブ ヘルプ「Fix problems with Drive for desktop」（空き容量、同期できない変更の複製、lost_and_found、上限での再試行）: https://support.google.com/drive/answer/2565956
5. Google Workspace 管理者ヘルプ「Drive for desktop release notes」（99.0 の差分のアップロード、127.0 で macOS 13 以上）: https://knowledge.workspace.google.com/admin/drive/google-drive-for-desktop-release-notes
6. Apple WWDC21「Sync files to the cloud with FileProvider on macOS」（読みで落とす・一覧で止まる・変更の複製・安全な保存・追い出しは上げ終わったものだけ・勧告的なロック）: https://developer.apple.com/videos/play/wwdc2021/10182/
7. Apple TN3150「Getting ready for dataless files」（`ETIMEDOUT`・止まり・`SF_DATALESS`・`EDEADLK`）: https://developer.apple.com/documentation/technotes/tn3150-getting-ready-for-data-less-files
8. xnu `bsd/man/man3/getiopolicy_np.3`・`bsd/vfs/vfs_syscalls.c`: https://github.com/apple-oss-distributions/xnu
9. Google ドライブ ヘルプ「ファイルのバージョンを確認する」（100 版・30 日）: https://support.google.com/drive/answer/2409045
10. Google Workspace 管理者ヘルプ「Storage and upload limits」（750 GB/日・5 TB・項目数）: https://knowledge.workspace.google.com/admin/drive/storage-and-upload-limits-for-google-workspace
11. Apple Developer Forums（一覧で拡張が呼ばれる）: https://developer.apple.com/forums/thread/756129 、（File Provider のパスでの `Resource deadlock avoided`）: https://developer.apple.com/forums/thread/763344
12. Google Workspace 管理者ヘルプ「Advanced Drive for desktop configuration」（`ContentCachePath` などは macOS 12.1 以降に効かない、上げる前にキャッシュを消すと失う）: https://knowledge.workspace.google.com/admin/drive/advanced-drive-for-desktop-configuration
13. Apple「NSFileProviderManager.evictItem」（開いている手があると `EBUSY`）: https://developer.apple.com/documentation/fileprovider/nsfileprovidermanager/evictitem(identifier:completionhandler:) 、「Synchronizing the File Provider extension」（変更が残る項目は追い出さない）: https://developer.apple.com/documentation/fileprovider/synchronizing-the-file-provider-extension
- このリポジトリ: `server/src/config.ts`、`server/src/sessionFiles.ts`、`server/src/sessionSinks.ts`、`server/src/sessions.ts`、`server/src/vocabularyPool.ts`、`server/src/serverProcess.ts`、`server/src/modelTransferToken.ts`、`server/src/review.ts`、`server/src/cli.ts`（`latestSession`・`export`・`restore`・`review`・`publish`・`vocab`）、`helper/Sources/HelperCore/Recording.swift`、`helper/Sources/HelperCore/Mix.swift`、`helper/Sources/live-mindmap-helper/main.swift`、`server/bench/sessionStats.ts`、`GLOSSARY.md`（開始前の確かめ・Drive への保管）
- 対案: `research/drive-rclone` ブランチの `docs/investigations/2026-10-17-drive-rclone.md`（#1269）
