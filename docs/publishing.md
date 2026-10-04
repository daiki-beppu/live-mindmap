# リポジトリの公開手順

live-mindmap を GitHub で public にするときの手順です。方針は [ADR 0004](adr/0004-mit-license-no-monetization.md) にあります。

## 済んでいること

公開前の点検（2026-10-02）と、公開に要る変更は、すでに main に入っています。

- `LICENSE`（MIT）と、各 `package.json` の `"license": "MIT"`
- README の「ライセンス」と「Claude の認証」（API キーでの認証の案内）
- 点検の結果
  - シークレット: `gitleaks git --log-opts="--all"` で、78 コミットから検出は 0 件。削除済みの `prototypes/diff-engine/.env.op` は 1Password の参照だけで、値は含まない
  - 会議の音声・文字起こし: 履歴に無い。評価用のサンプルは `~/live-mindmap-samples/` にあり、git の外に置いている（2026-10-04 に、公開会議の音声から、内容を書き換えて TTS で合成した会議に置き換えた）
  - issue・PR・docs/knowledge: 社外秘の内容も、文字起こしの長い引用も無い
  - 依存パッケージ: MIT と両立する。`@anthropic-ai/claude-agent-sdk` だけは Anthropic 独自の規約だが、同梱しないので問題ない

## 公開の当日に行うこと

1. GitHub の [Email settings](https://github.com/settings/emails) で「Keep my email addresses private」を有効にし、手元の `git config user.email` を noreply のアドレスに変える（これより前のコミットのアドレスはそのまま公開される）
2. 前回の点検の後に入ったコミットを、もう一度走査する

   ```sh
   nix run nixpkgs#gitleaks -- git --log-opts="--all" --redact .
   git log --all --format= --name-only | sort -u | grep -iE '\.(m4a|wav|mp3|caf|jsonl)$|transcript|\.env'
   ```

   検出されたら公開を止め、直し方（履歴の書き換えか、ファイルの削除か）を先に決める
3. リポジトリを public にする

   ```sh
   gh repo edit daiki-beppu/live-mindmap --visibility public --accept-visibility-change-consequences
   ```

4. リポジトリの説明と topics を設定する

   ```sh
   gh repo edit daiki-beppu/live-mindmap \
     --description "会議の発言から AI がリアルタイムに組み立てるマインドマップ" \
     --add-topic mindmap --add-topic meeting --add-topic speech-to-text --add-topic claude
   ```

5. 公開後のページで、LICENSE が「MIT」と認識されていることを確かめる（`gh repo view --json licenseInfo`）
