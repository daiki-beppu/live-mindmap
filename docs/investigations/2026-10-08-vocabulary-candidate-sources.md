# 共有画面と過去のセッションから語彙の候補を取り出す手段（Issue #391）

親: #386（Kanary を手本に字幕の精度を上げる）。利用者に入力を求めずに**語彙**（GLOSSARY.md）を集めるとき、共有画面の文字と過去のセッションから、人名・製品名・略語などの候補をどう取り出せるか。事実を集めた。2026-10-08、macOS 27.0.1、Kanary 3.6.0。

## 結論

- **NaturalLanguage の固有表現（`NLTagger` の `.nameType`）は日本語では使えない。** この Mac で `NLTagger.availableTagSchemes(for: .word, language: .japanese)` は `Language`・`Script`・`TokenType` の 3 つだけで、`NameType` が無い（英語には `NameType`・`LexicalClass`・`Lemma` がある）。言語を日本語にして日本語の文を流すと、人名・地名・組織名は 0 件だった。言語を自動にすると英語の文の `Tim Cook`・`Microsoft`・`Cupertino` は取れたが、日本語の文に混ざった `Salesforce`・`OJT` は取れない。Apple のドキュメントには対応言語の記載が無い（下の出典）ので、この結果は実機での確認による
- **候補は単純な規則で取る。** Kanary の `GlossaryCandidateExtractor` も、日本語は規則で取っている（カタカナ 3 字以上・漢字 3〜12 字・英字の語、ストップ語 32 個を除く。下に詳細）。ただし、この規則は一般語の混入が多い。合成会議の共有画面の OCR では、候補 30 件のうち固有名詞らしいものが約 9 件（3 割）。会議の発言からでは、上位はほぼ一般語（チーム・問題意識・具体的…）
- **共有画面が、正しい表記の出どころとしては一番有望。** 文字起こしが崩す語（店名・人名）が、正しい表記のまま映っている。会議アプリの顔の枠に出る**参加者の名前**も OCR で読めた。ただし、今のリポジトリには OCR が無い（#183 で共有画面は画像のまま渡すと決め、ヘルパーに OCR を足さないことにした）。語彙のためには、#272 で取り込む会議ウィンドウのフレームに、別に OCR をかける必要がある
- **過去のセッションの発言は、正しい表記の出どころになりにくい。** 発言は STT の結果なので、STT が崩す語は崩れたまま残る。合成会議では、台本の人名が STT の文字起こしに 1 回も正しく出ないものが多い（parnassus のソウタ 35 回 → 0 回、ユズ 55 → 0、facilitators の大槻 11 → 0）。過去のセッションで使えるのは、ログに残る共有画面（#272 の `screens/`）を読み直すことと、STT が日によって正しく書く語の多数決くらい
- 量の目安: 規則で取る候補は、1 時間の会議の発言（約 2 万字）から 100〜500 語（2 回以上出るものは 30〜140 語）。共有画面のスライド 8 枚からは 30 語。実セッション 1 本（発言 66 件・約 1,700 字・ノード 8 個）からは、発言で 19 語・ノードで 6 語

## 1. 共有画面のローカル OCR

### 今の取り方

- リポジトリの `main` には、画面の取り込みも OCR も無い（`helper/Sources` に Vision・ScreenCaptureKit を使うコードは無い）
- 取り込みの仕様は #272（ready-for-agent）。ScreenCaptureKit で会議アプリのウィンドウを数 fps で取り、変化の判定器を通して、変わったときだけ 1280×720 に収まる JPEG を `screen` イベントで server に渡す。セッションのフォルダの `screens/` に、送ったバイト列をそのまま残す
- OCR は試作だけ。#181 の調査（ブランチ `research/shared-screen-to-ai` の `docs/investigations/2026-10-05-shared-screen-ocr.swift`）と #183 の試作（ブランチ `prototype/shared-screen-context` の `server/bench/sharedScreen/*.ocr.txt`）で、Vision の `RecognizeDocumentsRequest`（macOS 26 以降）を使った。日本語は `VNRecognizeTextRequest` の accurate だけが読み、fast は読まない。2 回目以降は 1 枚 0.1〜0.2 秒、最初の 1 回だけ 13〜16 秒
- #183 で「共有画面は画像のまま Claude に渡す。ヘルパーに OCR は足さない」と決めた。なので語彙に OCR を使うなら、それは語彙のためだけの新しい処理になる。入力は #272 の変化の判定器が「送る」と決めたフレーム（1 時間 30 枚程度）で足りる

### 規則で取れた語（合成会議 `synth/screen` のスライド 8 枚と顔だけの画面、OCR の文字 213 行・1,371 字）

規則は Kanary に合わせた（カタカナ 3 字以上・漢字 3〜12 字・大文字を含む英字の語、Kanary のストップ語を除く）。試しのコードは `2026-10-08-vocabulary-candidates.swift`。

- 取れた固有名詞（9 件）: 大河内（10 回）・北口店・大学前店・港南店・駅前店・中央病院・新町公園前・市役所通（「市役所通り」の「り」で切れた）・ベーカリー（「麦の穂ベーカリー」の一部）
- 取れなかった固有名詞: 三輪・葛西（漢字 2 字）、野々村（「々」が漢字の範囲 U+3400〜 に入らない）、川沿い店・麦の穂ベーカリー（ひらがなが挟まる）
- 一般語（21 件）: 前年比・客単価・廃棄率・新商品・製造量・候補地・店舗別・駐車場・四半期・営業企画・出店計画・月別売上・オンライン・オープン・アンケート・スケジュール・レビュー など。区切りの誤り: 今日決・店頭受・平日昼
- ノイズの見立て: 30 件中 21 件（7 割）が一般語か切れ端。表の見出しのような語が多い
- 文字起こしの側で崩れていた語と突き合わせると、港南店（台本 5 回 → STT 0 回）・廃棄率（2 → 0）は OCR に正しく映っていた。一般語でも、STT が崩すなら語彙に入れる意味がある

### 参加者の名前（顔の枠）

顔だけの画面と、各スライドの右側の顔の小窓から、OCR は「大河内」「三輪」「葛西」「野々村」を 1 行ずつ読んだ（頭文字のアイコンの「大」「三」なども 1 字の行として出る）。**同じ短い行（2〜4 字の漢字・かな）が多くの画面に繰り返し出る**ことを手がかりにすれば、2 字の名前も規則で拾える見込み。STT は三輪を 13 回中 7 回、葛西を 4 回中 1 回しか正しく書いていない。実機の Zoom・Meet・Teams での名前の出方は確かめていない。

## 2. NLTagger の固有表現

- `NLTagger.availableTagSchemes(for:language:)` は「その端末で、その単位と言語に使えるタグの種類」を返す（Apple のドキュメント）。この Mac では日本語の単語に `NameType` が無かった
- 手で書いた 6 文（日本語 5・英語 1）で試した結果:
  - 言語を日本語に指定: 0 件（田中・鈴木・東京・山田太郎・大阪・トヨタ自動車・佐藤 を含む）
  - 言語を自動: 英語の文の `Tim Cook`・`Satya Nadella`（人名）、`Microsoft`（組織）、`Cupertino`（地名）の 4 件だけ。`Apple Park` は取れず。日本語の文に混ざった英字の語（`Salesforce`・`ChatGPT`・`OJT`）は 0 件
- Kanary も `NLTagger(tagSchemes: [.nameType])` で `personalName`・`placeName`・`organizationName` を取っている（下）。日本語では何も返さないので、Kanary の日本語の候補は実質的に規則から出ている

## 3. 過去のセッション

### ログに残るもの

セッションのフォルダ（`~/.live-mindmap/sessions/<時刻>/`）に、`log.jsonl`（`remark`: `track`・`start`・`end`・`text`・`duplicate`、`diff`: ノードを足す・直す op）と `map.json`（ノードの `text`・`kind`・根拠の発言 `evidence`）がある。候補はこの 2 つの `text` から取れる。#272 が入れば `screens/` の画像も残る。

### 量（数だけ）

- この Mac のセッションは 1 本（2026-10-07）。発言 66 件（自分 59・相手 7、重複の印 7）、約 1,700 字、71 分。ノード 8 個・177 字
- 規則の候補: 発言から 19 語（漢字 10・カタカナ 9、2 回以上は 8）。ノードから 6 語（カタカナ 4・漢字 1・英字 1）。ノードの 6 語のうち 3 語は発言の文字に同じ表記で出てこない（Claude が書き換えた表記）
- 合成会議（台本 = 正しい表記）での規則の候補:

| 素材 | 長さ | 台本の字数 | 候補 | 2 回以上 | 漢数字を含む | STT の文字起こしからの候補 |
|---|---|---|---|---|---|---|
| facilitators | 55 分 | 21,000 | 108 | 32 | 29 | 137 |
| silly | 75 分 | 25,600 | 284 | 82 | 56 | 313 |
| parnassus | 161 分 | 52,400 | 498 | 138 | 223 | 546 |
| screen | 23 分 | 8,000 | 106 | 40 | 43 | 94 |

### 発言から取れる語と、ノイズ

- 上位は一般語: チーム(11)・問題意識(10)・具体的(9)・参加者(8)（facilitators）、リモコン(17)・ドローン(16)・冷蔵庫(16)（silly）。回数で並べても固有名詞は上に来ない
- 漢数字の連なり（九日間・二十分・百五十部）が候補の 3〜4 割。STT は数字を算用数字で書くので、表記の違いであって誤認識ではない。漢数字を含む語は外すのがよい
- **台本の固有名詞が STT にどう出るか**（台本の回数 / STT の文字起こしに同じ表記で出た回数）: 大槻 11/0・千田 11/8・森川 10/10（facilitators）、ソウタ 35/0・ユズ 55/0・ナギ 30/0・ミオ 37/3・トキワ 10/0（parnassus）、港南店 5/0・三輪 13/7・葛西 4/1（screen）。崩れる語は、過去の発言からは正しい表記で取れない
- STT が崩した語のうち規則で取れるもの: ソウタ・トキワ・タヌキ・集魚灯（parnassus）、鑑定機・前線観測器・ヒロシ（silly）、港南店・廃棄率（screen）。2 字の名前（ユズ・ナギ・大槻・三輪）は取れない
- 合成会議には英字の語・略語がほとんど無い（screen の `SNS` だけ）。略語の拾い方は手書きの文でしか確かめていない（`OJT`・`KPI`・`SaaS`・`ChatGPT`・`Salesforce` は取れ、`kintone` のような小文字だけの語は「大文字を含む」の条件で落ちる）

### 過去のセッションから取る方法の見立て

- 発言: STT が正しく書けた語しか出てこない。役に立つのは、日によって正しく書いたり崩したりする語（三輪 13 回中 7 回）を、正しく書けた回の表記で語彙に入れること
- ノード: Claude が文脈から表記を直すことがある（実セッションで 6 語中 3 語が発言と違う表記）。正しく直したのか、言い換えただけなのかは区別できない
- 共有画面の `screens/`: 正しい表記の出どころ。過去のセッションの画面を後から OCR すれば、同じ会議の続きで使える語彙になる
- 範囲（同じ会議の続きだけか、全部か）は #386 の未決事項

## 4. Kanary の `GlossaryCandidateExtractor`

`/Applications/Kanary.app/Contents/Frameworks/KanaryGlossary.framework`（3.6.0）を `nm`・`otool -L`・`dyld_info -disassemble`・`dyld_info -fixups` で読んだ。読むだけで、非公開 API は使っていない。

### 形

- `static GlossaryCandidateExtractor.extract<A: GlossaryCandidateTranscriptSegment>(from: [A], existingEntries: [GlossaryEntry], limit: Int) -> [GlossaryCandidateProposal]`
- 入力は文字起こしの区切り（`GlossaryTranscriptSegmentSnapshot`: `text`・`startSeconds`・`endSeconds`・`confidence`）。**出どころは文字起こしだけ**で、出どころの種類の文字列は `"transcript"` の 1 つしか無い。画面や OCR から取る経路は無い
- 出力 `GlossaryCandidateProposal`: `term`・`aliases`・`source`（`kind`・`segmentIndex`・`startSeconds`・`endSeconds`・`excerpt`）・`occurrences`・`score`
- 採った語は `GlossaryProvenance` の `autoSuggested` として語彙に入る作り（ほかに `handAuthored`・`userConfirmed`）
- 3.6.0 の中で、この関数を呼んでいる別のバイナリは無い（アプリ本体・他のフレームワーク・`Helpers/kanary` のどれにも記号の参照が無い）。用意はあるが、まだ使われていない可能性がある

### 候補の取り方（逆アセンブルから読んだもの）

区切りごとに次の 3 つを順に呼ぶ。

1. **NLTagger の固有表現**: `NLTagger(tagSchemes: [.nameType])` で `personalName`・`placeName`・`organizationName` を取る。日本語では何も返さない（上の 2.）
2. **カタカナと漢字の連なり**: 1 字ずつ見て、カタカナ（U+30A0〜30FF、半角 U+FF66〜FF9F）の連なりが **3 字以上**、漢字（U+3400〜A3FF、U+20000〜2F9FF）の連なりが **3〜12 字**なら候補。その範囲を外れる漢字の連なりも、「株式会社」「有限会社」で始まる・終わるものは残す
3. **英字の語**: 文字（`CharacterSet.letters`）と `._-/` からなる語を、前後の記号を落として取る。2 字以上で、大文字・小文字の判定（`isUppercase`・`isCased`）と数字の判定を通したものを残す（判定の細部までは読んでいない）

その後、小文字・NFC に正規化して重複をまとめ、既存の語彙にある語と、次の**ストップ語 32 個**を除く:

> 今日 昨日 明日 今回 次回 最初 最後 確認 相談 方針 説明 録音 文字 起こし 会議 時間 問題 場合 会社 内容 結果 the and for with this that from today please issue meeting

点（`score`）は、語の長さ（20 字で頭打ち、半分にする）に、出現ごとの重み（定数 4.0 と 2.8）を足していく形。重みの使い分けまでは読んでいない。上位 `limit` 件を返す。

### この規則の弱いところ（合成会議で見えたもの）

- 2 字の名前（三輪・大槻・ユズ）と「々」を含む名前（野々村）を取れない
- ひらがなが挟まる固有名詞（川沿い店・麦の穂ベーカリー）を取れない。漢字の連なりが前後の語とつながる（来週大阪・今日決）
- 漢数字の連なり・表の見出し・一般のカタカナ語（オンライン・スケジュール）が多く混ざる。ストップ語 32 個では足りない

## 手段ごとのまとめ

| 手段 | 取れる語の例 | ノイズ（一般語の混入） | 正しい表記か |
|---|---|---|---|
| 共有画面の OCR ＋規則 | 北口店・港南店・中央病院・新町公園前・大河内 | 多い（30 件中 21 件） | 正しい（映っている表記）。切れ端あり |
| 共有画面の顔の枠の名前 | 大河内・三輪・葛西・野々村 | 少ない見込み（繰り返す短い行に絞れば）。未確認 | 正しい（会議アプリの表示名） |
| NLTagger の固有表現 | 日本語は無し。英語の文の人名・組織名・地名 | 少ない | 正しい |
| 過去の発言＋規則 | ソウタ・トキワ・集魚灯（STT が正しく書けたとき） | 非常に多い（上位はほぼ一般語、3〜4 割が漢数字） | STT の表記のまま。崩れる語は取れない |
| 過去のノード＋規則 | （実セッションで 6 語） | 少なめ（数が少ない） | Claude の表記。正しいとは限らない |

ノイズを減らす手は、試していないが次が考えられる: 漢数字を含む語を外す、OCR の表の見出し（短い行が表の 1 行目に並ぶ）を外す、STT の文字起こしにそのまま出てくる語は外す（語彙で直す必要が無い）、2 字の名前は「繰り返す短い行」から取る。

## 出典

- Apple: [`NLTagScheme.nameType`](https://developer.apple.com/documentation/naturallanguage/nltagscheme/nametype)（「名前の一部かどうかで語を分ける」。対応言語の記載は無い）、[`NLTagger.availableTagSchemes(for:language:)`](https://developer.apple.com/documentation/naturallanguage/nltagger/availabletagschemes(for:language:))（「その端末で使えるタグの種類を返す」）、[Identifying People, Places, and Organizations](https://developer.apple.com/documentation/naturallanguage/identifying-people-places-and-organizations)（`omitPunctuation`・`omitWhitespace`・`joinNames` の使い方）
- Apple: [`RecognizeDocumentsRequest`](https://developer.apple.com/documentation/vision/recognizedocumentsrequest)（macOS 26.0 以降）
- 参考（今回は調べていない次の段）: Speech の [`AnalysisContext`](https://developer.apple.com/documentation/speech/analysiscontext) の `contextualStrings` は「システムの語彙に無くても認識してほしい語や句」を STT に渡す口。集めた語彙を補正の LLM だけでなく SpeechAnalyzer にも渡せるかは別に確かめる（ヘルパーは今は使っていない）
- リポジトリ: #181・#183 のコメント、#272 の本文、`server/bench/sessionStats.ts`（ログの形）
- 試しのコード: `docs/investigations/2026-10-08-vocabulary-candidates.swift`（`swiftc -O` でビルドし、`./extract schemes` / `tag <file>` / `tagauto <file>` / `rules <file>` / `both <file>`）。合成会議の台本（`timeline.tsv` の 4 列目）と STT（`meeting.transcript.json` の `segments[].text`）を 1 行 1 文にして流した。実セッションは件数だけを数え、本文は表示していない
