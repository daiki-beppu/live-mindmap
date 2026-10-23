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
/// 撮るウィンドウが見つからないとき、探し直す間隔（秒）。
public let screenWindowRetryInterval = 2.0
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

/// 照合では先頭の通知数と末尾の再生印だけを除き、本文中の数字や記号は保持する。
func normalizedScreenTabTitle(_ title: String) -> String {
    title
        .replacingOccurrences(of: #"^\([0-9]+\)\s+"#, with: "", options: .regularExpression)
        .replacingOccurrences(of: #"\s*🔊\s*$"#, with: "", options: .regularExpression)
}

private func canRememberScreenTabTitle(_ title: String) -> Bool {
    let normalized = normalizedScreenTabTitle(title)
    return !normalized.isEmpty && !["live-mindmap", "about:blank", "新しいタブ", "New Tab"].contains(normalized)
}

private let screenProvisionalSeconds = 60.0
private let screenRetargetSeconds = 10.0

/// ブラウザは、タイトルに「Meet」を含むタブと記憶したタブを会議として扱う。ブラウザの一覧に無いアプリ（会議アプリ本体）はタイトルを見ない。
/// タイトルが読めない（nil・空）ときは会議のタブとして扱う（読めないことは会議以外の証拠にならない）。
public func screenShowsMeeting(bundleID: String, title: String?, rememberedTitle: String? = nil) -> Bool {
    guard screenBrowserBundleIDs.contains(bundleID) else { return true }
    guard let title, !title.isEmpty else { return true }
    return screenMeetingTabTitleKeywords.contains { title.contains($0) }
        || rememberedTitle.map { normalizedScreenTabTitle(title) == normalizedScreenTabTitle($0) } == true
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

/// 送ると決めた画面の中身。`image` は JPEG の base64、`lines` は OCR で読んだ行（失敗したときは nil）。
public struct ScreenShot: Sendable, Equatable {
    public var image: String
    public var lines: [String]?

    public init(image: String, lines: [String]?) {
        self.image = image
        self.lines = lines
    }

    /// JPEG と OCR の結果から作る。OCR が失敗した（nil）ときも画像は送り、`lines` は nil にする。
    init(jpeg: Data, recognizedLines: [String]?) {
        self.init(image: jpeg.base64EncodedString(), lines: recognizedLines)
    }
}

/// 最後に送った画面とマスごとに比べ、変わったマスが多いときだけ「送る」を返す。
/// 基準を更新するのは送ったときだけなので、少しずつの変化もフレーム間ではなく最後に送った画面との差として積み上がる。
/// 動いている場所（スクロール・動画・顔の小窓）は比べる対象から外し、話している人の枠の移動は送らない。
public struct ScreenChangeDetector: Sendable {
    private let bundleID: String
    private enum Tab: Sendable {
        case unknown
        case provisional(title: String, since: Double, candidate: Candidate?)
        case confirmed(title: String)
    }
    private struct Candidate: Sendable {
        let title: String
        let since: Double
    }
    private var tab: Tab = .unknown
    var rememberedTabTitle: String? {
        switch tab {
        case .unknown: nil
        case .provisional(let title, _, _), .confirmed(let title): title
        }
    }
    var confirmedTabTitle: String? {
        if case .confirmed(let title) = tab { return title }
        return nil
    }
    private var comparison = ScreenImageComparison()
    private var provisionalComparison = ScreenImageComparison()
    private var buffered: [(start: Double, shot: ScreenShot)] = []
    private var outputHasImage = false
    private var absentSince: Double?

    public init(bundleID: String) {
        self.bundleID = bundleID
    }

    public mutating func next(_ input: ScreenInput) -> ScreenDecision {
        switch input {
        case .windowGone(let time):
            confirmTab()
            return clearComparisons(at: time)
        case .frame(let frame):
            updateTab(for: frame)
            return judge(frame)
        }
    }

    private mutating func updateTab(for frame: ScreenFrame) {
        guard screenBrowserBundleIDs.contains(bundleID) else { return }
        switch tab {
        case .unknown:
            if let title = frame.title, canRememberScreenTabTitle(title) {
                tab = .provisional(title: title, since: frame.time, candidate: nil)
                provisionalComparison = comparison
            }
        case .confirmed:
            break
        case .provisional(let title, let since, let candidate):
            if frame.time - since >= screenProvisionalSeconds {
                confirmTab()
                return
            }
            guard let proposed = frame.title, canRememberScreenTabTitle(proposed),
                  !isMeet(proposed), normalizedScreenTabTitle(proposed) != normalizedScreenTabTitle(title) else {
                tab = .provisional(title: title, since: since, candidate: nil)
                return
            }
            if let candidate, normalizedScreenTabTitle(candidate.title) == normalizedScreenTabTitle(proposed) {
                if frame.time - candidate.since >= screenRetargetSeconds {
                    tab = .provisional(title: proposed, since: since, candidate: nil)
                    buffered.removeAll()
                    comparison = ScreenImageComparison()
                    provisionalComparison = ScreenImageComparison()
                }
            } else {
                tab = .provisional(title: title, since: since, candidate: Candidate(title: proposed, since: frame.time))
            }
        }
    }

    private func isMeet(_ title: String?) -> Bool {
        title.map { title in screenMeetingTabTitleKeywords.contains { title.contains($0) } } == true
    }

    private func shouldBuffer(_ frame: ScreenFrame) -> Bool {
        if case .provisional = tab { return !isMeet(frame.title) }
        return false
    }

    private mutating func confirmTab() {
        guard case .provisional(let title, _, _) = tab else { return }
        // 遅れて配送する保留画像より新しい即時画像があれば、その比較履歴を維持する。
        if let start = provisionalComparison.lastSentStart,
           comparison.lastSentStart.map({ start >= $0 }) ?? true {
            comparison = provisionalComparison
        }
        provisionalComparison = ScreenImageComparison()
        tab = .confirmed(title: title)
    }

    private mutating func judge(_ frame: ScreenFrame) -> ScreenDecision {
        guard screenShowsMeeting(bundleID: bundleID, title: frame.title, rememberedTitle: rememberedTabTitle) else {
            if absentSince == nil { absentSince = frame.time }
            return clearComparisons(at: frame.time)
        }
        absentSince = nil
        if shouldBuffer(frame) { return provisionalComparison.judge(frame) }
        return comparison.judge(frame)
    }

    private mutating func clearComparisons(at time: Double) -> ScreenDecision {
        let sent = comparison.windowGone(at: time)
        let pending = provisionalComparison.windowGone(at: time)
        return sent == .nothing ? pending : sent
    }

    /// 画像生成の失敗は比較情報だけを戻し、対象の変更・確定と旧画像の破棄は保持する。
    public mutating func screenEvent(for frame: ScreenFrame, encode: () -> ScreenShot?) -> [HelperEvent] {
        updateTab(for: frame)
        let buffering = shouldBuffer(frame)
        let before = buffering ? provisionalComparison : comparison
        let decision = judge(frame)
        var events = flushConfirmedImages()
        switch decision {
        case .nothing:
            break
        case .none(let start):
            events += clearOutput(at: start)
        case .send(let start):
            guard let shot = encode() else {
                if buffering { provisionalComparison = before } else { comparison = before }
                return events
            }
            if buffering {
                buffered.append((start, shot))
            } else {
                events.append(.screen(start: start, image: shot.image, lines: shot.lines, ocrFailed: shot.lines == nil))
                outputHasImage = true
            }
        }
        return events
    }

    public mutating func screenEvent(windowGoneAt time: Double) -> [HelperEvent] {
        var events = finish()
        _ = clearComparisons(at: time)
        absentSince = time
        events += clearOutput(at: time)
        return events
    }

    /// 終了時にも元のstartを維持するため、新しい時刻を作らず確定する。
    public mutating func finish() -> [HelperEvent] {
        confirmTab()
        return flushConfirmedImages()
    }

    private mutating func flushConfirmedImages() -> [HelperEvent] {
        guard confirmedTabTitle != nil, !buffered.isEmpty else { return [] }
        var events = buffered.sorted { $0.start < $1.start }.map {
            HelperEvent.screen(start: $0.start, image: $0.shot.image, lines: $0.shot.lines, ocrFailed: $0.shot.lines == nil)
        }
        buffered.removeAll()
        outputHasImage = true
        // 遅れて届く画像で、現在の不在状態を上書きさせない。
        if let absentSince { events += clearOutput(at: absentSince) }
        return events
    }

    private mutating func clearOutput(at time: Double) -> [HelperEvent] {
        guard outputHasImage else { return [] }
        outputHasImage = false
        return [.screen(start: time, image: nil, lines: nil, meetingTabTitle: rememberedTabTitle)]
    }
}

private struct ScreenImageComparison: Sendable {
    private var lastSent: [UInt8]?
    private(set) var lastSentStart: Double?
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

    mutating func windowGone(at time: Double) -> ScreenDecision {
        guard lastSent != nil else { return .nothing }
        reset()
        return .none(start: time)
    }

    private mutating func reset() {
        lastSent = nil
        lastSentStart = nil
        lastSentTime = 0
        sentHistory = []
        previous = nil
        lastMotionTime = []
        motionAverage = []
        remembered = []
        rememberedTime = []
    }

    mutating func judge(_ frame: ScreenFrame) -> ScreenDecision {
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
        lastSentStart = start
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

/// 取り込みの対象のウィンドウを探している状態。
public enum ScreenWindowSearchState: Sendable, Equatable {
    /// まだ取り込みを始めていない。
    case notStarted
    /// `windowID` のウィンドウを撮っている。
    case capturing(windowID: UInt32)
    /// 撮っていたウィンドウが無くなり、探し直している。
    case windowGone
}

public enum ScreenWindowSearchAction: Sendable, Equatable {
    /// このウィンドウで取り込みを始める。
    case startCapture(windowID: UInt32)
    /// 合うウィンドウが無い。`after` 秒おいて探し直す。
    case retry(after: Double)
    /// 何もしない（撮っているウィンドウが残っている）。
    case nothing
}

/// ウィンドウの探し直しの判断。探し直しの回数に上限は無い。
/// 撮っている状態では、そのウィンドウが候補に残っているかだけを見る（画面に出ているかや持ち主は見ない）。
public func nextScreenWindowAction(
    bundleID: String,
    state: ScreenWindowSearchState,
    among candidates: [ScreenWindowCandidate]
) -> ScreenWindowSearchAction {
    if case .capturing(let id) = state, candidates.contains(where: { $0.id == id }) {
        return .nothing
    }
    guard let chosen = selectScreenWindow(bundleID: bundleID, among: candidates) else {
        return .retry(after: screenWindowRetryInterval)
    }
    return .startCapture(windowID: chosen.id)
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
