# FoundationModels で語彙の補正をする条件と使い方、Kanary の作り方（Issue #389）

端末内の FoundationModels（`LanguageModelSession`）で、確定した文字起こしの語を語彙の正しい表記に直せるかを、一次情報（Apple の開発者ドキュメント・技術ノート・サポート記事、SDK の `.swiftinterface`、手元での実行）と、Kanary.app のバイナリの記号・文字列（`strings` / `nm` / `otool` / `dyld_info` で読んだだけ。非公開 API は使っていない）で調べた。

## 結論

- **動く条件**: macOS 26.0 以上、M1 以降の Mac、Apple Intelligence が有効、モデルのダウンロード済み、端末の言語と Siri の言語が同じ対応言語。日本語は対応言語に入っている。どれかを満たさないと `SystemLanguageModel.default.availability` が `.unavailable(理由)` を返すので、補正を飛ばして素の確定文を使えばよい（落ちはしない）。→ 「使い方に前提を課さない」に照らすと、**補正は「あれば効く」追加の段に留め、無くても本体が成り立つ形にする**のが合う。
- **使い方**: 候補が実行時に決まるので `@Generable` より `DynamicGenerationSchema` の `anyOf` が向く。出現箇所ごとに「その出現の候補 + NONE」だけを選べる型にすると、提示していない語は構造上出せない。なお **Command Line Tools だけの環境では `@Generable` マクロのプラグインが無くてビルドできない**（このリポジトリの helper は CLT で組む前提）。動的スキーマなら CLT で組めた。
- **文脈の上限**: macOS 27 では 8192 トークン（手元の実測）、26.x では 4096（SDK の後方互換実装と TN3193）。日本語はおおむね 1 文字 1 トークン。語彙を全部渡すのではなく、**読み・表記で候補を絞ってから出現ごとに数語を渡す**のが前提になる（Kanary もそうしている）。
- **時間**: M4 / macOS 27.0.1 で 1 回 0.4〜0.7 秒（最初の 1 回だけ 1〜3.8 秒）。
- **精度（参考、4 例だけ）**: 小さな試しでは、文脈に合わない候補を選ぶ誤りが出た（「サーバー」→「Server Components」、「じぇぶ」→「Jest」）。モデルが「どれでもない」を選ぶとは限らないので、**候補の絞り込みを決定的に厳しくし、モデルは最後の取捨だけ**にする設計が要る。
- **Kanary**: 語彙の索引（表記キーと読み＝ローマ字キー）で区間ごとに最大 50 件の候補を決定的に引き、出現箇所を `[...]` で括ってモデルに「どの候補か／null」だけを選ばせる。本文の書き換えはさせず、選ばれた区間が候補の表記ゆれと完全一致するかを検証してから置き換える。読みだけで当たった候補は今はモデルに渡していない。

## 1. 動く条件

| 条件 | 内容 | 出典 |
|---|---|---|
| OS | `SystemLanguageModel` / `LanguageModelSession` は macOS 26.0 から | SDK の `FoundationModels.swiftinterface`（`@available(iOS 26.0, macOS 26.0, …)`）、[SystemLanguageModel](https://developer.apple.com/documentation/foundationmodels/systemlanguagemodel) |
| Mac | Apple Intelligence は「Mac with M1 or later」。保存領域は M3 以降かつ 12GB 以上のメモリの Mac で最大 14 GB、他は最大 8 GB | [How to get the next generation of Apple Intelligence](https://support.apple.com/en-us/121115)（2026-09-14 公開） |
| 有効化 | Apple Intelligence が無効だと `appleIntelligenceNotEnabled` | [UnavailableReason.appleIntelligenceNotEnabled](https://developer.apple.com/documentation/foundationmodels/systemlanguagemodel/availability-swift.enum/unavailablereason/appleintelligencenotenabled) |
| モデル | 未ダウンロードだと `modelNotReady`。「Models are downloaded automatically based on factors like network status, battery level, and system load.」 | [UnavailableReason.modelNotReady](https://developer.apple.com/documentation/foundationmodels/systemlanguagemodel/availability-swift.enum/unavailablereason/modelnotready) |
| 端末 | 非対応端末は `deviceNotEligible` | [UnavailableReason.deviceNotEligible](https://developer.apple.com/documentation/foundationmodels/systemlanguagemodel/availability-swift.enum/unavailablereason/devicenoteligible) |
| 言語 | 対応言語に Japanese が入る。「Device language and Siri language set to the same supported language」が要件で、Siri の言語を変えると使えなくなることがある | [support.apple.com/121115](https://support.apple.com/en-us/121115) |
| 言語の判定 | `supportsLocale(_:)` を `supportedLanguages` より優先せよ（言語のフォールバックも考慮するため） | [supportsLocale(_:)](https://developer.apple.com/documentation/foundationmodels/systemlanguagemodel/supportslocale(_:)) |
| 地域 | 中国本土で購入した端末などでは動かない | [support.apple.com/121115](https://support.apple.com/en-us/121115) |

モデルが無いときの挙動: `availability` が `.unavailable(.deviceNotEligible | .appleIntelligenceNotEnabled | .modelNotReady)` を返す（SDK の `UnavailableReason` はこの 3 つ）。呼び出し側が分岐して代わりの動作をする前提で、ドキュメントの例も `availability` で表示を切り替えている（[SystemLanguageModel](https://developer.apple.com/documentation/foundationmodels/systemlanguagemodel)）。`contextSize` の説明には「model not being available or Apple Intelligence is disabled」のとき取得できない旨がある（[contextSize](https://developer.apple.com/documentation/foundationmodels/systemlanguagemodel/contextsize)）。
Kanary も同じ 3 つの理由を取り込み、`modelUnavailable` / `appleIntelligenceNotEnabled` / `modelNotReady` / `deviceNotEligible` として補正を飛ばす（`KanaryRecordingTranscribe` の文字列と、`dyld_info -imports` に出る `SystemLanguageModel.Availability.UnavailableReason` の 3 ケース）。FoundationModels は weak リンクで、`LSMinimumSystemVersion` は 14.0。つまり**古い OS でも起動し、モデルがあるときだけ補正する**作りになっている。

モデルの版: OS の版ごとに 3 つ（26.0〜26.3 / 26.4 / 27.0）あり、OS 更新で入れ替わる（[SystemLanguageModel](https://developer.apple.com/documentation/foundationmodels/systemlanguagemodel)）。プロンプトの効き方は版で変わりうる。

手元（Apple M4、macOS 27.0.1）での実測: `availability = available`、`supportsLocale(ja_JP) = true`、`supportedLanguages` に ja を含む。

## 2. 使い方

### guided generation

- `@Generable` 型か、実行時に組む `DynamicGenerationSchema` を渡す。どちらも constrained sampling で、型に合わない出力は出ない。「If you don't know what you want the model to produce at compile time use DynamicGenerationSchema」と、メニューから選ばせる例に `anyOf` を使っている（[Generating Swift data structures with guided generation](https://developer.apple.com/documentation/foundationmodels/generating-swift-data-structures-with-guided-generation)）。
- `@Generable` のプロパティは宣言順に生成される。説明文は文脈を食うので短く（同ページ）。
- 語彙の補正では候補が呼ぶたびに変わるので、`DynamicGenerationSchema(name:anyOf: [String])` で「この出現の候補 + `NONE`」を出現ごとのプロパティにするのが素直。モデルは提示外の語や本文の書き換えを返せない。
- **ビルド環境の注意**: Command Line Tools（Xcode なし）では `@Generable` / `@Guide` が `external macro implementation type 'FoundationModelsMacros.GenerableMacro' could not be found` で失敗した（手元の `swiftc`、SDK 27.0）。`DynamicGenerationSchema` と `GenerationSchema(root:dependencies:)`、`respond(to:schema:options:)` なら CLT で組めて動いた。Kanary もマクロではなく `GenerationSchema(type:description:properties:)` と `GeneratedContent.value(_:forProperty:)` を使っている（`dyld_info -imports`）。

### 文脈の上限と語彙の量

- 文脈はセッション単位で、指示・全プロンプト・スキーマ・全応答の合計（[contextSize](https://developer.apple.com/documentation/foundationmodels/systemlanguagemodel/contextsize)、[TN3193](https://developer.apple.com/documentation/technotes/tn3193-managing-the-on-device-foundation-model-s-context-window)）。
- 上限: TN3193 は 4096 トークンと書く。SDK の `contextSize` は `@backDeployed(before: macOS 26.4)` で、macOS 27 未満では定数 `4096` を返し、27 以上では実行時の値を返す実装。手元の macOS 27.0.1 では **8192** だった。
- 日本語は「roughly one character per token」（TN3193）。`tokenCount(for:)` は macOS 26.4 から。
- 手元の `tokenCount` の実測: 「用語N / TermN」形式 50 語 = 380、200 語 = 1,780、1,000 語 = 9,780 トークン。実際の語 8 語（Effect, Kysely, ライブマインドマップ など）= 33 トークン。上の指示文 4 行 = 101 トークン。
- 目安: 語彙全体を 1 回で渡すなら、4096 の環境で数百語が限界で、応答・区間本文・スキーマの分も要る。**出現ごとに絞った数語だけを渡す**なら上限は問題にならない。超えたときは `exceededContextWindowSize`（macOS 27 では `LanguageModelError.contextSizeExceeded` に置き換え予定、SDK の deprecated 注記）が投げられる。

### セッションの再利用と prewarm

- TN3193: 大きな作業は小さく分け「run each step with a new language model session」。同じセッションに投げ続けると履歴が文脈を食う。手元でも 4 回再利用したセッションの transcript は 9 項目に増えた。区間ごとの独立した判定なら**呼ぶたびに新しいセッション**が筋。
- `prewarm(promptPrefix:)`: 「Loads the resources required for this session into memory ahead of a request」。呼んでから応答まで 1 秒以上空くときに使う。読み込みは保証されない（[prewarm(promptPrefix:)](https://developer.apple.com/documentation/foundationmodels/languagemodelsession/prewarm(promptprefix:))）。Kanary は `prewarm` を取り込んでいない（`dyld_info -imports` に出ない）。
- Kanary は `SystemLanguageModel(useCase: .general, guardrails: .permissiveContentTransformations)` を使っている。この guardrail は `String` 以外の生成では既定と同じく `guardrailViolation` を投げる（[permissiveContentTransformations](https://developer.apple.com/documentation/foundationmodels/systemlanguagemodel/guardrails/permissivecontenttransformations)）。Kanary は `refusal` / `guardrailViolation` / `decodingFailure` / `assetsUnavailable` / `exceededContextWindowSize` を個別に扱う。

### 1 回の時間（手元の実測）

Apple M4、macOS 27.0.1、`GenerationOptions(sampling: .greedy)`、出現 1〜2 個・候補 1〜2 個の区間 4 つ。2 回実行。

| 条件 | 1 件目 | 2〜4 件目 |
|---|---|---|
| 毎回新しいセッション | 3,763 ms / 1,058 ms | 379〜559 ms |
| 1 セッションを再利用 + 事前に `prewarm()` して 3 秒待つ | 605〜658 ms | 488〜647 ms |

最初の 1 回だけ重く、その後は 0.4〜0.7 秒。再利用は履歴が伸びる分わずかに遅かった。

### 判定の質（参考。4 例・各 2 回のみ）

| 区間 | 候補 | 新しいセッション | 再利用 |
|---|---|---|---|
| 今日は[えふぇくと]の新しい版で[サーバー]を書き直します | Effect/Expo ・ Server Components | Effect ・ **Server Components**（誤り） | 同左 |
| 来週は[きーせりー]でクエリを組んで[でぃーわん]に載せる | Kysely/Kanary ・ D1/Durable Objects | **Kanary**（誤り）・ D1 | Kysely ・ **Durable Objects**（誤り） |
| 雨が[ふって]きたので帰ります | Futter | NONE | NONE |
| [じぇぶ]で判定を呼ぶ回数を減らしたい | Jev/Jest | **Jest**（誤り） | 同左 |

数が少なく傾向を語れる量ではないが、「候補を提示されると選びがち」で、読みの近さを照合しない（「きーせりー」を Kanary に）誤りが出た。読みの一致は決定的な前処理で確かめ、モデルは文脈の取捨だけにするのが安全そう。

## 3. Kanary の作り方（`/Applications/Kanary.app` 3.6.0 build 80）

### 構成

- `KanaryGlossary.framework`（NaturalLanguage のみに依存。FoundationModels は使わない）: 語彙ファイル（`glossdown` 形式の Markdown 表）、正規化、索引、区間ごとの候補検索。
- `KanaryRecordingTranscribe.framework`（FoundationModels を weak リンク）: 候補の判定（`FoundationModelsTranscriptSuggestionDecider`）、提案の保存・レビュー、録音後の補正（`TranscriptSuggestionService.generateSuggestions(sessionID:forceRegenerate:progress:)`）、ライブ字幕向けの決定的な補正（`LiveGlossaryCorrector.correct(_:)`）。

### 候補の絞り方（決定的、モデル不使用）

- 正規化: `GlossaryNormalizer.normalizedSurfaceKey(_:)`（表記キー）、`jaRomajiKey(fromJapaneseText:)` / `jaRomajiKey(fromKana:)` / `jaRomajiKey(fromSystemLatinTranscription:)`（読みをローマ字にしたキー）、`hiraganaReadingIfPureKatakana(_:)`。英語は `EnglishDoubleMetaphone.keys(for:)` の音のキー。
- 索引: `GlossaryIndex.entries(matchingSurfaceKey:)` / `entries(matchingPhoneticKey:)`。キー長の範囲（`surfaceKeyLengthBounds` / `phoneticKeyLengthBounds`）を持ち、区間の文字列を部分区間（`LookupSpan`）で引くと読める。
- 検索: `GlossarySegmentRetriever.retrieve(segmentText:alternativeSurfaces:limit:)`。`defaultLimit` の値は **50**（バイナリの `__TEXT,__const` の値を読んだ）。音声認識の別候補（`alternativeSurfaces`）も引く。
- 当たり方の種類: 入口（`GlossaryRecallChannel`）は `surface` / `textReading` / `expandedReading` / `alternativeSurface`、一致の種類（`GlossaryMatchKind`）は `exact` / `primaryAlias` / `otherAlias` / `alternative`（文字列の並びからの推定）。
- **読みだけの候補は今はモデルに渡さない**: 「Reading-only candidates are deferred until retrieval can provide deterministic source ranges.」（`fuzzyCandidateDeferred`）。つまり表記（別名を含む）が区間内で一致した出現だけを判定にかける。
- 語彙全体は渡さない。「Segment and glossary candidates exceeded the local model context window.」（`contextWindowExceeded`）で、区間 1 つ + その候補だけを 1 回の呼び出しに入れ、`FoundationModelsTokenBudgeter`（`tokenCount(for:)` と `contextSize` を使い、失敗時は「tokenCount failed; using heuristic count」）で収まるか測る。

### プロンプトの形

指示（文字列そのまま）:

```
Decide whether each bracketed ASR surface refers to one of its candidate terms.
Return exactly one decision for every occurrence.
Select a candidate only when the local context clearly supports that exact term.
Otherwise select null. Do not infer or rewrite any text.
```

スキーマの説明（文字列）: 「Classify possible ASR terminology suggestions in one transcript segment. You will receive deterministic source occurrences and the allowed candidate terms for each occurrence. Return exactly one decision per occurrence. Select one supplied candidate index only when the local context clearly supports that exact term; otherwise return null. Never generate or rewrite transcript text.」、各決定は `occurrenceID`（「The zero-based occurrence ID supplied in the prompt.」）と `selectedCandidateIndex`（「A supplied candidate index, or null when the context does not clearly support a suggestion.」）。

出現の持つ項目（文字列の並び）: `rawRange`、`rawText`、`leftContext`、`rightContext`、`candidateIndices`、`score`。入力は `segmentID`、`candidates`、`occurrences`、`promptText`。区間の本文の中で出現を括弧で示し、出現ごとに候補の番号を渡す形と読める。

応答の検証（エラー文字列）: 決定の欠け（`incompleteOccurrenceDecisions`）、重複、提示していない出現、提示していない候補（`candidateNotOffered`）、範囲の重なり（`overlappingOccurrenceDecisions`）、「A decided source span was not an exact surface variant of its candidate.」（`decisionCandidateMismatch`）。時間切れは「Apple Intelligence did not classify this segment before the local timeout; no suggestion was proposed.」（`decisionTimedOut`）で、その区間は提案なし。

### 置き換えの単位

- 録音後の補正は**提案**として保存され、利用者がレビューで accept / reject する（`proposed` / `accepted` / `rejected`、`kanary-transcript-suggestion-review-v1`）。置き換えの単位は**出現 1 つ＝区間内の文字範囲（`rawRange`）を候補の正しい表記（`canonical`）に**。「The local model selected only deterministic glossary occurrence spans.」。
- `LexicalReplacement` は `TranscriptTerminologyObservationProjector` の入れ子の型で、利用者の手修正（`manualReplace` / `manualRemove` / `manualRevert`）や提案の accept / reject を「語の置き換え」の観察に投影するもの。近くに並ぶ項目は `rawText`、`replacementText`、`atomicEdits`（`insertion` / `deletion` / `replacement`）、`leftContext` / `rightContext`、`lexicalEnvelope`。この観察を「Terminology librarian」用のプロンプト（「Choose the smallest complete reusable lexical item as span=[start,end] … Exclude unchanged particles …」）で語彙の対応（`mapping`）に育てる。つまり**手修正から助詞などを外した最小の語の単位を取り出して語彙に足す**流れ。
- ライブ字幕側の `LiveGlossaryCorrector.correct(_:) -> LiveGlossaryCorrectionResult(correctedText:changes:)` は索引だけで直す（変更は `rawSpanText` / `range` / `term`）。FoundationModels は使っていない（型の依存から）。

## live-mindmap への含意（判断材料）

- 補正は「確定した発言」にだけ、条件を満たす Mac でだけ効く追加の段になる。満たさない利用者には補正なしで同じ動作をさせられる（`availability` で分岐するだけ）。要件（M1 以降・Apple Intelligence 有効・Siri と端末の言語が同じ）は利用者の環境しだいで、こちらから課すものではない。
- 語彙の全部を毎回渡す設計は 4096 トークンの環境で破綻しうる。Kanary と同じく「索引で候補を決定的に絞る → モデルは出現ごとの選択だけ → 結果を表記一致で検証」が前提。
- 1 回 0.4〜0.7 秒なので、発言 1 つの確定ごとに呼べる。最初の 1 回は重いので、セッション開始時に一度 `prewarm()` するか空打ちしておくとよい。
- helper を CLT で組むなら `@Generable` は使えず、`DynamicGenerationSchema` で組む。

## 試した手順

`main.swift`（下の要点だけ）を `swiftc -O main.swift -o probe` で組んで実行（Command Line Tools、SDK 27.0、Apple M4、macOS 27.0.1）。リポジトリには入れていない。

```swift
let props = occ.enumerated().map { (i, cands) in
    DynamicGenerationSchema.Property(name: "o\(i)",
        schema: DynamicGenerationSchema(name: "O\(i)", anyOf: cands + ["NONE"]))
}
let schema = try GenerationSchema(root: DynamicGenerationSchema(name: "Decisions", properties: props), dependencies: [])
let r = try await session.respond(to: prompt, schema: schema, options: GenerationOptions(sampling: .greedy))
```

Kanary は `/Applications/Kanary.app/Contents/Frameworks/{KanaryGlossary,KanaryRecordingTranscribe}.framework` を `strings`、`nm | swift demangle`、`otool -L`、`dyld_info -imports` で読んだ。アプリには手を加えていない。
