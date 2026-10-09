# Apple Intelligence でも差分操作を当てられるプロンプトと出力の形（issue #487 の試作）

2026-10-08〜09 に計測。発言の本文は載せず、数字と置き場所だけを書く。

## 条件

- 機械・素材・評価は #380 と同じ（M4・16GB、`synth/screen` 23 分・78 発言・正解は決定 5・TODO 7、`play` 待ち時間なし → `eval --truth`）
- 試作: `server/src/prototypeLocalUpdater.ts`。`LOCAL_LLM_SHAPE=stateless` と `LOCAL_LLM_VARIANT=v1..v5` で切り替える。宛先は `LOCAL_LLM_URL`（Apple Intelligence は `server/bench/afmServer.ts`、4B は llama.cpp の `llama-server`）
- どの案も共通: 会話を続けず毎回 1 から呼ぶ。マップは話し中の部分だけを見せる。出力の id は、その呼び出しで使える id だけの列挙型（`enum`）に縛り、add の仮 id はサーバーが振る。Swift の側で `maximumResponseTokens: 600`
- Claude のプロンプトと形は変えていない

## 案

- v1: 操作（add / todo / update / close）を自由に組む。親と根拠は列挙型
- v2: 新しい発言 1 つごとに種類（相づち・進行 / 説明 / 問い / 提案 / 懸念 / 合意 / 作業の引き受け）を 1 つ選ぶ。ノードの種別と置き場所はサーバーが決める
- v3: 種類ごとの配列（作業 → 合意 → 中身）に分け、1 発言から複数を拾う
- v4: v3 の各欄の前に「ある / ない」を答えさせ、マップは議題と論点の行だけを見せる
- v5: サーバーが新しい発言を文に切り、文ごとに種類を 1 つ選ばせる（配列の位置で文と対応）。マップは議題と論点だけ

## 結果

| 案 | 決定 | TODO | 作った決定 / TODO | 1 回 中央 / p90 | 入力の最大 | 失敗 |
| --- | --- | --- | --- | --- | --- | --- |
| Apple Intelligence v1 | 2/5 | 1/7 | 2 / 26 | 4.1 / 5.1 秒 | 3.8k | 0/39 |
| Apple Intelligence v2 | 1/5 | 1/7 | 6 / 1 | 8.9 / 27 秒 | 4.0k | 0/39 |
| Apple Intelligence v3 | — | — | 43 / 50 | 19 / 34 秒 | 7.9k | 14/39（文脈長 8192 超え） |
| Apple Intelligence v4 | 3/5 | 2/7 | 43 / 44 | 7.1 / 14 秒 | 2.9k | 0/39 |
| Apple Intelligence v5 | 2/5 | 3/7 | 34 / 17 | 6.6 / 15 秒 | 2.8k | 0/39 |
| Qwen3.5-4B v5 | 1/5 | 4/7 | 24 / 29 | 21 / 36 秒 | 1.2k | 0/39 |
| （#380）Claude Sonnet 5.5 | 4/5 | 5/7 | — | 5.8 / 9.4 秒 | — | 0/39 |
| （#380）Apple Intelligence・今のプロンプト | 0/5 | 0/7 | — | 14.2 / 22.4 秒 | 約 8k | 1/39 |

## 分かったこと

1. **形と文脈長は解ける。** 毎回 1 から呼び、マップは議題と論点だけを見せ、id を列挙型に縛ると、構造の崩れ（存在しない `root` への操作・仮 id の誤り）が消え、入力は 3k 以下に収まり、開き直しが要らない。Apple Intelligence で 1 回 中央 4〜7 秒
2. **判断の質は届かない。** Apple Intelligence は「合意・作業があるか」の見分けがほとんど効かず、指示によって「ほぼ全部なし」（v2）と「ほぼ全部あり」（v3・v4）の間で振れる。配列や「ある / ない」の欄は埋めにいく
3. **粒の粗さが効いている。** この素材の 1 発言は複数の文の塊（説明＋作業の引き受け＋話題の切り替え）で、1 発言 1 種類（v2）では TODO・決定が埋もれる。文ごとの分類（v5）で、Apple Intelligence は正解の TODO の発言 7 つのうち 6 つ、4B は 7 つすべてに TODO を付けた。ただし作った数が多すぎる（精度が低い）
4. **決定はどちらのモデルも外し続ける。** 決定の再現は 1〜3/5 で、当たっても数十個ばらまいた結果
5. **Apple Intelligence の暴走。** 確率的に、出力が止まらず文脈長まで伸びることがある（v2 で 2 回、上限なしでは 190 秒で失敗）。`maximumResponseTokens` で止められる
6. 議題の立て方・兄弟の数（4B v5 で話し中の兄弟の最多 75）は、どの案でも調整していない

## 置き場所

- 試作: このブランチ（`prototype/local-llm-prompt`）の `server/src/prototypeLocalUpdater.ts`・`server/src/diffUpdater.ts`・`server/bench/afm/main.swift`・`server/bench/truthHits.py`
- ランのセッション・1 回ごとの計測（`afm-v1`〜`afm-v5`・`qwen4b-v5`）・`run487.sh`: `~/live-mindmap-samples/runs/local-llm/`（`aborted/` は止めたラン）
