# ChatGPT のサブスクは、Codex SDK ではなく Sign in with ChatGPT で Responses API を直接呼ぶ

ChatGPT のサブスクで差分更新を呼ぶ経路は、Sign in with ChatGPT で認証し、Responses API を直接呼ぶ形にする。差分更新に必要なのはモデルによる文分類と構造化出力であり、コーディングエージェントの道具やシステムプロンプトは必要ない。[#634](https://github.com/daiki-beppu/live-mindmap/issues/634) の比較と [#635](https://github.com/daiki-beppu/live-mindmap/issues/635) の試作・実測を根拠にする。Claude は引き続き API キーで Agent SDK を使う（ADR 0004）。

## 決定の理由と実測範囲

#634 の調査では、直接呼ぶ場合の `text.format` による構造化出力は使えると読めるものの、実際の受理は未確認だった。#635 で Plus を使い、毎回独立した要求で文ごとに分類し、参照 ID を列挙型に縛る v5 の形式を Responses API に載せると、`json_schema` の strict・列挙型・anyOf・minItems/maxItems が受理され、構造化出力は6/6回通った。この点は実測で確認された。

`gpt-6-luna` の測定対象は `synth/screen` の16:00〜19:20、11発言、正解は決定3・TODO3の短い区間だった。再現は決定3/3・TODO3/3、生成数は決定4・TODO6。応答時間は中央値8.2秒、最大11.2秒、入力1.1〜1.5k・出力240〜510トークンだった。7回の呼び出しによる消費は5時間枠の1%未満だったが、長い会議の消費量への見積もりを保証にはしない。

会議1本を通した品質、Claudeとの同じ区間での比較、`play --realtime` の遅れ、Solなどの重いモデルは測っていない。この結果を会議全体の品質や等速再生での遅れの保証へ広げない。

## Considered Options

- **Sign in with ChatGPT で Responses API を直接呼ぶ（採用）**: `tools` を送らずモデルだけを使え、差分更新の構造化出力は#635で確認できた。通信は `effect/http`、認証は OAuth の実装と ID トークン検証用の `jose` 程度で済む。コーディング用のプロンプトや道具を持ち込まずに要求を組み立てられる
- **Codex SDK を使う**: `outputSchema`（CLIでは `--output-schema`）があり、構造化出力を使える。ただしシェル・Web検索・画像・プラグインなどを機能フラグで個別に切る必要があり、システムプロンプトはコーディング用のまま。#634で比較したSDK本体は約80KBでも、依存するdarwin-arm64バイナリは展開後338MBあった。モデルだけを呼ぶ用途には余分な依存と設定になる
- **公式 DevKit の `@siwc/local` を取り込む**: #634で確認したライセンスは非商用であり、MITのlive-mindmapには取り込まない。認証の文書を参考に自分で実装し、トークンの保存・更新責任をアプリが持つ

## Consequences

- #634・#635で確認したプラン利用は Plus / Pro の open-source and locally hosted apps 向けで、有料アプリやホスト型アプリは申請が要る。認証は `client_id=dynamic_agent_client` から動的登録し、システムブラウザのOpenAIの認可画面からPKCEでループバックへ戻す。クライアントシークレットやパートナーのAPIキーは不要。ChatGPTの会話や記憶をアプリへ開示する認証ではない
- 資格情報の保存（ファイル権限0600）、アクセストークンの更新、入れ替わるリフレッシュトークンの保存をアプリが受け持つ。#634の調査ではアクセストークンは1時間、リフレッシュトークンは30日で入れ替わる
- 要求は `store: false`・`stream: true` にする。HTTPでは `previous_response_id` を使わず、必要な入力を毎回 `input` に含める。`max_output_tokens`・`temperature`・`prompt_cache_retention` はこのプラン利用では使えない。キャッシュによるプラン消費の削減は確認されていない
- Plusの5時間上限はプランを使う全アプリと共有する。上限の `subscription_sharing_usage_limit_exceeded`（429）を受けたときは差分更新を一時停止する。#635では残り枠を示す応答ヘッダーは得られず、利用者はChatGPTの設定で残りを確認する
- ChatGPTの組み込み名を追加せず、READMEで `route: "chatgpt"`・`model: "gpt-6-luna"`・`images: false` の利用者定義例を案内する。モデルの品質は保証しない。評価は同じ合成会議と正解を用い、benchの手順で比較する
