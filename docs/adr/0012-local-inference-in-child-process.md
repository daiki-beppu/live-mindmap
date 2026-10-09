# ローカルでの推論は、サーバーが起動する子プロセスで行い、ブラウザでは推論しない

差分更新のモデルを Mac の中で動かすときは、サーバーが推論用の子プロセスを起動する。子プロセスは localhost に OpenAI 互換の HTTP を出し、サーバーは OpenAI 互換の口を使ってそれを呼ぶ。子プロセスは Apple Intelligence（Foundation Models を呼ぶ Swift の実行ファイル）の 1 種類だけにする。Apple Intelligence が使えない Mac では、Mac の中で推論しない（[#381](https://github.com/daiki-beppu/live-mindmap/issues/381)）。ブラウザの WebGPU で推論する経路は作らないので、ブラウザは表示だけという ADR 0003 の前提はそのまま残る（[#379](https://github.com/daiki-beppu/live-mindmap/issues/379)）。

## Considered Options

- **ブラウザの WebGPU（WebLLM）で推論する**: 当初は、何もインストールせずに試せる経路として考えていた。しかし推論するタブを閉じる・再読み込みする・裏に回すと、差分更新が止まる。会議中はブラウザが裏に回るのが普通なのに、隠れたタブで WebGPU が間引かれるかどうかは、一次情報に書かれていない（[#376](https://github.com/daiki-beppu/live-mindmap/issues/376)）。また、数 GB のモデルをブラウザに取得してキャッシュすることになり、ADR 0003 も見直す必要がある。避けたかったのは「アプリとは別に何かを入れて起動すること」なので、npm の依存に入るネイティブのバイナリで同じ目的を果たせる
- **Node から WebGPU（Dawn のバインディング）を使う**: WebLLM は、モデルの保存先をブラウザの Cache API・IndexedDB・OPFS からしか選べない。Node で動いたという例も見当たらない
- **内蔵の子プロセス（node-llama-cpp で GGUF を Metal で動かす）も持ち、Apple Intelligence が使えない Mac の代わりにする**: 当初はこの形で決めていた（#379）。しかし 16GB の M4 で、Qwen3.5-4B はローカル向けの形でも 1 回 中央 21 秒・p90 36 秒かかり、2 発言の間隔（中央 35 秒）とほぼ同じで、メモリの取り合いですぐ遅れが溢れた。Apple Intelligence は中央 6.6 秒（[#487](https://github.com/daiki-beppu/live-mindmap/issues/487)）。遅さの大半は要約を書く生成なので、判定の段を別のモデルに差し替えても差は縮まらない。内蔵は、判定の段ができて Apple Intelligence が使えない Mac の需要が見えたときに考え直す（[#381](https://github.com/daiki-beppu/live-mindmap/issues/381)）
- **サーバーと同じプロセスで node-llama-cpp を動かす**: いちばん単純な形。ただ、ネイティブのアドオンがメモリ不足などで落ちると、セッションの状態・字幕・CLI まで一緒に止まる。子プロセスに分けておけば、落ちても失うのは差分更新だけで、サーバーが子を立ち上げ直せる

## Consequences

- 運び手は OpenAI 互換の口 1 つで済む。Apple Intelligence に固有なのは、子プロセスを起動することと、JSON Schema を Apple 向けの方言に写す処理だけになる
- 子プロセスは `start` で起動する。モデルを読み込み終えてからセッションを始め、セッションを終えたら止める。会議の途中で落ちたら、回数に上限を設けて立ち上げ直す
- Apple Intelligence の文脈長は 8192 トークンしかない。このため、ローカル向けの形では会話を続けず毎回 1 から呼ぶ（#487）
- Apple Intelligence の判断の質は Claude に届かないので、品質の下限に届くまでは「試験的」と案内する（#381）
