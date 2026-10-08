# PROTOTYPE（issue #383）: `start` でモデルとローカルモードを選ぶ形

main には入れない。端末に出るものの見本で、案を比べるためのもの。

## 設定ファイルの置き場所と形（共通の叩き台）

`~/.live-mindmap/config.json`（セッションのフォルダ `~/.live-mindmap/sessions/` と同じ場所）。
環境変数 `LIVE_MINDMAP_CONFIG` で別のファイルを指せる。ファイルが無ければ既定の Claude。

```json
{
  "default": "claude",
  "models": {
    "ollama-qwen": {
      "route": "openai",
      "model": "qwen3.5:9b",
      "url": "http://127.0.0.1:11434/v1",
      "images": true,
      "reopenAfter": 6,
      "maxTokens": 4096,
      "extraBody": { "chat_template_kwargs": { "enable_thinking": false } }
    },
    "gemini": {
      "route": "openai",
      "model": "gemini-3-flash",
      "url": "https://generativelanguage.googleapis.com/v1beta/openai",
      "apiKeyEnv": "GEMINI_API_KEY",
      "images": true
    }
  }
}
```

- `claude`・`apple`・`builtin` の 3 つは名前だけで選べる（設定に書かなくてよい。書けば上書き）
- `default` に `"local"` と書くと、毎回ローカルモードで始まる（規程で外に出せない人向け）
- 環境変数 `LIVE_MINDMAP_MODEL=<名前>` は `default` より優先、`--model` はさらに優先

## 案 1: `--model <名前>` と `--local` を分ける

ローカルモードは「モデル」ではなく約束。`--local` は「約束を求める」旗で、満たせなければ開始を拒む。

```console
$ live-mindmap start --app us.zoom.xos --local
ローカルモード: Apple Intelligence（子プロセス PID 51234、宛先 http://127.0.0.1:53817/v1）
/Users/me/.live-mindmap/sessions/2026-10-08T10-00-00

$ live-mindmap start --app us.zoom.xos --model builtin
内蔵のモデルを読み込んでいます（qwen3.5-4b、2.6GB）…
ローカルモード: 内蔵のモデル qwen3.5-4b（子プロセス PID 51301、宛先 http://127.0.0.1:53902/v1）
/Users/me/.live-mindmap/sessions/2026-10-08T10-05-00
```

- `apple`・`builtin` を選べば、`--local` が無くてもローカルモードになる（自前の子プロセスなので）
- `--local --model ollama-qwen` は拒む

## 案 2: `--model` だけ（`local` も名前の 1 つ）

`--model local` が「この Mac で使えるローカルのモデル（Apple Intelligence、だめなら内蔵）」を指す。旗は 1 つで済むが、「ローカルモードを求める」ことと「モデルを選ぶ」ことが 1 つの値に混ざる（`--model builtin` もローカルモード）。

```console
$ live-mindmap start --app us.zoom.xos --model local
ローカルモード: Apple Intelligence（子プロセス PID 51234、宛先 http://127.0.0.1:53817/v1）
```

## 案 3: サブコマンドを分ける（`start` と `start-local`）

打ち間違えで Claude に送ることが起きにくいが、`start` の旗がすべて 2 か所に要る。

---

## 選べないときのメッセージ（案に依らない。1 行目が理由、2 行目が次にすること）

```console
# Apple Intelligence が使えず、内蔵も残さない場合（#487 の結果しだい）
$ live-mindmap start --app us.zoom.xos --local
この Mac ではローカルモードを使えません: Apple Intelligence がオフです
システム設定 > Apple Intelligence と Siri でオンにしてください

この Mac ではローカルモードを使えません: Apple Intelligence に対応していない機種です
この Mac ではローカルモードを使えません: macOS 27 以上が必要です（今は 26.4）
この Mac ではローカルモードを使えません: Apple Intelligence が管理者によって無効にされています
この Mac ではローカルモードを使えません: Apple Intelligence のモデルを準備中です
しばらく待ってからやり直してください（システム設定 > Apple Intelligence と Siri で進み具合を見られます）

# 内蔵を残す場合、モデルが未取得
内蔵のモデル qwen3.5-4b がありません
live-mindmap models pull qwen3.5-4b で取得してください（2.6GB、Hugging Face から）

# 内蔵の読み込みに失敗
内蔵のモデル qwen3.5-4b を読み込めませんでした: メモリが足りません（空き 1.2GB、要 3.5GB）

# 外部の実行環境にローカルモードを求めた
ローカルモードでは ollama-qwen を選べません
ローカルモードで選べるのは live-mindmap が起動するモデル（apple・builtin）だけです。Ollama などは localhost で動いていても対象外です

# 外部の実行環境（通常のモード）がつながらない
ollama-qwen の宛先 http://127.0.0.1:11434/v1 につながりません
実行環境（Ollama など）が起動しているか確かめてください

# 宛先にモデルが無い（404）
ollama-qwen の宛先にモデル qwen3.5:9b がありません

# API キーの環境変数が無い
gemini の API キーがありません: 環境変数 GEMINI_API_KEY が空です

# 名前が設定に無い
モデル ollama が設定にありません。選べるのは claude・apple・builtin・ollama-qwen・gemini です（~/.live-mindmap/config.json）

# 設定ファイルが壊れている（truthFile と同じ書き方）
設定ファイルが不正です: ~/.live-mindmap/config.json（「models.gemini」の url: 必須です）
```

## 一覧を見るコマンド（あると便利か）

```console
$ live-mindmap models
名前         経路        ローカル  使えるか
claude       Claude      -        はい（既定）
apple        子プロセス   はい      はい
builtin      子プロセス   はい      いいえ: 未取得（live-mindmap models pull qwen3.5-4b）
ollama-qwen  OpenAI 互換  -        設定あり（つながるかは start で確かめる）
gemini       OpenAI 互換  -        設定あり
```
