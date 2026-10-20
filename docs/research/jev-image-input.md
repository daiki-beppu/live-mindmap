# Jev の画像入力（公式ドキュメントでの確認）

#1376（地図 #1371）の調べ。2026-10-20 に TypeSafe の公式ドキュメント（docs.typesafe.ai の Markdown 版・OpenAPI）と SDK の変更履歴を読み、合成画像で API を数回呼んで確かめた。

凡例: **[公式]** = 一次情報で確認、**[実測]** = 自分の呼び出しで確認、**[報道のみ]** = 報道にだけある、**[見つからず]** = 一次情報に記述なし。

## 結論

- `jev-latest`（今は `jev-1.13.0`）のまま画像を足せる。モデル名もエンドポイント（`POST /v1/systemone`）も変わらない。要るのは `TypeSafe-Danger-Zone-Images: true` ヘッダーと、リクエストの `assets`。うちの鍵で、申し込みなしに通った。[公式][実測]
- **地図の前提との違い**: 画像は Jev 1.14 だけの機能ではない。Jev 1.13 と 1.14 の両方が受け付ける。1.14 は `jev-latest` ではなく `jev-preview`（または `jev-1.14.0`）で呼ぶ。1.14 にしか無いのは Box の問い。[公式][実測]
- 1280×720 の JPEG は 1 枚およそ 2,430 トークン。#768 と同じ形の判定（2 枚と noul 1 問）は 1 回約 5,170 トークン、約 $0.00022。10/09 の会議の画面（1146×720）では 1 回約 4,680 トークンで、変化 1 回ごとに判定すると **約 $0.23／時**（1280×720 なら $0.26／時）。#768 の Clef（判定 $2.5／時）の約 1/10。[実測＋公式の料金]
- 遅れ: 公称値は無い。手元から 2 枚の判定を呼ぶと 195〜281 ms（n=12）だった。#768 の Clef（p50 1.25 秒）よりかなり速い。[実測、標本は少ない]

## 1. 有効にする方法・実験的な機能の扱い

- 画像と Box は既定でオフ。画像か Box を含むリクエストごとに `TypeSafe-Danger-Zone-Images: true` を送る。[公式] [Images › Turning on images](https://docs.typesafe.ai/images#turning-on-images)、OpenAPI のヘッダーの説明「Set to true to use assets or box questions.」([API › System One](https://docs.typesafe.ai/api/system-one))
- ヘッダーが無いときの応答は `400`、`{"error_type":"api_usage_error","message":"Images are experimental. Send the header TypeSafe-Danger-Zone-Images: true to use them."}`。[実測]
- 位置付けは「Dreamer-ready」。本番に出せる水準ではなく、試作向けとしている。原文は「The request format, the answers, and the limits on this page can change between releases, and accuracy will change as we update the models.」[公式] [Images](https://docs.typesafe.ai/images)
- 廃止や変更を前もって知らせる方針は**書かれていない** [見つからず]。別名（alias）は新しい版が出ると切り替わり、答えが変わることがある。閾値を合わせたなら版の ID（`jev-1.13.0` など）を固定せよ、とある。[公式] [Models › Aliases](https://docs.typesafe.ai/models#aliases)
- 公開日: JS SDK v0.7.0 と Python SDK v0.7.5 が 2026-10-14 に画像に対応した。Jev 1.14 も 2026-10-14 から使える。[公式] [JS changelog](https://docs.typesafe.ai/sdk/javascript/changelog)・[Python changelog](https://docs.typesafe.ai/sdk/python/changelog)・[Models](https://docs.typesafe.ai/models)。SDK とは別の API の変更履歴は見つからなかった。

## 2. 形式・大きさ・枚数・渡し方

[公式] [Images › Limits](https://docs.typesafe.ai/images#limits)・[Asset fields](https://docs.typesafe.ai/images#asset-fields)

| 項目 | 公式の値 | 報道との比較 |
| - | - | - |
| 形式 | PNG・JPEG の静止画（`format`: `png`・`jpg`・`jpeg`）。APNG は拒否する。ベースラインの JPEG を推す | 一致 |
| 1 ファイル | 16 MiB（base64 は復号した後の大きさ） | 一致 |
| リクエスト全体 | 本体 32 MiB。処理後の全画像 32 MiB。参照を展開した後も 32 MiB | 一致 |
| 縦横 | **各辺 280〜1568 px**、総画素 78,400〜2,458,624。範囲外は**縮小せず拒否**し、1 枚でも外れたらリクエスト全体が失敗する | 報道（SmartScope 等）は「256〜1568」。**280 が正しい** |
| 枚数 | 上限の数は無い。大きさの上限とコンテキスト長（既定 64k／リクエスト・32k／問い）で決まる | 報道に記述なし |
| 渡し方 | `assets` の対応表（キーが参照の文字列）。各 asset は `data_base64`（JSON に base64）か `part`（multipart の部の名前）のどちらか。**URL では渡せない**。公式は multipart を推す（base64 は約 1/3 大きくなる） | 一致 |
| 参照の書き方 | 参照の文字列を `state`・`instructions`・`criteria` のどこにでも書くと、その場所に画像が入る。値の全体でも文中でもよい。画像ごとに UUID を使うよう勧める。参照されない asset があると `400`。参照は 1 つ 1,024 バイト・合計 65,536 バイトまで | 「プレースホルダー」と一致 |

- 画像の判定に勧める形として「What changed: 直前のフレームか短いフレームの履歴を `state` に入れて、動き・出現・違いを聞く」が挙がっている。#768 の形そのもの。[公式] [Images › Patterns](https://docs.typesafe.ai/images#patterns)
- API はメタデータ（EXIF など）を消す。EXIF の向きは反映しない。[公式]

## 3. 画像 1 枚のトークン数

- 公式は「画像は入力トークンとして数え、テキストと同じ単価。画像の別料金は無い。`usage.input_tokens` に含む。トークン数の見積もり方は近く示す」とだけ書いている。**解像度とトークン数の関係は公開されていない**。[公式] [Images › Image tokens](https://docs.typesafe.ai/images#image-tokens)
- 参照するたびに数える: 「Each use adds the image again」。同じ画像を `instructions` に何度も書くと、その回数だけ数えて上限にも効く。共通の画像は `state` に 1 回置き、パスで指すよう勧めている。[公式] [Images › References](https://docs.typesafe.ai/images#references)
- 縮小はしない。範囲外は拒否する（上の表）。[公式]

**実測**（合成のスライド画像。JPEG の品質 80。noul 1 問。`usage.input_tokens`。1.13 と 1.14 の差は ±3 トークン）:

| 入力 | input_tokens |
| - | - |
| テキストだけ（同じ問い、画像の代わりに短い文字） | 323 |
| 1280×720 を 1 枚 | 2,737 |
| 1280×720 を 2 枚（別の画像） | 5,172〜5,174 |
| 1280×720 を 2 枚（同じ画像） | 5,171〜5,172 |
| 640×360 を 2 枚 | 1,580〜1,583 |
| 1568×882 を 1 枚 | 3,929〜3,930 |

- 画像のトークン数は画素数にほぼ比例する。およそ **380 画素で 1 トークン**（1280×720 で約 2,420、640×360 で約 630、1568×882 で約 3,610）。中身（文字の量）による差はほぼ無い。
- 公式の Box の例にある `usage`（290・285 トークン）は、実測と桁が合わない。OpenAPI の例の画像は 16×16 で、最小の 280 px を下回る。例として示しただけの数字とみなした。

## 4. 料金

- `jev-1.14.0`・`jev-1.13.0` とも入力 $42／10 億トークン（$0.042／100 万）。出力は無料。[公式] [Models](https://docs.typesafe.ai/models)。トップページも「$42 Per Billion input tokens」。[公式] [typesafe.ai](https://typesafe.ai)
- 画像に別料金は無い（上の 3）。[公式]
- 独立した料金表のページ（`/pricing`）は 404。料金は Models の表とトップページにある。
- 長いコンテキスト（`TypeSafe-Danger-Zone-Long-Context`）も同じ単価。[公式]

## 5. 遅れ・時間切れ・レート制限

- 画像があるときの遅れの公称値は**無い** [見つからず]。トップページにあるのはテキストのワークフローの例（0.114 秒）だけ。
- 手元から 1280×720 を 2 枚送る判定を呼ぶと、`jev-1.13.0` で 206〜246 ms、`jev-1.14.0` で 195〜281 ms（全部で n=12、base64 の JSON で 1 枚 約 41 KB）。テキストだけでは 167 ms。会議中の負荷・実画面の大きさ（約 160 KB）・p90 は #1379 で測る。[実測]
- サーバー側の時間切れの値は書かれていない [見つからず]。うちは `judge.timeoutMs` で切っている。
- レート制限は組織ごと（トークン／秒とリクエスト／秒）。値は開発者コンソールにある。**画像に別のレート制限は無い**。超えると `429`、混雑時は `529`。[公式] [Models › Rate limits](https://docs.typesafe.ai/models#rate-limits)・[Images › Limits](https://docs.typesafe.ai/images#limits)・[Errors](https://docs.typesafe.ai/api/errors)

## 6. 性能（テキストだけより落ちるか）・日本語

- 「テキストだけより性能が落ちる」という文は、公式の文書には**見つからなかった**。[報道のみ]（remio・explainx 等。報道の要約には「warn that performance drops compared with text-only input」とある）。公式にあるのは「本番の水準ではない」「モデルの更新で精度は変わる」まで。[公式] [Images](https://docs.typesafe.ai/images)
- 画像に関する精度の数字は、Box の辺の確認（36 枚中 30 件）だけ。変化の判定の精度の数字は無い。[公式] [Box](https://docs.typesafe.ai/primitives/box)
- 日本語の文字を含む**画像**についての記述は無い [見つからず]。テキストについては「主な学習言語は英語。CJK も扱えるが、英語ほどではない。自分の内容で試せ」とある。[公式] [Models › Language support](https://docs.typesafe.ai/models#language-support)
- 文書の食い違い: Models の表の「Input」は 1.13・1.14 とも `Text` のまま。本文の Input の説明も「音声・動画は受け付けない」までで、画像に触れていない。Images のページと API は両方の版で画像を受け付ける（実測でも通った）。表の更新漏れとみた。
- 参考（精度ではない）: 合成のスライドで「別のスライドか」と聞くと、別の画像は 0.97〜0.98、同じ画像は 0.01〜0.03 だった。動作を確かめただけ。

## 7. 今の `server/src/systemOne.ts` のまま画像を足せるか

今の呼び方: `POST https://api.typesafe.ai/v1/systemone`、本文は `{ model: "jev-latest", state, questions }`、ヘッダーは `authorization` だけ（`judge.url`・`judge.model` で差し替えられる）。

- **モデル名**: そのままでよい。`jev-latest` → `jev-1.13.0` で画像が通る。1.14 で試すなら `judge.model` に `jev-preview` か `jev-1.14.0` を渡す。版を固定するなら、別名ではなく版の ID を渡す。[公式][実測]
- **エンドポイント**: 同じ。[公式]
- **足りないもの**:
  1. `TypeSafe-Danger-Zone-Images: true` ヘッダー（画像を含む呼び出しのときだけ）
  2. 本文の `assets`（`{ [uuid]: { type: "image", format: "jpg", data_base64 } }`）と、`state` に書く参照（例: `{ previous: uuid1, new: uuid2 }`）。今の `JudgeAsk` の型 `(state: string, questions)` は state が文字列なので、型を広げるか、画像の判定用の口を別に作る
  3. 応答の形は同じ（`answers.<名前>.noul`・`usage`）。今の Schema の検証はそのまま使える（応答には `type: "noul"` が付くが、Struct は余分なキーを通す）
- **Workers AI（`accountId` があるとき）の経路**は、画像に対応するか未確認。TypeSafe の公式は自社 API だけを説明している。[見つからず]
- **ヘルパーの JPEG との相性**: ヘルパーは 1280×720 に収める（`helper/Sources/HelperCore/ScreenChange.swift` の `screenMaxWidth`／`screenMaxHeight`、品質 0.8）。小さい画像は拡大しない。**どちらかの辺が 280 px 未満の窓**（細長い窓・小さい窓）は Jev が `400` で拒否するので、送る前に拡大するか余白を足す。10/09 のセッションの画面は 1146×720（1,254 枚）と 553×720（5 枚）で、範囲に収まる。

## 8. #768 の判定 1 回と 1 時間あたりの費用

前提:

- 判定 1 回 = 画像 2 枚（直前に添えた画面と新しい画面）を `state` に置き、noul 1 問を聞く。問いの文は英語で 1 文（#768 の Clef 版より短い。問いが長くなると、テキスト分の約 300 トークンが少し増える）
- 単価 $42／10 億入力トークン、出力は無料
- 判定の回数は 10/09 の実会議の変化の割合（480 秒で 159 回 → **1,192.5 回／時**）。変化のたびに判定する、と置く

| 画面の大きさ | 1 回のトークン | 1 回の費用 | 1 時間（1,192.5 回） |
| - | - | - | - |
| 1146×720（10/09 の実画面。画素数から推定） | 約 4,680 | 約 $0.000197 | **約 $0.23** |
| 1280×720（ヘルパーの上限。実測） | 約 5,173 | 約 $0.000217 | **約 $0.26** |
| 640×360（縮小して送る場合。実測） | 約 1,582 | 約 $0.000066 | 約 $0.08 |

- 比べる相手: #768 の Clef の判定は $2.5／時。Jev は約 1/10。
- ただし、判定の費用（約 $0.23〜0.26／時）は、地図の採る条件 1 にある「節約が $0.3／時未満なら見送る」の目安と同じくらいの額になる。判定で減らせる「添える画像の費用」がこれを十分に上回るかは #1379 で測る。
- 判定を減らす手:
  - 規則 B で、添える候補になった画面（10 秒に高々 1 回）だけを判定すれば、多くて 360 回／時、$0.08／時以下
  - 画像を縮小して送れば、トークンは画素数に比例して減る。ただし判定の精度との兼ね合いがあり、最小は 280 px
  - 直前の画面と新しい画面を 1 回のリクエストで送るので、前の画像を使い回してもトークンは減らない（キャッシュの仕組みは記述なし [見つからず]）

## #1378・#1379 への影響

- #1378（画像つきで Jev を呼ぶ）: モデル名を変える必要は無い（`jev-latest` のままでよい）。ヘッダーと `assets` を足し、280 px 未満の画面を拡大する。1.13 と 1.14（`jev-preview`）の両方を比べられる。版は ID で固定するのが安全
- #1379（計測）: 判定の費用そのものが、採否の目安（$0.3／時）と同じくらいになる。全部の変化を判定するか、規則 B の候補だけを判定するかで、節約の見え方が大きく変わる。遅れは公称値が無いので、p90 を実測する

## 出典

- 公式: [Images](https://docs.typesafe.ai/images)、[Models](https://docs.typesafe.ai/models)、[Box](https://docs.typesafe.ai/primitives/box)、[API › System One](https://docs.typesafe.ai/api/system-one)（OpenAPI: `https://api.typesafe.ai/openapi.json`）、[Request rules and errors](https://docs.typesafe.ai/api/errors)、[Jev 1.13 jaggedness](https://docs.typesafe.ai/model-jaggedness/jev-1.13)、[JS SDK changelog](https://docs.typesafe.ai/sdk/javascript/changelog)、[Python SDK changelog](https://docs.typesafe.ai/sdk/python/changelog)、[typesafe.ai](https://typesafe.ai)、文書の索引 `https://docs.typesafe.ai/llms.txt`
- 報道（二次）: [AlphaSignal](https://alphasignal.ai/news/typesafe-ai-s-jev-1-14-brings-vision-and-256k-context-to-typed-decisions)、[remio](https://www.remio.ai/post/jev-1-14-0-release-expands-what-jev-can-see-but-typesafe-wont-call-it-production)、[SmartScope](https://smartscope.blog/en/blog/jev-image-input-guide-asset-handling-choice-box-2026/)、[explainx](https://explainx.ai/blog/jev-1-14-danger-zone-multimodal-box-long-context-claimed-vs-verified-2026)
- 実測: 2026-10-20、Python の標準ライブラリで `POST /v1/systemone` と `GET /v1/models` を呼んだ（合成画像だけを使い、会議の画面は送っていない）。`GET /v1/models` が返したのは `jev-latest` と `jev-preview` の 2 つ
