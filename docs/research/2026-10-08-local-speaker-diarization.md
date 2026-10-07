# ローカルで動く話者分離の方式の候補（Issue #368）

`相手` のトラック（会議アプリの音を 1 本に混ぜたもの）を、macOS の端末内でほぼリアルタイムに話者ごとに分ける方式を、一次情報（公式リポジトリ・ドキュメント・論文・モデルカード・Apple の開発者ドキュメント）で比べた。実測はしていない。数値はすべて出典の公開値で、英語中心のデータセットのものが多い。

## 結論

実測（合成会議）に進める候補は次の 3 つ。どれも FluidAudio（Swift Package、Apache-2.0）の同じ `Diarizer` の形で呼べるので、依存 1 つで 3 方式を同じ道具で測れる。別言語のランタイムも C++ のシムも要らない。

1. **Sortformer（FluidAudio の CoreML 版、v2.1 の低遅延設定）** — 第一候補。日本語の公開値がある唯一の候補で、CALLHOME 日本語の DER は 12.7%（同じ論文の pyannote 3.1 は 28.8%）。ラベルは約 1.04 秒遅れで確定し、それより新しい部分は「仮」として先に出て書き換わる。話者キャッシュで長い会議でも同じ人に同じ枠を保つ設計。弱点は **4 人まで**（5 人目以降は取りこぼすか混ぜる）と、静かな声の取りこぼし。
2. **LS-EEND（FluidAudio の CoreML 版）** — 4 人を超える会議の受け皿。最大 10 人（`dihard3` / `dihard2` の型）、0.1 秒刻みで確定し書き換えない。重みは MIT。弱点は 8 kHz 入力、学習の大半が合成データ、扱える長さが「1 時間程度まで」とされている点で、60 分超の会議で枠が保てるかは実測で確かめる必要がある。
3. **pyannote の逐次版（FluidAudio の `DiarizerManager` + `SpeakerManager`）** — 比較の基準と、話者の埋め込みを明示的に持ち続ける方式の代表。人数の上限が無く、埋め込みの DB で長時間・会議をまたいだ同一性を作れる。ただし AMI での逐次の DER は 38〜53% と大きく悪化し、遅れも 5〜10 秒の塊単位になる。

見送り: sherpa-onnx（話者分離はファイル単位のみ）、diart（Python / PyTorch）、NVIDIA NeMo の本家（PyTorch・NVIDIA GPU 前提。CoreML 版を使えば済む）、Argmax SpeakerKit の OSS 版（ファイル単位のみ）、WeSpeaker / 3D-Speaker で逐次クラスタリングを自作（3 の方式と同じ形を自分で書くことになる）。Apple の SpeechAnalyzer と関連フレームワークは、話者の情報を返さない。

様子見: NVIDIA の Nemotron 3 Diarization（Sortformer の後継、8 人まで）。FluidAudio に CoreML 版の実装があるが、モデルは NVIDIA の公開待ちで、HF ではアクセス申請制（2026-10-08 時点）。

## 比較表

| | Sortformer（FluidAudio） | LS-EEND（FluidAudio） | pyannote 逐次（FluidAudio） | pyannote community-1 一括（FluidAudio / SpeakerKit） | sherpa-onnx | diart |
|---|---|---|---|---|---|---|
| 逐次処理 | 可 | 可 | 可（塊ごと） | 不可（ファイル単位） | 不可（ファイル単位） | 可 |
| ラベルの遅れ | 約 1.04 秒（低遅延）〜 30.4 秒 | 0.1〜0.5 秒刻み＋立ち上がり 0.9 秒 | 塊の長さ（3〜10 秒） | — | — | 0.5〜5 秒 |
| 書き換え | 先読み範囲は「仮」で書き換わり、確定後は不変 | しない（出した時点で確定） | しない | — | — | しない |
| 人数 | 4 人まで（固定の枠） | 型により 4〜10 人 | 上限なし（閾値で決まる） | 自動推定。人数指定も可 | 人数指定か閾値 | 既定 20 人まで |
| 日本語の DER | CALLHOME 日本語 12.7%（v2, v2 逐次とも） | 公開値なし | 公開値なし（pyannote 3.1 一括は 28.8%） | 公開値なし | 公開値なし | 公開値なし |
| 会議の DER（AMI SDM） | 20.6%（`balancedV2_1`）, 31.7%（高遅延） | 20.76%（`ami` 型） | 38.2〜55.9% | 10.6% | — | 27.5%（遅れ 5 秒）, 30.4%（1 秒） |
| 長い会議の同一性 | 話者キャッシュ（到着順の枠）で保つ | 状態を持ち続ける。「1 時間程度まで」 | 埋め込みの DB で保つ | 全体をまとめてクラスタリング | 全体をまとめて | 逐次クラスタリング |
| 動かし方 | Swift / CoreML | Swift / CoreML | Swift / CoreML | Swift / CoreML | C++ + ONNX Runtime（Swift API あり） | Python + PyTorch |
| 計算資源 | CPU+GPU+ANE。RTFx 約 5.7（低遅延, M4 Max） | CPU のみが最速。RTFx 74.5（0.5 秒刻み, M4 Max） | RTFx 24.6〜207（M5 Pro） | RTFx 約 323（M5 Pro） | RTF 0.11〜0.45 | — |
| モデルの大きさ | fp16 約 240〜255 MB、6 bit 版 約 97〜104 MB | 約 89 MB（型×刻みごと） | 分割 6 MB + 埋め込み 13.5 MB 程度 | 同左 | 分割 1.5〜5.7 MB + 埋め込み 26〜220 MB | — |
| 重みのライセンス | NVIDIA Open Model License（v2.1）/ CC-BY-4.0（v2） | MIT | CC-BY-4.0 系 | CC-BY-4.0 | 埋め込みごとに異なる | MIT（コード）。重みは pyannote 系 |

RTFx は「実時間の何倍速で処理できるか」。RTF はその逆数。

## 候補ごとの詳細

### FluidAudio（共通）

- Swift Package。ライセンスは Apache-2.0（[LICENSE](https://github.com/FluidInference/FluidAudio/blob/main/LICENSE)）。対応は macOS 14 以降（[Package.swift](https://github.com/FluidInference/FluidAudio/blob/main/Package.swift)）。このリポジトリのヘルパーは macOS 26 以降なので満たす。
- 話者分離は 3 方式（LS-EEND・Sortformer・pyannote）を持ち、LS-EEND と Sortformer は同じ `Diarizer` の形（`addAudio` / `process` / `finalizeSession`、結果は `DiarizerTimeline`）で呼べる（[Models.md](https://github.com/FluidInference/FluidAudio/blob/main/Documentation/Models.md)、[LS-EEND.md](https://github.com/FluidInference/FluidAudio/blob/main/Documentation/Diarization/LS-EEND.md)）。
- 結果は「確定（finalized）」と「仮（tentative）」に分かれる。確定は不変、仮は先読みの範囲にあって次の処理で作り直される（[DiarizerTimeline.md](https://github.com/FluidInference/FluidAudio/blob/main/Documentation/Diarization/DiarizerTimeline.md)）。字幕のように先に出してから直す使い方ができる。
- モデルは初回に Hugging Face から取得してキャッシュする（既定は `~/Library/Application Support/FluidAudio/Models`）。重みをリポジトリに同梱しない形なので、MIT のコードと重みのライセンスは衝突しない。表示義務（帰属表示）は README / NOTICE で果たす。
- README には「モデルは MIT / Apache 2.0」とあるが、各モデルカードの表記は異なる（Sortformer は CC-BY-4.0 / NVIDIA Open Model License、pyannote は CC-BY-4.0 系）。ライセンスはモデルカード側を正とする。

### 1. Sortformer（NVIDIA の Streaming Sortformer を CoreML にしたもの）

- 方式: 端から端までのニューラル話者分離。4 つの固定の枠に、フレームごとの発話確率を出す。クラスタリングは無い。枠は「最初に話した順」に割り当てる（Arrival-Order Speaker Cache）（[NVIDIA のモデルカード v2](https://huggingface.co/nvidia/diar_streaming_sortformer_4spk-v2)）。
- 遅れ: FluidAudio の既定 / `fastV2_1` で約 1.04 秒（`(6 + 7) × 80 ms`）。先読み（right context）7 フレームの分は仮の予測として先に取れる。`balancedV2_1` は約 1.5 秒、`highContextV2_1` は約 3.5 秒、NVIDIA の高遅延設定は 30.4 秒（[Sortformer.md](https://github.com/FluidInference/FluidAudio/blob/main/Documentation/Diarization/Sortformer.md)）。
- 書き換え: 先読みの範囲（仮）だけ。確定した枠の割り当ては戻らない。
- 人数: 4 人が上限。「5 人以上は取りこぼすか混ぜる」「5 人以上が重なって話すと崩れる」と FluidAudio が明記している。NVIDIA の値でも DIHARD III の 5〜9 人は DER 42.56%（≤4 人は 13.24%）。
- 日本語: 多言語の比較論文で、CALLHOME 日本語の DER は Sortformer v2 と v2 の逐次版がともに 12.7%、pyannote 3.1 は 28.8%、DiariZen は 15.6%、pyannoteAI（クラウド）は 13.8%（[Benchmarking Diarization Models, Table 2](https://arxiv.org/html/2509.26177v1)。NVIDIA RTX A6000 での計測）。モデルカードは「主に英語で学習し、英語以外では性能が落ちる」と書く（[v2.1 のモデルカード](https://huggingface.co/nvidia/diar_streaming_sortformer_4spk-v2.1)）。参考に、v2.1 を日本語で追加学習した報告では、追加学習前の CALLHOME 日本語が 10.07%、ビデオ会議の手元データが 9.95%（[Shisa.AI のブログ](https://blog.shisa.ai/posts/fine-tuning-sortformer-japanese-speech/)。第三者の実験報告で、追加学習済みモデルの公開は書かれていない）。
- 会議の精度: FluidAudio の CoreML 版で AMI SDM の DER 20.6%（`balancedV2_1`）、31.7%（高遅延, M2）。取りこぼし（Miss）が誤りの主因で、「静かな声・遠い声を取りこぼすことがある」（[Sortformer.md](https://github.com/FluidInference/FluidAudio/blob/main/Documentation/Diarization/Sortformer.md)、[Benchmarks.md](https://github.com/FluidInference/FluidAudio/blob/main/Documentation/Benchmarks.md)）。NVIDIA の値は CALLHOME 2 人 6.57%・3 人 10.05%・4 人 12.44%。
- 長い会議: 話者キャッシュ（188 フレーム）と FIFO を持ち、溢れたら情報の多いフレームを残して圧縮する。同じ論文の比較で、キャッシュを持たない 30 秒窓の一括処理は AMI の話者取り違えが 32.7% まで増え、逐次版は 2.4%（[Benchmarks.md](https://github.com/FluidInference/FluidAudio/blob/main/Documentation/Benchmarks.md)）。60 分超での値は公開されていない。6 bit 量子化版は「話者キャッシュの誤差が時間とともにずれる」ので逐次では fp16 を勧めている。
- 事前登録: `enrollSpeaker` で既知の声を枠に入れられる。似た声 2 人を含む 4 人でも安定、と FluidAudio の統合テストの記述。会議をまたぐ話者 DB は持たない。
- 計算資源: CoreML で CPU+GPU+ANE（`.all`）。RTFx は既定設定で約 5.7、NVIDIA 高遅延設定で約 125（M4 Max、[HF の CoreML 版](https://huggingface.co/FluidInference/diar-streaming-sortformer-coreml)）。低遅延ほど呼び出しが増えて重い。NVIDIA 本家（GPU）の RTF は低遅延 0.093、超低遅延 0.180。117M パラメータ、16 kHz モノラル。
- 大きさ: fp16 で 1 モデル約 240〜255 MB、6 bit 版で約 97〜104 MB（HF のファイル一覧から集計）。
- ライセンス: v2 の重みは CC-BY-4.0、v2.1 は NVIDIA Open Model License。後者は商用利用・再配布を認め、再配布時は「Licensed by NVIDIA Corporation under the NVIDIA Open Model License」の表示と許諾書の同梱を求める。安全機構の回避や特許訴訟で権利が終了する条項がある（[NVIDIA Open Model License](https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-open-model-license/)）。HF の CoreML 版の表記は cc-by-4.0。実行時に取得するなら MIT との衝突は無い。

### 2. LS-EEND（Westlake University、FluidAudio の CoreML 版）

- 方式: フレーム単位の逐次 EEND。因果的な Conformer と retention で、分割・クラスタリング無しに話者の活動を出す（[論文 arXiv:2410.06670](https://arxiv.org/abs/2410.06670)、IEEE TASLP 2025）。
- 遅れ: 0.1 秒刻み（`step100ms`、既定）〜 0.5 秒刻み。立ち上がりに 0.9 秒の音が要る（[Models.md](https://github.com/FluidInference/FluidAudio/blob/main/Documentation/Models.md)）。
- 書き換え: しない。FluidAudio の LS-EEND は仮の結果を出さず、出したフレームはすべて確定（[LS-EEND.md](https://github.com/FluidInference/FluidAudio/blob/main/Documentation/Diarization/LS-EEND.md)）。
- 人数: 型ごとに上限が違う。`ami` 4 人、`callhome` 7 人、`dihard2` / `dihard3` 10 人。論文は「最大 8 人程度まで柔軟に」。
- 精度（論文の値、正解の発話区間を使わない条件）: CALLHOME 12.11%、DIHARD II 27.58%、DIHARD III 19.61%、AMI 20.76%。CoreML 版の AMI SDM（`ami` 型・0.5 秒刻み）も 20.7%。日本語単独の公開値は無い（CALLHOME は多言語の電話会話で、日本語を含むが言語別の値は出ていない）。
- 長い会議: 論文は「1 時間程度の長い録音」を扱えるとする。FluidAudio は「話者の同一性は録音の中だけ」「事前登録は不安定なことがある」と書く。60 分を超えたときの値は公開されていない。
- 弱点: 入力は 8 kHz。型（学習データの領域）を取り違えると精度が落ちる。学習の大半が合成データで、4 人の事前登録で 4 人目の枠ができずに失敗した例がある。出力確率がおよそ 0.2〜0.8 に張り付く。
- 計算資源: CPU のみが最速（`computeUnits: .cpuOnly` が既定）。RTFx 74.5（AMI, 0.5 秒刻み, M4 Max）。0.1 秒刻みでは呼び出しが 5 倍になり、値は公開されていない。ANE を使わないので、SpeechAnalyzer と ANE を取り合わない。
- 大きさ: 1 モデル約 89 MB（型 × 刻みごとに別ファイル。使うのは 1 つ）。
- ライセンス: 上流のコード・モデルが MIT で、CoreML 版も MIT（[HF のモデルカード](https://huggingface.co/FluidInference/ls-eend-coreml)）。

### 3. pyannote（FluidAudio の CoreML 版。逐次と一括）

- 逐次（`DiarizerManager`）: pyannote speaker-diarization-3.1 を元にした分割＋WeSpeaker の埋め込みを、塊ごとに `SpeakerManager` の話者 DB に照らして ID を振る。コサイン距離の閾値で既存の話者に寄せるか新しい話者を作る。話者の埋め込みを持ち続け、既知の話者を先に入れておける（[SpeakerManager.md](https://github.com/FluidInference/FluidAudio/blob/main/Documentation/Diarization/SpeakerManager.md)）。人数の上限は無い。
- 逐次の精度: AMI SDM 16 会議で、10 秒の塊・重なり無し 38.2%、5 秒・重なり無し 39.0%、3 秒・重なり 1 秒 53.3%、5 秒・重なり 2 秒 55.9%。FluidAudio 自身が「クラスタリングに対してかなり脆い」「本当に逐次が要るときだけ」と書く。重なりのある設定は話者を多く数えすぎる（4 人の会議で 5〜11 人）。分割は「5 秒以上の塊が要る」ので遅れは塊の長さになる（[Benchmarks.md](https://github.com/FluidInference/FluidAudio/blob/main/Documentation/Benchmarks.md)）。
- 一括（`OfflineDiarizerManager`）: pyannote community-1（分割＋WeSpeaker＋VBx）。AMI SDM 16 会議の平均 DER 10.6%、RTFx 約 323（M5 Pro）。fp16 で ANE に載せた分、PyTorch 版（約 11%）より少し落ちる。会議が終わった後の付け直しには使えるが、逐次には使えない。
- pyannote 本家: community-1 の公開値は AMI SDM 19.9%、AliMeeting 20.3%、DIHARD 3 20.2% など。日本語は無い。`num_speakers` / `min_speakers` / `max_speakers` で人数を指定できる。逐次処理の記載は無い（[モデルカード](https://huggingface.co/pyannote/speaker-diarization-community-1)）。
- 大きさ: 分割 約 6 MB、埋め込み 約 13.5 MB、FBank 約 1.8 MB（HF のファイル一覧から集計）。
- ライセンス: community-1 は CC-BY-4.0。FluidAudio の CoreML 版は「scoped-cc-by-4.0」で、範囲は NOTICE.md による（[HF](https://huggingface.co/FluidInference/speaker-diarization-coreml)）。

### Argmax SpeakerKit（argmax-oss-swift）

- pyannote v4（community-1）の CoreML 版を Swift で動かす。MIT。macOS 13 以降。OSS 版の API は音声全体を渡す `diarize(audioArray:)` だけで、逐次は無い。README の「話者付きのリアルタイム文字起こし」は有料の Pro 版の機能（[README](https://github.com/argmaxinc/argmax-oss-swift)）。会議後の付け直しの選択肢にはなるが、FluidAudio の一括と役割が重なる。

### sherpa-onnx

- 話者分離は `OfflineSpeakerDiarization` だけで、音声全体を `Process` に渡す形（[ヘッダ](https://github.com/k2-fsa/sherpa-onnx/blob/master/sherpa-onnx/csrc/offline-speaker-diarization.h)）。逐次版の実装は無く、Sortformer 対応は未解決の要望（[#3497](https://github.com/k2-fsa/sherpa-onnx/issues/3497)）。
- 人数は `num_clusters` で指定（分かっているなら強く推奨）、無ければ距離の閾値（[fast-clustering-config.h](https://github.com/k2-fsa/sherpa-onnx/blob/master/sherpa-onnx/csrc/fast-clustering-config.h)）。
- 分割は pyannote segmentation-3.0（5.7 MB / int8 1.5 MB）か reverb-diarization-v1（非商用のみ）。埋め込みは 3D-Speaker・WeSpeaker・NeMo の ONNX で 23〜221 MB（[モデル一覧](https://k2-fsa.github.io/sherpa/onnx/speaker-diarization/models.html)、[埋め込みのリリース](https://github.com/k2-fsa/sherpa-onnx/releases/tag/speaker-recongition-models)）。RTF は組み合わせで 0.110〜0.452。
- C++ と ONNX Runtime。Swift API はあるが C API 越しで、ONNX Runtime の同梱が要る。コードは Apache-2.0。逐次にするなら、埋め込み抽出と `SpeakerEmbeddingManager` を使って逐次クラスタリングを自分で書くことになる。

### diart

- pyannote の分割と埋め込みに、5 秒の窓を 0.5 秒ずつ進める逐次クラスタリングを組み合わせる。遅れは 0.5〜5 秒で調整できる。過去の出力は書き換えない。DER は遅れ 5 秒で DIHARD III 25.0%・AMI 27.5%・VoxConverse 16.8%、遅れ 1 秒で 27.6%・30.4%・20.1%（[論文](https://arxiv.org/html/2109.06483)）。既定の最大話者数は 20（[diarization.py](https://github.com/juanmc2005/diart/blob/main/src/diart/blocks/diarization.py)）。
- Python と PyTorch。MIT。最終リリースは v0.9.2（2025-02-12）。ヘルパーに入れるには Python の常駐が要り、前例が無いので見送る。方式（逐次クラスタリング）自体は FluidAudio の pyannote 逐次と同じ系統。

### NVIDIA NeMo（Sortformer の本家）

- NeMo（PyTorch）で動かし、NVIDIA の GPU を前提にする（[モデルカード](https://huggingface.co/nvidia/diar_streaming_sortformer_4spk-v2)）。Mac で本家を動かす意味は無く、FluidAudio の CoreML 版を使う。CoreML 版は NeMo の参照と話者の判定が 100% 一致（fp16、一括の場合）と報告されている。

### WeSpeaker / 3D-Speaker の埋め込み＋逐次クラスタリング（自作）

- WeSpeaker: コードは Apache-2.0。学習済みモデルのライセンスは学習データに従う（VoxCeleb なら CC-BY-4.0）（[pretrained.md](https://github.com/wenet-e2e/wespeaker/blob/master/docs/pretrained.md)）。ONNX で配布。
- 3D-Speaker: Apache-2.0。CAM++（7.2M）・ERes2NetV2（17.8M）など。会議の話者分離（オフラインのレシピ）で AMI SDM 21.76%、AliMeeting 19.73%、中国語の社内会議 12.78〜18.91%。逐次のレシピは無い（[README](https://github.com/modelscope/3D-Speaker)）。CAM++ の CoreML 版は FluidAudio にベータで入っている（[Benchmarks.md](https://github.com/FluidInference/FluidAudio/blob/main/Documentation/Benchmarks.md)）。
- 埋め込み＋逐次クラスタリングは、FluidAudio の pyannote 逐次（`SpeakerManager`）がすでに同じ形をしている。自作するなら、その数値（AMI で 38〜56%）を超える見込みが要る。

### Apple の SpeechAnalyzer と関連フレームワーク

- SpeechAnalyzer のモジュールは `SpeechTranscriber`・`DictationTranscriber`・`SpeechDetector`（発話区間の検出）で、話者のモジュールは無い（[Speech](https://developer.apple.com/documentation/speech)）。
- `SpeechTranscriber.ResultAttributeOption` は `audioTimeRange`（時刻）と `transcriptionConfidence`（確信度）だけで、話者の属性は無い（[ResultAttributeOption](https://developer.apple.com/documentation/speech/speechtranscriber/resultattributeoption)）。
- Sound Analysis は音の種類の分類で、話者の識別はしない（[Sound Analysis](https://developer.apple.com/documentation/soundanalysis)）。
- 使えるのは `audioTimeRange` で、文字起こしの区間と話者分離のタイムラインを時刻で突き合わせる材料になる（ADR 0002 のヘルパーは hostTime で時刻を揃えている）。

## 実測で確かめること

公開値で埋まらなかった点。合成会議（`~/live-mindmap-samples/`）で測る。

- 日本語の会議音声での DER（話者の取り違え・取りこぼしの内訳）。会議アプリを通った音（帯域・コーデック）での値
- 60 分超で、同じ人に同じラベルが付き続けるか（後半の取り違えの割合）
- 4 人を超える `相手` の会議での Sortformer の崩れ方と、LS-EEND との差
- ラベルの遅れと、仮のラベルがどれだけ書き換わるか（字幕・マップの表示を跳ばさないため。共有画面で表示を動かさない方針と合わせて決める）
- SpeechAnalyzer と同時に動かしたときの CPU / ANE の負荷と、文字起こしの確定の遅れへの影響（LS-EEND は CPU のみ、Sortformer は ANE も使う）
