# 会議アプリがマイクの入力を使っているかを、公開 API で判定できるか（Issue #1042）

結論: **判定できる（条件つき）。** Core Audio のプロセスオブジェクト（公開 API）で、プロセスごとに「いま入力の IO が動いているか」が読める。会議の途中も、通知で追い続けられる。ただし通知を張る先は `kAudioProcessPropertyIsRunningInput` ではない。

- **手段**: `kAudioHardwarePropertyProcessObjectList` で Core Audio のプロセス一覧を取り、`--app` の bundle id に属するもの（今の `tapTargets` と同じ「本体か `<bundle>.` で始まる helper」の対応）の `kAudioProcessPropertyIsRunningInput` を読む。どれか 1 つが 1 なら「入力を使っている」。
- **通知**: macOS 27.0.1 の実測で、`kAudioProcessPropertyIsRunningInput`（`'piri'`）と `kAudioProcessPropertyIsRunning`（`'pir?'`）にリスナーを張っても、**一度も通知が来なかった**（ワイルドカードの scope でも同じ）。入力を開く・閉じるたびに通知が来たのは `kAudioProcessPropertyDevices`（`'pdv#'`、入力・出力の両 scope）だった。よって「`Devices` の入力 scope と、プロセス一覧（`ProcessObjectList`）に通知を張り、届いたら `IsRunningInput` を読み直す」か、0.5 秒程度のポーリングで追う。どちらも公開 API。
- **自分のヘルパーとの区別**: プロセスオブジェクトは pid を持つ（`kAudioProcessPropertyPID`）。live-mindmap-helper は bundle id が空（実測）なので、今の bundle id の対応では最初から対象に入らない。念のため `getpid()` と一致するものを除けば確実。
- **OS の版**: ヘルパーの対象は macOS 26 以降（`helper/Package.swift` の `platforms: [.macOS("26.0")]`）で、その範囲では使える。ヘッダに可用性の注記は無い（後述）。
- **代わりの手段**: `AVCaptureDevice.isInUseByAnotherApplication` は**機器単位**でアプリは分からず、実測では他のプロセスがマイクを使っている間も `false` のままで、代わりにならない。`kAudioDevicePropertyDeviceIsRunningSomewhere` も機器単位。

## 一次資料

### Core Audio のヘッダ（MacOSX27.0.sdk。26.5 SDK も該当部分は同一）

`CoreAudio.framework/Headers/AudioHardware.h`:

- `kAudioHardwarePropertyProcessObjectList`（`'prs#'`）: "An array of AudioObjectIDs that represent the Process objects for all client processes currently connected to the system."
- `kAudioHardwarePropertyTranslatePIDToProcessObject`（`'id2p'`）: pid から Process オブジェクトを引く。
- `kAudioProcessPropertyIsRunningInput`（`'piri'`）: "A UInt32 where a value of 0 indicates that the process is not running any IO or there is not any active input streams, and a value of 1 indicates that the process is running IO and there is at least one active input stream."
  - 意味は「デバイスを開いているだけ」ではなく「**IO が動いていて、かつ有効な入力ストリームがある**」。ただし「アプリが読んだデータを使っているか」や「アプリ内でミュートしているか」までは言わない（後述の注意）。
- `kAudioProcessPropertyIsRunning`（`'pir?'`）: "Note that audio IO may in progress even if no input or output streams are active."（入出力の区別なし）
- `kAudioProcessPropertyDevices`（`'pdv#'`）: "the devices currently used by the process for input or used by the process for output. The scope will select the input or output device list."
- `kAudioProcessPropertyBundleID`（`'pbid'`）、`kAudioProcessPropertyPID`（`'ppid'`）。
- どのプロパティについても「変化を通知する／しない」の記述は無い。`AudioObjectAddPropertyListener` は一般論として "register a function that is to be called when a given property's value changes" とあるだけ。
- 可用性: Process クラスの定数には `API_AVAILABLE` の注記が無い（同じヘッダの新しい定数、例 `kAudioDevicePropertySuggestedReferenceDevice API_AVAILABLE(macos(27.0))` には付いている）。Apple の公式ドキュメント（`developer.apple.com/documentation/coreaudio/kaudioprocesspropertyisrunninginput` の JSON）も「macOS」とだけで導入版は空。Process オブジェクトは Core Audio taps（macOS 14.2）と同じ世代の API で、今のヘルパーはすでに同じ一覧と `IsRunningOutput` を `相手` のタップの対象選びに使っている（`CoreAudioProcesses.swift`）。ヘルパーの対象 OS は 26 以上なので、版の問題は無い。

### AVFoundation のヘッダ

`AVFoundation.framework/Headers/AVCaptureDevice.h` の `inUseByAnotherApplication`: "a BOOL indicating whether the device represented by the receiver is in use by another application. Clients can key value observe the value…"。**機器（AVCaptureDevice）の性質**で、どのアプリが使っているかは返さない。

### 許可

プロセス一覧と `IsRunningInput` の読み取りに、Core Audio のヘッダは許可の要件を書いていない。今のヘルパーは同じ一覧をすでに読んでいる。試しのプログラムは、マイクの許可が「許可済み」（`AVCaptureDevice.authorizationStatus(for: .audio) == 3`）の端末から動かしたので、未許可の状態で読めるかは確かめていない。ヘルパーは自分のマイクのためにマイクの許可を持つので、実運用では問題にならない。

## 実測（macOS 27.0.1、build 26A434、MacBook Air）

リポジトリの外（作業用ディレクトリ）に Swift の小さなプログラムを 3 本書いて動かした。

- `probe list`: Core Audio のプロセス一覧を、pid・親 pid（`proc_pidinfo`）・実行ファイル名・bundle id・`IsRunning`・`IsRunningInput`・`IsRunningOutput`・入力 scope の `Devices` で出す。
- `probe watch`: 全プロセスの `IsRunningInput`・`IsRunningOutput`・`IsRunning`・`Devices`（入力 scope）と、プロセス一覧、既定の入力機器の `IsRunningSomewhere` にリスナーを張り、同時に 0.5 秒ごとのポーリングで `IsRunningInput` の変化を出す。`AVCaptureDevice.isInUseByAnotherApplication` も KVO で見る。
- `opener N`: `AVAudioEngine` の入力に tap を付けて N 秒だけ既定の入力を開き、閉じる（会議アプリの代わり）。

### 一覧（抜粋）

会議の取り込み（`live-mindmap-helper run --app com.google.Chrome`）が動いていて、Chrome で音が鳴っている時点:

```
obj=92  pid=752   ppid=1     exe=Google Chrome        bundle=com.google.Chrome        running=0 in=0 out=0 inDevices=[]
obj=100 pid=11265 ppid=752   exe=Google Chrome Helper bundle=com.google.Chrome.helper running=1 in=0 out=1 inDevices=[]
obj=102 pid=11228 ppid=752   exe=Google Chrome Helper bundle=com.google.Chrome.helper running=0 in=0 out=0 inDevices=[]
obj=107 pid=94381 ppid=82459 exe=live-mindmap-helper  bundle=                         running=1 in=1 out=1 inDevices=["MacBook Airのマイク"]
AVCaptureDevice default audio: MacBook Airのマイク inUseByAnotherApplication=false
```

- `pid=11265` は `--utility-sub-type=audio.mojom.AudioService`、`pid=11228` は `video_capture.mojom.VideoCaptureService`（`ps` の引数で確認）。Chrome の音声の入出力はすべて Audio Service のユーティリティプロセス（bundle id `com.google.Chrome.helper`）に集まり、本体（`com.google.Chrome`）の値は 0 のまま。
- live-mindmap-helper は bundle id が空で、入力・出力とも 1（ボイスプロセッシングで出力側も開く）。
- ヘルパーがマイクを使っている最中でも、`AVCaptureDevice.isInUseByAnotherApplication` は `false`。

### 通知とポーリング（`opener` を 2 回動かした間）

```
490.25 NOTIFY ProcessObjectList changed
  new: obj=110 pid=76807 exe=opener running=0 in=0 out=0 inDevices=[]
490.64 NOTIFY 70647623 obj=110 pid=76807 exe=opener running=1 in=1 out=0 inDevices=["MacBook Airのマイク"]
490.65 NOTIFY device IsRunningSomewhere=Optional(1) AVinUse=Optional(false)
491.06 POLL in 0->1 obj=110 pid=76807 exe=opener running=1 in=1 ...
494.66 NOTIFY 70647623 obj=110 pid=76807 exe=opener running=0 in=0 out=0 inDevices=[]
495.02 POLL in 1->0 obj=110 pid=76807 exe=opener running=0 in=0 ...
```

- `70647623` は `'pdv#'`（`kAudioProcessPropertyDevices`）。入力を開いた瞬間・閉じた瞬間に届き、その時点で読んだ `IsRunningInput` は新しい値になっていた。
- `IsRunningInput`・`IsRunningOutput`・`IsRunning` のリスナーからは 1 度も通知が来なかった。別のプログラムで、opener の Process オブジェクトに `IsRunningInput` × ワイルドカード scope と、セレクタ自体のワイルドカード（`kAudioObjectPropertySelectorWildcard`）を張っても、届いたのは `'pdv#'` の入力 scope（`'inpt'`）と出力 scope（`'outp'`）だけだった。
- 新しくマイクを開いたプロセスは、先に `ProcessObjectList` の変化として現れる（Process オブジェクトは IO を始める前に作られる）。よって一覧にも通知を張り、新しいプロセスに `Devices` のリスナーを足す必要がある。
- `AVCaptureDevice.isInUseByAnotherApplication` は KVO でも `false` のままだった（このプロセスとは別の opener がマイクを使っていても）。

## 会議アプリと Process オブジェクトの対応

今の `相手` のタップの対象選び（`MeetingApps.swift` の `belongs`・`tapTargets`）は「bundle id が `--app` と一致するか、`--app + "."` で始まる」プロセスをすべて取る。入力側にもそのまま使える。

| アプリ | `--app` | 入力を扱うプロセス | 今の対応で拾えるか |
|---|---|---|---|
| Chrome（Meet・YouTube など） | `com.google.Chrome` | Audio Service（`com.google.Chrome.helper`、実測） | 拾える |
| Zoom | `us.zoom.xos` | 未実測。同梱の helper の bundle id は `us.zoom.caphost`・`us.zoom.CptHost`・`us.zoom.aomhost` など（`/Applications/zoom.us.app` の Info.plist で確認）で、`us.zoom.xos.` で始まらない | 本体で入力を扱っていれば拾える。helper で扱っていれば**拾えない** |
| Teams・Slack | — | この Mac に入っておらず未確認 | 未確認 |

- Zoom のように helper の bundle id が本体の前置きにならないアプリは、出力側のタップでも同じ取りこぼしがありうる。公開の代わりの対応づけとして、`proc_pidinfo(PROC_PIDTBSDINFO)` の親 pid（実測で Chrome の helper の親は Chrome 本体）をたどる方法がある。
- Chrome の Audio Service はタブ単位ではない。Meet 以外のタブ（音声検索、別の会議サービスなど）がマイクを開いても `1` になる。

## 注意

- **「入力を使っている」は「話せる（ミュートされていない）」と同じではない。** `IsRunningInput` は IO と入力ストリームの有無だけを言う。会議アプリがアプリ内のミュート中も入力を開いたままにするか、閉じるかはアプリ次第で、この調査では Meet・Zoom の実際の挙動を確かめていない（取り込み中の会議を乱さないため、Meet を操作しての計測はしていない）。
- 通知が来るのが `IsRunningInput` でなく `Devices` なのは実測で、ヘッダには書かれていない。OS の更新で変わりうるので、通知に加えて低頻度のポーリングを併用するか、ポーリングだけにするのが安全。
- Chrome の Audio Service は落ちて作り直されることがあり、そのとき Process オブジェクトも変わる。一覧の通知を受けて対象を取り直す必要がある。
- live-mindmap-helper が将来 bundle id を持つようになっても、pid で除外すれば区別は保てる。
