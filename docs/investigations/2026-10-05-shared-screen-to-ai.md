# 共有画面を AI に渡す方式の費用とキャッシュ：画像のままとローカル OCR（Issue #181）

共有画面を差分更新の AI（Sonnet 5.5。Agent SDK の開いた query を 14 回使い回す。ADR 0006）に渡すとき、画像のまま渡す方式と、ヘルパーで Apple Vision の OCR にかけて文字だけ渡す方式で、費用・キャッシュ・精度がどう違うかを、Anthropic と Apple の一次情報で調べた。OCR は手元の Mac（Apple M4、macOS 27.0）で、架空のスライド 1 枚を使って動かした。Claude の API は呼んでいない（費用は公開の単価と式からの計算）。結論は次のとおり。

- **画像は Agent SDK の開いた query にそのまま載せられる。** streaming input mode（今の `inputQueue` の作り）のユーザーメッセージに `image` ブロック（base64）を入れればよい。single message mode では載せられない。
- **画像 1 枚の入力トークンは ⌈幅/28⌉ × ⌈高さ/28⌉。** Sonnet 5.5 は高解像度の枠（長辺 2576 px・上限 4784 トークン）なので、1920×1080 をそのまま送ると 2,691 トークン、1280×720 に縮めると 1,196 トークン。Retina のウィンドウを縮めずに送ると上限の 4,784 近くまで行く。**縮めて送る前提にする。**
- **開いた query では、送った画像は query を開き直すまで履歴に残り、以後の呼び出しのたびにキャッシュから読まれる。** 末尾に足すだけならキャッシュは壊れない（前置きは一致したまま）。途中の古い画像を消すと、そこから後ろが書き直しになる。開き直すと画像は消えるので、まだ映っている画面は開き直しの最初の呼び出しで送り直す必要がある。
- **1 時間あたりの追加費用（中身が変わったときだけ送る。5 分 TTL）**: スライドが 30 回変わる会議で、画像 1920×1080 が約 $0.57、1280×720 が約 $0.25、OCR の文字が約 $0.04〜0.11。60 回なら、それぞれ約 $1.00・$0.44・$0.07〜0.19。今の約 $1.1/時間に対して、画像は 1〜9 割増し（大きさと回数しだい）、OCR は 0.5〜2 割増し。毎回の呼び出しに最新の 1 枚を添える方式は、変化の回数に関係なく 1280×720 で約 $0.60、1920×1080 で約 $1.35 かかる。
- **OCR は日本語に対応する。ただし accurate のときだけ。** `VNRecognizeTextRequest` の fast は 6 言語（英・仏・伊・独・西・葡）だけで、日本語のスライドからは何も返らなかった。accurate と `RecognizeDocumentsRequest`（macOS 26 以降。ヘルパーの対象は macOS 26 以降）は `ja-JP` に対応する。
- **架空のスライドでは、OCR の文字はほぼ正しく、表も行と列で取れた。** `RecognizeDocumentsRequest` は 640×360 まで縮めても本文と 4 行 × 3 列の表を正しく読んだ（崩れたのは小さいフッターだけ）。1 枚あたり、2 回目以降は 0.1〜0.2 秒。最初の 1 回は 13〜16 秒かかった（モデルの読み込み。セッションの開始時に空読みしておけば済む）。グラフの形・色・配置は文字には残らない。「右のグラフ」を当てるには、位置の手がかりを自分で文字に足す必要がある。

## 調べ方

- Anthropic の一次情報: Vision（画像の送り方・トークンの式・解像度の枠・枚数の上限）、Prompt caching（単価・何でキャッシュが壊れるか）、Agent SDK の Streaming Input と Track cost and usage、Claude Code の How Claude Code uses prompt caching（画像がたまったときの扱い・TTL）。URL は末尾。
- Apple の一次情報: Vision の `VNRecognizeTextRequest` / `RecognizeTextRequest` / `RecognizeDocumentsRequest` / `DocumentObservation` のリファレンス。対応言語の一覧はリファレンスに載っていないので、手元の Mac で `supportedRecognitionLanguages` を呼んで確かめた。
- OCR の試し: AppKit で 1920×1080 の架空のスライド（タイトル・箇条書き 4 行・4 行 × 3 列の表・フッター。ヒラギノ角ゴ）を描き、1920×1080 / 1280×720 / 960×540 / 640×360 に縮めて、各 4 回ずつ読ませた。スクリプトは同じディレクトリの `2026-10-05-shared-screen-ocr.swift`（`swiftc -O` でビルドして実行）。会議アプリのウィンドウから取った本物の共有画面（動画の圧縮・縮小・カーソル）では試していない。
- 費用の前提は、このリポジトリの計測から取った: 161 分の会議で差分更新は 255 回（約 95 回/時間）、query は 14 回ごとに開き直す（約 6.8 回/時間）、構造化出力のため 1 回の呼び出しで API への要求が 2 回になる（`docs/knowledge/2026-09-30.md`）、日本語は 1 文字あたり約 0.87 トークン（`docs/knowledge/2026-10-04.md`）、キャッシュは 5 分 TTL で書く（ADR 0006・#130 の決定。実装は #170）。

## 今の呼び出しの作り（前提）

- `server/src/claude.ts` は、Agent SDK の `query` に `AsyncIterable<SDKUserMessage>` を渡す streaming input mode で、開いた query を `QUERY_RENEW_CALLS` = 14 回使い回す。ユーザーメッセージの `content` は今は文字列だけ。
- `main` の `buildPrompt` は、まだ毎回マップ全体のアウトラインを送っている。「2 回目からは変更だけ送る」「5 分 TTL」は ADR 0006 で決まり、実装は #170（未着手）。下の見積もりは、#170 が入った後の作り（約 $0.7〜0.8/時間、#130 の実測）にも、issue に書かれた約 $1.1/時間にも足せる「追加分」として出した。
- `SYSTEM` の「会話の扱い」は「毎回のメッセージは独立した依頼。前のメッセージのマップは古い」。共有画面を履歴に積むなら、「今の共有画面は、最後に送ったもの」と書き足す必要がある（ADR 0006 の書き換えと一緒に）。

## 画像のまま渡す

### Agent SDK の開いた query に載せられるか

載せられる。Agent SDK のドキュメントは、streaming input mode の利点に「Image uploads: attach images directly to messages」を挙げ、`SDKUserMessage` の `message.content` に `{ type: "image", source: { type: "base64", media_type: "image/png", data } }` を入れる TypeScript の例を載せている。single message mode は「Direct image attachments in messages」に対応しない。今の作りは streaming input mode なので、`inputQueue().push` に渡す `content` を文字列から `[text, image]` の配列に変えるだけで載る。

注意点（同じページ）: `source` が無い・オブジェクトでない画像ブロックは、エラーにならず「[Image could not be processed: …]」という文字に置き換わって続く。画像を組み立てる側でエラーを見逃さないようにする。

Vision のドキュメントは「画像を文字より前に置くと結果が良い」としている。差分更新のメッセージでは、画像 →「## 共有画面（いま映っているもの）」の見出し → これまでのプロンプト、の順にするのがよい。

### 1 枚あたりの入力トークンと、縮めてよい大きさ

Vision のドキュメントの式は「`⌈width / 28⌉ × ⌈height / 28⌉` visual tokens」。モデルごとに長辺とトークン数の上限があり、超えると縦横比を保って縮められる。

| 枠 | モデル | 長辺の上限 | トークンの上限 |
|---|---|---|---|
| High-resolution | Claude 4.7 以降（Sonnet 5.5 を含む） | 2576 px | 4784 |
| Standard | それ以外 | 1568 px | 1568 |

Sonnet 5.5 で送る大きさごとのトークン数（式から計算。1920×1080 の 2,691 はドキュメントの表と一致）:

| 送る大きさ | トークン | 1 枚を 1 回入力する費用（$2/MTok） |
|---|---|---|
| 1920×1080 | 2,691 | $0.0054 |
| 1456×819 | 1,560 | $0.0031 |
| 1280×720 | 1,196 | $0.0024 |
| 960×540 | 700 | $0.0014 |
| 2880×1800（Retina のウィンドウを縮めない） | 上限の 4,784 前後まで縮められる | 約 $0.0096 |

どこまで縮めてよいかは、ドキュメントに数字は無い。書いてあるのは「大事な文字は読める大きさにする」「200 px 未満の小さい画像は誤りやすい」「高解像度は標準の枠より最大約 3 倍のトークンを使う。高い精度が要らなければ送る前に縮める」「縮めてから送ると遅れも減る」まで。スライドの本文を読ませるなら 1280×720 前後が目安になるが、会議アプリのウィンドウの中では共有画面がさらに小さく映るので、実際の取り込みで確かめる（試作の問い）。ほかの上限: 1 枚 8000×8000 px・base64 で 10 MB、1 回の要求で 600 枚（Sonnet 5.5 は 1M コンテキスト）。**1 回の要求に 20 枚を超える画像があると、1 枚ごとの大きさの上限が厳しくなる**（2000 px 以下にすれば全プラットフォームで通る）。開いた query は最大 14 回なので、1 回に 1 枚までなら 20 枚には届かない。

### 開いた query で画像が積み上がるとき、キャッシュと費用はどうなるか

- Agent SDK（Claude Code）は、毎回の要求で履歴全体を送り直し、前回の要求を前置きとしてキャッシュから読む。新しい分だけを書き込む（Claude Code の prompt caching のページ）。画像もキャッシュできる（Prompt caching の「Images & Documents: Content blocks in the `messages.content` array, in user turns」）。
- Prompt caching の「キャッシュが壊れるもの」の表は、画像について「Adding/removing images anywhere in the prompt affects message blocks」（messages のキャッシュが ✘）と書く。前置きの一致で判定するので、**末尾のユーザーメッセージに画像を足すのは、新しい分の書き込みになるだけで、それより前のキャッシュは読める**。逆に、**途中の古い画像を消すと、消した位置から後ろがすべて書き直しになる**。「古いスライドを消して節約する」は、開いた query の中では逆効果になる。
- Claude Code は、画像と PDF が 1 回の要求の上限（枚数、または Claude Code 自身が持つ合計の大きさの上限）を超えそうになると、古いものからまとめて外して送る。外れた画像は AI から見えなくなり、外した位置から後ろが書き直しになる。14 回で開き直す今の作りで、1 回に 1 枚までなら、この上限には届かない見込み（合計の大きさの上限の値はドキュメントに無い）。
- query を開き直すと、履歴ごと画像も消える。まだ映っている画面は、開き直しの最初の呼び出しで送り直す。ADR 0006 の「開き直すときは必ず全体を送る」と同じ扱いになる。
- 5 分 TTL のキャッシュは、読まれるたびに無料で延びる。差分更新は数秒〜十数秒おきなので切れない。5 分を超える無音の後だけ、画像を含む前置き全体が書き直しになる。
- base64 の画像は、要求のたびに全バイトが送られる（Vision の Tip）。1280×720 の PNG が 1 枚 100〜200 KB 程度とすると、14 枚でも 1 回の要求は数 MB で、上限の 32 MB には遠い。Files API の `file_id` なら送るバイトは減るが、Agent SDK から使えるかは調べていない。

### 単価（Sonnet 5.5）

Prompt caching のページの表: 入力 $2 / MTok、5 分 TTL の書き込み $2.50（1.25 倍）、1 時間 TTL の書き込み $4（2 倍）、キャッシュの読み込み $0.20（0.1 倍）、出力 $10。API キーで使う Agent SDK の既定の TTL は 5 分（Claude Code のページの表。サブスクリプションの枠内だけ 1 時間）。#127 の計測で 1 時間 TTL の書き込みが出たのは、サブスクリプションの認証で流したためと読める（確かめてはいない）。

## ローカル OCR（Apple Vision）

### 日本語の対応

- `VNRecognizeTextRequest`（macOS 10.15 以降）の対応言語は、認識の段階で違う。手元の Mac（macOS 27.0、revision 3）で `supportedRecognitionLanguages()` を呼んだ結果:
  - fast: `en-US, fr-FR, it-IT, de-DE, es-ES, pt-BR` の 6 つ。**日本語は無い。** 実際に日本語のスライドを fast で読むと、何も返らなかった。
  - accurate: 上の 6 つに加えて `zh-Hans, zh-Hant, yue-Hans, yue-Hant, ko-KR, ja-JP, ru-RU, …` の計 33。
- `RecognizeTextRequest`（Swift の新しい API、macOS 15 以降）と `RecognizeDocumentsRequest`（macOS 26 以降）も、同じ 33 言語（`ja-Jpan-JP` を含む）を返した。
- Apple のリファレンスの説明: accurate は「時間をかけて、より網羅的な結果を出す」、fast は「精度と引き換えに速く返す」。

### 精度と速さ（架空のスライド 1 枚）

| 方式 | 大きさ | 2 回目以降の時間 | 読めたもの |
|---|---|---|---|
| `VNRecognizeTextRequest` accurate | 1920×1080 | 0.13 秒 | 本文・数字はすべて正しい。表の「関東」の 1 セルが抜けた。フッターの全角空白が「一」になった |
| 同 | 1280×720 / 960×540 / 640×360 | 0.09〜0.12 秒 | 本文・表のセル・フッターとも正しい |
| 同 fast | 全サイズ | 0.005〜0.009 秒 | 何も返らない（日本語に非対応） |
| `RecognizeDocumentsRequest` | 1920×1080 / 1280×720 / 960×540 | 0.20〜0.21 秒 | 本文は正しい（960×540 で「128% に」の「に」が 1 字抜けた）。**表を 4 行 × 3 列として、セルごとに正しく返した**。タイトルを `title` として返した |
| 同 | 640×360 | 0.17 秒 | 本文と表は正しい。24 px 相当の小さいフッターだけ崩れた（`#A CH 12/30Ś`） |

- 最初の 1 回は、どちらの方式も 13〜16 秒かかった（言語モデルの読み込みと見ている）。セッションを始めたときに 1 回空読みしておけば、会議中の 1 枚目が遅れない。
- `VNRecognizeTextRequest` は行ごとの文字列（と位置）を返すだけで、表は「左の列を上から下へ、次の列を…」の順で縦にばらばらに出た。`RecognizeDocumentsRequest` は `DocumentObservation` の中に、段落・リスト・表（`Table` の `rows` / `columns` と `cell(row:col:)`）・タイトル・バーコードを分けて返す。表をそのまま Markdown の表にして渡せる。
- 文字の位置（バウンディングボックス）はどちらも返る。「右の表」「上のグラフ」のような指し方に答えるには、位置を「右上」「左下」のような粗い言葉にして文字に添える必要がある（今回は試していない）。
- グラフの棒の高さ・線の形・色・矢印・写真のような、文字でないものは OCR では残らない。グラフなら軸の目盛りと凡例の文字だけが残る（今回のスライドにはグラフを入れていない。試してはいない）。

### OCR の文字のトークン数

今回のスライドは空白を除いて 151 文字。日本語 1 文字あたり約 0.87 トークン（このリポジトリの実測）とすると約 130 トークン、表を Markdown にして見出しを付けても 200 トークン前後。文字の多いスライドでも 500 トークン前後と見て、下の見積もりは 200 と 500 で出した（API の `count_tokens` では数えていない）。

## 1 時間あたりの費用の見積もり

### 置いた前提

- 差分更新は約 95 回/時間、query は 14 回ごとに開き直す（約 6.8 回/時間）。1 回の呼び出しで API への要求は 2 回（構造化出力の 2 ターン）。
- 共有画面は、中身が変わったときだけ、その次の呼び出しのメッセージに 1 枚（または OCR の文字）を足す。変わる回数は 30 回/時間と 60 回/時間。
- 足した 1 枚は、5 分 TTL で 1 回書き込まれ（$2.50/MTok）、同じ呼び出しの 2 回目の要求と、同じ query の残りの呼び出しで読まれる（$0.20/MTok）。足す位置が query の中で一様だとすると、平均 14 回読まれる。1 枚あたり「トークン数 × ($2.50 + $0.20 × 14) / 100 万」。
- 開き直しのたびに、いま映っている 1 枚を最初の呼び出しで送り直す（query の 14 回を通して 27 回読まれる）。会議の間ずっと共有されている場合で数えた。
- 出力のトークンは増えないものとした（画像を見て操作が増える・減る分は測っていない）。

### 結果（追加分、Sonnet 5.5 の定価）

| 渡し方 | 1 枚のトークン | 30 回/時間 | 60 回/時間 |
|---|---|---|---|
| 画像 1920×1080 | 2,691 | $0.57 | $1.00 |
| 画像 1456×819 | 1,560 | $0.33 | $0.58 |
| 画像 1280×720 | 1,196 | $0.25 | $0.44 |
| 画像 960×540 | 700 | $0.15 | $0.26 |
| OCR の文字（少なめ） | 200 | $0.04 | $0.07 |
| OCR の文字（多め） | 500 | $0.11 | $0.19 |

参考: **毎回の呼び出しに最新の 1 枚を添える**（変わっていなくても送る）と、query の中で画像が 1 枚ずつ積み上がり、1280×720 で $0.60/時間、1920×1080 で $1.35/時間。変化の回数によらずこの額になるので、「変わったときだけ送る」より高い。

内訳を見ると、画像 1 枚の費用の約半分は、query の残りの呼び出しで読み直される分（$0.20 × 14 回 = $2.80/MTok）で、書き込み（$2.50/MTok）とほぼ同じ大きさ。開き直しの回数を増やすと読み直しは減るが、そのたびにマップ全体と画面を送り直すので、ADR 0006 の効果と取り合う。

1 時間 TTL で書く場合（サブスクリプションの認証など）は、書き込みが $4/MTok になり、上の画像の額は約 1.3 倍になる。

### 今の費用との比べ

issue に書かれた今の作り（約 $1.1/時間）に足すと、30 回/時間で、画像 1280×720 が約 1.2 倍、1920×1080 が約 1.5 倍、OCR が約 1.04〜1.1 倍。#170 が入った後の作り（約 $0.7〜0.8/時間）に足すと、画像の割合はさらに大きくなる（1920×1080 で約 1.7〜1.8 倍）。

## 比べてわかったこと

| 観点 | 画像のまま | ローカル OCR |
|---|---|---|
| 費用（30 回/時間、追加分） | $0.15〜0.57（大きさしだい） | $0.04〜0.11 |
| 開いた query への載せ方 | `content` に `image` ブロック。変えるのは `claude.ts` だけ | `content` に文字を足すだけ。OCR はヘルパーで動かす |
| 履歴とキャッシュ | 開き直すまで残り、毎回読まれる。途中で消すと書き直し | 同じ。ただし 1 件が 1/6〜1/13 の大きさ |
| 表・数字 | 読める（精度はこの調査では測っていない） | `RecognizeDocumentsRequest` なら行と列で取れた |
| グラフ・図・配置 | 見える | 文字以外は消える。位置は自分で言葉にして足す必要がある |
| 遅れ | 入力が増えるぶん応答が遅くなりうる（測っていない） | 1 枚 0.1〜0.2 秒（最初の 1 回だけ 13〜16 秒） |
| ログ・再生 | 縮小画像を残す（1 枚 100 KB 前後） | 文字を残す（小さい。回帰評価で差分が読める） |

画面を指す発言のうち、「この数字」「この表の九州」のように文字で答えられるものは OCR で足りる見込みが高い。「右のグラフが下がっている」のように形や配置で答えるものは、画像でないと分からない。どちらが多いかで決まるので、#179 の評価の台本に両方を混ぜて、試作で比べる。費用だけで見れば、OCR を既定にし、画像は縮めて（1280×720 前後）変わったときだけ送る、または OCR の文字が少ない（図が主の）画面だけ画像で送る組み合わせが安い（後者は試作で確かめる案）。

## 調べていないこと・測っていないこと

- 会議アプリのウィンドウから取った本物の共有画面での OCR（動画の圧縮・縮小・カーソル・相手の顔のサムネイルが重なる場合）。今回は描いたスライド 1 枚だけで、各条件 4 回。
- グラフ・図・手書き・縦書き・低コントラストのスライドでの OCR。
- Claude が縮小画像から日本語のスライドの文字や数字をどこまで正しく読むか。画像を送ったときの応答時間の伸び。どちらも API を呼んでいない。
- OCR の文字のトークン数の実測（`count_tokens`）。画像のトークン数は式から計算した値。
- Agent SDK で Files API の `file_id` を画像の `source` に使えるか。Claude Code が持つ画像の合計の大きさの上限の値。
- `RecognizeDocumentsRequest` の `textRecognitionOptions` の言語の自動判定（`automaticallyDetectLanguage`）や `customWords`（会議で出る固有名詞を足す）の効き目。

## 出典

- Anthropic, Vision: https://platform.claude.com/docs/en/build-with-claude/vision （送り方・式 `⌈width / 28⌉ × ⌈height / 28⌉`・解像度の枠・枚数と大きさの上限・画像を文字より前に置く・base64 は毎回全バイトが送られる）
- Anthropic, Prompt caching: https://platform.claude.com/docs/en/build-with-claude/prompt-caching （単価の倍率と Sonnet 5.5 の表・画像はキャッシュできる・「Adding/removing images anywhere in the prompt affects message blocks」・読むたびに TTL が延びる・Sonnet 5.5 の最小 512 トークン）
- Claude Agent SDK, Streaming Input: https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode （streaming input mode で画像を載せる例・single message mode は非対応・`source` の無い画像は文字に置き換わる）
- Claude Agent SDK, Track cost and usage: https://code.claude.com/docs/en/agent-sdk/cost-tracking （API キーでは 5 分 TTL が既定・`total_cost_usd` は query の累計・SDK の費用は見積もり）
- Claude Code, How Claude Code uses prompt caching: https://code.claude.com/docs/en/prompt-caching （履歴を毎回送り直して前置きを読む・画像がたまると古いものからまとめて外す・TTL の決まり方と `FORCE_PROMPT_CACHING_5M`）
- Apple, VNRecognizeTextRequest: https://developer.apple.com/documentation/vision/vnrecognizetextrequest 、VNRequestTextRecognitionLevel.accurate / .fast: https://developer.apple.com/documentation/vision/vnrequesttextrecognitionlevel
- Apple, RecognizeTextRequest: https://developer.apple.com/documentation/vision/recognizetextrequest
- Apple, RecognizeDocumentsRequest（macOS 26.0 以降）: https://developer.apple.com/documentation/vision/recognizedocumentsrequest 、DocumentObservation: https://developer.apple.com/documentation/vision/documentobservation 、DocumentObservation.Container.Table: https://developer.apple.com/documentation/vision/documentobservation/container/table
- このリポジトリ: `server/src/claude.ts`、`docs/adr/0006-send-map-changes-within-a-query.md`、#130 の回答（161 分・255 回、$0.82 → $0.78 → $0.70）、`docs/knowledge/2026-09-30.md`（構造化出力は 2 ターン）、`docs/knowledge/2026-10-04.md`（日本語 1 文字約 0.87 トークン）、`helper/Package.swift`（macOS 26 以降）
