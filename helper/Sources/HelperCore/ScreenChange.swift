import Foundation

// 共有画面の変化の判定（Issue #278）。取り込み（ScreenCapture.swift）から切り離した純粋な部分。
// ScreenCaptureKit にも時計にも依存せず、フレームの列だけで結果が決まる。

/// 変化の判定に使う輝度の画像の大きさ（マス）。
public let screenGridWidth = 128
public let screenGridHeight = 72
/// 最後に送った画面との輝度差が、これを超えたマスを「変わった」と数える。
public let screenLumaDifferenceThreshold = 10
/// 変わったマスが全体のこの割合を超えたら、画面が変わったと判定して送る。
public let screenChangedCellRatioThreshold = 0.005
/// 動きの判定: 前のフレームとの輝度差がこれを超えたマスを「動いた」と数える。
public let screenMotionLumaDifferenceThreshold = 3
/// 最後に動いてからこの秒数がたつまで、そのマスを「いま動いている」とする。
public let screenMotionHoldSeconds = 1.0
/// 「動いたフレームの割合」の指数移動平均の時間の幅（秒）。
public let screenMotionAverageSeconds = 10.0
/// 移動平均がこれを超えたマスを「いま動いている」とする。
public let screenFrequentMotionRatio = 0.25
/// いま動いているマスの周り 5×5 にいま動いているマスがこの数以上あれば、広い動きとして扱う。
public let screenWideMotionCellCount = 8
/// 広い動きの周りを比べる対象から外すマス数。
public let screenWideMotionMargin = 2
/// 点のような小さい動きの周りを比べる対象から外すマス数。
public let screenPointMotionMargin = 1
/// 話している人の枠: 違うマスが前に送った画面と、この輝度差以内でそろっていれば同じ画面とみなす。
public let screenSpeakerFrameLumaTolerance = 6
/// 話している人の枠: 違うマスが全体のこの割合未満のときだけ、前に送った画面との一致で送らない。
public let screenSpeakerFrameMaxChangedRatio = 0.1
/// 話している人の枠の判定のために覚えておく、送った画面の数。
public let screenSentHistoryCount = 30
/// ブラウザのウィンドウのタイトルを読み直す間隔（秒）。
public let screenTitleRefreshSeconds = 1.0
/// ブラウザとして扱うアプリの bundle id（Chrome・Edge・Safari・Arc・Brave・Firefox）。
public let screenBrowserBundleIDs = [
    "com.google.Chrome", "com.microsoft.edgemac", "com.apple.Safari",
    "company.thebrowser.Browser", "com.brave.Browser", "org.mozilla.firefox",
]
/// ブラウザのタイトルにこのどれかを含めば、会議のタブとみなす。
public let screenMeetingTabTitleKeywords = ["Meet"]
/// 画面を取り込む頻度（1 秒あたりのフレーム数）。
public let screenFramesPerSecond = 4
/// 送る画像が収まる大きさ（ピクセル）。
public let screenMaxWidth = 1280
public let screenMaxHeight = 720
/// 送る JPEG の品質（0〜1）。
public let screenJPEGQuality = 0.8

/// 判定器に入れる 1 フレーム。`luma` は 128×72 の輝度（行の並び）、`time` は発言と同じ原点からの秒。
public struct ScreenFrame: Sendable, Equatable {
    public var luma: [UInt8]
    public var time: Double
    /// ウィンドウのタイトル。ブラウザのときだけ、会議のタブかどうかの判定に使う（`screenShowsMeeting`）。
    public var title: String?

    public init(luma: [UInt8], time: Double, title: String?) {
        self.luma = luma
        self.time = time
        self.title = title
    }
}

public enum ScreenInput: Sendable, Equatable {
    case frame(ScreenFrame)
    /// 撮っていたウィンドウが無くなった。`time` は無くなったと分かった時刻（原点からの秒）。
    case windowGone(time: Double)
}

public enum ScreenDecision: Sendable, Equatable {
    /// 画面が変わったので画像を送る。`start` は映り始めた時刻（違うマスが今の値になった時刻の中央値。前に送ると決めたフレームの時刻より前にはしない）。
    case send(start: Double)
    /// 画像を送った後に、ウィンドウが無くなった、またはブラウザが会議以外のタブになった。`image: null` を送る。
    case none(start: Double)
    case nothing
}

/// ブラウザは、タイトルに「Meet」を含むタブだけを会議として扱う。ブラウザの一覧に無いアプリ（会議アプリ本体）はタイトルを見ない。
/// タイトルが読めない（nil・空）ときは会議のタブとして扱う（読めないことは会議以外の証拠にならない）。
public func screenShowsMeeting(bundleID: String, title: String?) -> Bool {
    guard screenBrowserBundleIDs.contains(bundleID) else { return true }
    guard let title, !title.isEmpty else { return true }
    return screenMeetingTabTitleKeywords.contains { title.contains($0) }
}

/// 取り込んだフレームの中身。OS のフレームの状態（ScreenCaptureKit）から、取り込み側で変換する。
enum ScreenFrameContent: Sendable, Equatable {
    /// 画像が更新された。
    case updated
    /// 画像が変わっていない（idle）。
    case unchanged
    /// 使えない。
    case unusable
}

/// 判定器に入れる（輝度, 画像）を決める。idle は輝度の画像を作り直さず、前の値をそのまま使う（時刻だけ進めて判定に入れるため）。
/// OS のフレームの状態は、ここで作り直す手間を省くためだけに使い、判定の根拠にしない。
func screenFrameToJudge<Image>(
    _ content: ScreenFrameContent,
    previous: (luma: [UInt8], image: Image)?,
    render: () -> (luma: [UInt8], image: Image)?
) -> (luma: [UInt8], image: Image)? {
    switch content {
    case .updated: return render()
    case .unchanged: return previous
    case .unusable: return nil
    }
}

/// 最後に送った画面とマスごとに比べ、変わったマスが多いときだけ「送る」を返す。
/// 基準を更新するのは送ったときだけなので、少しずつの変化もフレーム間ではなく最後に送った画面との差として積み上がる。
/// 動いている場所（スクロール・動画・顔の小窓）は比べる対象から外し、話している人の枠の移動は送らない。
public struct ScreenChangeDetector: Sendable {
    private let bundleID: String
    private var lastSent: [UInt8]?
    /// 最後に送ると決めたフレームの時刻。
    private var lastSentTime = 0.0
    /// 前に送った画面（古い順、`screenSentHistoryCount` 枚まで）。
    private var sentHistory: [[UInt8]] = []
    private var previous: (luma: [UInt8], time: Double)?
    private var lastMotionTime: [Double] = []
    private var motionAverage: [Double] = []
    /// マスごとに覚えている値と、その値になった時刻。
    private var remembered: [UInt8] = []
    private var rememberedTime: [Double] = []

    public init(bundleID: String) {
        self.bundleID = bundleID
    }

    public mutating func next(_ input: ScreenInput) -> ScreenDecision {
        switch input {
        case .windowGone(let time):
            guard lastSent != nil else { return .nothing }
            reset()
            return .none(start: time)
        case .frame(let frame):
            return judge(frame)
        }
    }

    /// フレームを判定し、送るときだけ `encode` で画像（base64）を作ってイベントにする。
    /// `encode` が nil を返したら、送っていない画面を「最後に送った画面」にしないよう、基準を判定の前へ戻して nil を返す。
    /// 「なし」のときは画像を作らず、`image: null` のイベントにする。
    public mutating func screenEvent(for frame: ScreenFrame, encode: () -> String?) -> HelperEvent? {
        let before = self
        switch next(.frame(frame)) {
        case .nothing:
            return nil
        case .none(let start):
            return .screen(start: start, image: nil)
        case .send(let start):
            guard let image = encode() else {
                self = before
                return nil
            }
            return .screen(start: start, image: image)
        }
    }

    /// ウィンドウが無くなったとき、画像を送った後なら `image: null` のイベントにする。それ以外は nil。
    public mutating func screenEvent(windowGoneAt time: Double) -> HelperEvent? {
        guard case .none(let start) = next(.windowGone(time: time)) else { return nil }
        return .screen(start: start, image: nil)
    }

    private mutating func reset() {
        lastSent = nil
        lastSentTime = 0
        sentHistory = []
        previous = nil
        lastMotionTime = []
        motionAverage = []
        remembered = []
        rememberedTime = []
    }

    private mutating func judge(_ frame: ScreenFrame) -> ScreenDecision {
        guard screenShowsMeeting(bundleID: bundleID, title: frame.title) else {
            let hadSent = lastSent != nil
            reset()
            return hadSent ? .none(start: frame.time) : .nothing
        }
        let luma = frame.luma
        if remembered.count != luma.count { reset(trackingFor: luma.count) }
        updateMotion(luma, at: frame.time)
        updateRemembered(luma, at: frame.time)
        previous = (luma, frame.time)

        guard let base = lastSent else {
            return send(luma, decidedAt: frame.time, start: frame.time)
        }
        guard luma.count == base.count, !luma.isEmpty else {
            return send(luma, decidedAt: frame.time, start: frame.time)
        }

        let excluded = excludedCells(at: frame.time)
        var compared = 0
        var differing: [Int] = []
        for index in 0..<luma.count where !excluded[index] {
            compared += 1
            if abs(Int(luma[index]) - Int(base[index])) > screenLumaDifferenceThreshold { differing.append(index) }
        }
        guard compared > 0, Double(differing.count) / Double(compared) > screenChangedCellRatioThreshold else { return .nothing }
        if Double(differing.count) / Double(luma.count) < screenSpeakerFrameMaxChangedRatio,
           sentHistory.contains(where: { matches(luma, $0, at: differing) }) {
            return .nothing
        }
        let start = max(median(differing.map { rememberedTime[$0] }), lastSentTime)
        return send(luma, decidedAt: frame.time, start: start)
    }

    private mutating func send(_ luma: [UInt8], decidedAt time: Double, start: Double) -> ScreenDecision {
        lastSent = luma
        lastSentTime = time
        sentHistory.append(luma)
        if sentHistory.count > screenSentHistoryCount { sentHistory.removeFirst(sentHistory.count - screenSentHistoryCount) }
        return .send(start: start)
    }

    private mutating func reset(trackingFor count: Int) {
        previous = nil
        lastMotionTime = [Double](repeating: -.infinity, count: count)
        motionAverage = [Double](repeating: 0, count: count)
        remembered = []
        rememberedTime = []
    }

    /// 前のフレームとの輝度差で「動いた」を数え、最後に動いた時刻と、動いたフレームの割合の移動平均を更新する。
    private mutating func updateMotion(_ luma: [UInt8], at time: Double) {
        guard let previous, previous.luma.count == luma.count else { return }
        let elapsed = time - previous.time
        let alpha = elapsed > 0 ? 1 - exp(-elapsed / screenMotionAverageSeconds) : 0
        for index in 0..<luma.count {
            let moved = abs(Int(luma[index]) - Int(previous.luma[index])) > screenMotionLumaDifferenceThreshold
            if moved { lastMotionTime[index] = time }
            motionAverage[index] += alpha * ((moved ? 1 : 0) - motionAverage[index])
        }
    }

    /// 覚えている値から輝度差のしきい値を超えて変わったマスの、値と時刻を更新する。
    private mutating func updateRemembered(_ luma: [UInt8], at time: Double) {
        if remembered.count != luma.count {
            remembered = luma
            rememberedTime = [Double](repeating: time, count: luma.count)
            return
        }
        for index in 0..<luma.count where abs(Int(luma[index]) - Int(remembered[index])) > screenLumaDifferenceThreshold {
            remembered[index] = luma[index]
            rememberedTime[index] = time
        }
    }

    /// 比べる対象から外すマス。いま動いているマスの周りを、広い動きなら `screenWideMotionMargin`、点なら `screenPointMotionMargin` だけ広げる。
    private func excludedCells(at time: Double) -> [Bool] {
        let count = motionAverage.count
        var moving = [Bool](repeating: false, count: count)
        for index in 0..<count {
            moving[index] = time - lastMotionTime[index] < screenMotionHoldSeconds || motionAverage[index] > screenFrequentMotionRatio
        }
        var excluded = moving
        for index in 0..<count where moving[index] {
            let x = index % screenGridWidth
            let y = index / screenGridWidth
            var neighbors = 0
            for dy in -2...2 {
                for dx in -2...2 where isMoving(moving, x + dx, y + dy) { neighbors += 1 }
            }
            let margin = neighbors >= screenWideMotionCellCount ? screenWideMotionMargin : screenPointMotionMargin
            for dy in -margin...margin {
                for dx in -margin...margin {
                    let nx = x + dx
                    let ny = y + dy
                    if nx >= 0, nx < screenGridWidth, ny >= 0, ny < screenGridHeight { excluded[ny * screenGridWidth + nx] = true }
                }
            }
        }
        return excluded
    }

    private func isMoving(_ moving: [Bool], _ x: Int, _ y: Int) -> Bool {
        guard x >= 0, x < screenGridWidth, y >= 0, y < screenGridHeight else { return false }
        return moving[y * screenGridWidth + x]
    }

    /// 違うマスのすべてが、前に送った画面と輝度差 `screenSpeakerFrameLumaTolerance` 以内でそろっているか。
    private func matches(_ luma: [UInt8], _ sent: [UInt8], at cells: [Int]) -> Bool {
        guard sent.count == luma.count else { return false }
        return cells.allSatisfy { abs(Int(luma[$0]) - Int(sent[$0])) <= screenSpeakerFrameLumaTolerance }
    }

    private func median(_ values: [Double]) -> Double {
        let sorted = values.sorted()
        let middle = sorted.count / 2
        return sorted.count % 2 == 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
    }
}

/// 撮るウィンドウの候補（ScreenCaptureKit の `SCWindow` から写し取った値）。
public struct ScreenWindowCandidate: Sendable, Equatable {
    public var id: UInt32
    /// `SCWindow.owningApplication` の bundle id。持ち主が分からなければ nil。
    public var bundleID: String?
    public var isOnScreen: Bool
    public var width: Double
    public var height: Double

    public init(id: UInt32, bundleID: String?, isOnScreen: Bool, width: Double, height: Double) {
        self.id = id
        self.bundleID = bundleID
        self.isOnScreen = isOnScreen
        self.width = width
        self.height = height
    }
}

/// bundle id が完全に一致し、画面に出ているウィンドウのうち、面積が最大のもの。無ければ nil。
public func selectScreenWindow(bundleID: String, among candidates: [ScreenWindowCandidate]) -> ScreenWindowCandidate? {
    candidates
        .filter { $0.isOnScreen && $0.bundleID == bundleID }
        .max { $0.width * $0.height < $1.width * $1.height }
}

/// 縦横の比を保って 1280×720 に収まる大きさ。小さい画像は拡大しない。端数は切り捨て、最小は 1。
public func fitScreenSize(width: Int, height: Int) -> (width: Int, height: Int) {
    if width <= screenMaxWidth && height <= screenMaxHeight { return (width, height) }
    // 整数だけで、幅と高さのどちらが先に上限へ達するかを比べる（浮動小数の丸めで上限を超えないように）。
    if width * screenMaxHeight >= height * screenMaxWidth {
        return (screenMaxWidth, max(1, height * screenMaxWidth / width))
    }
    return (max(1, width * screenMaxHeight / height), screenMaxHeight)
}
