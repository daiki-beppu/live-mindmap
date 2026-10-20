# #1378 の計測（使い捨て、main には入れない）

「Jev に共有画面を画像で渡して呼べるか確かめる」（#1378、地図 #1371）の計測。結論は issue #1378 のコメントが正本。

- `jev.mjs tokens <model> <out>`: 10/09 の会議の画面 13 枚を 1 枚ずつ送り、テキストだけの呼び出しとの差を 1 枚のトークン数とする
- `jev.mjs pairs <model> <out>`: `window.tsv`（10/09 の 1800〜2280 秒の 159 枚。#768 の試作と同じ）の隣り合う 2 枚を 158 回、直列に判定させる。問いは #768 の Clef 版と同じ文
- 鍵は環境変数 `TYPESAFE_AI_API_KEY`。呼び出しは `POST /v1/systemone`、ヘッダー `TypeSafe-Danger-Zone-Images: true`、`assets` に base64、`state` に UUID の参照
- 出力の `ms` は手元で測った往復（JSON の組み立て後〜応答の解析まで）、`tokens` は `usage.input_tokens`、`p` は noul、`bytes` は本文の大きさ
- `window.tsv` の `~` はホームに読み替える
