import Foundation
import Testing
@testable import HelperCore

// 共有画面の判定器（取り込みから切り離した純粋な部分）。合成した輝度のフレームを順に入れて試す。
// ScreenCaptureKit は呼ばない（CI のジョブには画面収録の許可が無い）。

private let width = Int(screenGridWidth)
private let height = Int(screenGridHeight)
private let cellCount = width * height

/// 会議アプリ本体（ブラウザの一覧に無いので、タイトルを見ない）。
private let zoomBundleID = "us.zoom.xos"
private let chromeBundleID = "com.google.Chrome"
private let meetTitle = "Meet - abc-defg-hij"
private let otherTabTitle = "Gmail - Inbox"

private func makeDetector(_ bundleID: String = zoomBundleID) -> ScreenChangeDetector {
    ScreenChangeDetector(bundleID: bundleID)
}

/// 128×72 の輝度。全マスが `fill`。
private func luma(fill: UInt8) -> [UInt8] {
    [UInt8](repeating: fill, count: cellCount)
}

/// `base` の、左上から `columns`×`rows` の長方形のマスを `value` に書き換えた輝度。
private func rewritten(_ base: [UInt8], columns: Int, rows: Int, to value: UInt8) -> [UInt8] {
    painted(base, column: 0, row: 0, columns: columns, rows: rows, to: value)
}

/// `base` の、(column, row) から `columns`×`rows` の長方形のマスを `value` に書き換えた輝度。
private func painted(_ base: [UInt8], column: Int, row: Int, columns: Int, rows: Int, to value: UInt8) -> [UInt8] {
    var result = base
    for y in row..<(row + rows) {
        for x in column..<(column + columns) { result[y * width + x] = value }
    }
    return result
}

/// `base` の先頭から `count` 個（行の並びの順）のマスを `value` に書き換えた輝度。
private func rewritten(_ base: [UInt8], firstCells count: Int, to value: UInt8) -> [UInt8] {
    var result = base
    for index in 0..<count { result[index] = value }
    return result
}

private func frame(_ luma: [UInt8], at time: Double, title: String? = nil) -> ScreenInput {
    .frame(ScreenFrame(luma: luma, time: time, title: title))
}

@Suite("共有画面の判定器のしきい値")
struct ScreenThresholdTests {
    @Test("しきい値は名前の付いた値で、128×72 の輝度・差 10・0.5%・4 fps・1280×720 を表す")
    func namedThresholds() {
        #expect(screenGridWidth == 128)
        #expect(screenGridHeight == 72)
        #expect(screenLumaDifferenceThreshold == 10)
        #expect(screenChangedCellRatioThreshold == 0.005)
        #expect(screenFramesPerSecond == 4)
        #expect(screenMaxWidth == 1280)
        #expect(screenMaxHeight == 720)
    }

    @Test("動きの判定・話している人の枠・タイトルの読み直しのしきい値も、名前の付いた値")
    func namedMotionThresholds() {
        #expect(screenMotionLumaDifferenceThreshold == 3)
        #expect(screenMotionHoldSeconds == 1.0)
        #expect(screenMotionAverageSeconds == 10.0)
        #expect(screenFrequentMotionRatio == 0.25)
        #expect(screenWideMotionCellCount == 8)
        #expect(screenWideMotionMargin == 2)
        #expect(screenPointMotionMargin == 1)
        #expect(screenSpeakerFrameLumaTolerance == 6)
        #expect(screenSpeakerFrameMaxChangedRatio == 0.1)
        #expect(screenSentHistoryCount == 30)
        #expect(screenTitleRefreshSeconds == 1.0)
    }

    @Test("ブラウザの一覧は Chrome・Edge・Safari・Arc・Brave・Firefox、会議のタブのタイトルは「Meet」")
    func namedBrowserRules() {
        let expected: Set<String> = [
            "com.google.Chrome", "com.microsoft.edgemac", "com.apple.Safari",
            "company.thebrowser.Browser", "com.brave.Browser", "org.mozilla.firefox",
        ]
        #expect(Set(screenBrowserBundleIDs) == expected)
        #expect(Array(screenMeetingTabTitleKeywords) == ["Meet"])
    }
}

@Suite("共有画面: 会議のタブかどうか（screenShowsMeeting）")
struct ScreenShowsMeetingTests {
    private let browsers = [
        "com.google.Chrome", "com.microsoft.edgemac", "com.apple.Safari",
        "company.thebrowser.Browser", "com.brave.Browser", "org.mozilla.firefox",
    ]

    @Test("ブラウザでは、タイトルに「Meet」を含めば会議のタブ、含まなければ違う")
    func browserChecksTitle() {
        for bundleID in browsers {
            #expect(screenShowsMeeting(bundleID: bundleID, title: "Meet - abc-defg-hij"), "\(bundleID)")
            #expect(screenShowsMeeting(bundleID: bundleID, title: "予定 Meet 会議 - Google Chrome"), "\(bundleID)")
            #expect(!screenShowsMeeting(bundleID: bundleID, title: "Gmail - Inbox"), "\(bundleID)")
        }
    }

    @Test("ブラウザでタイトルが読めない（nil・空）ときは、会議のタブとして扱う")
    func unreadableTitleIsTreatedAsMeeting() {
        #expect(screenShowsMeeting(bundleID: "com.google.Chrome", title: nil))
        #expect(screenShowsMeeting(bundleID: "com.google.Chrome", title: ""))
    }

    @Test("ブラウザの一覧に無いアプリ（会議アプリ本体）は、タイトルを見ずに会議として扱う")
    func nonBrowserIgnoresTitle() {
        #expect(screenShowsMeeting(bundleID: "us.zoom.xos", title: "Gmail - Inbox"))
        #expect(screenShowsMeeting(bundleID: "us.zoom.xos", title: nil))
        #expect(screenShowsMeeting(bundleID: "com.microsoft.teams2", title: "予定表"))
    }
}

@Suite("共有画面の判定器")
struct ScreenChangeDetectorTests {
    @Test("最初のフレームは送る。映り始めた時刻は、そのフレームの時刻")
    func firstFrameIsSent() {
        var detector = makeDetector()
        #expect(detector.next(frame(luma(fill: 100), at: 2.5)) == .send(start: 2.5))
    }

    @Test("同じ画面が続く間は送らない（一度送った後の、同じ輝度のフレーム）")
    func identicalFramesAreNotSent() {
        var detector = makeDetector()
        #expect(detector.next(frame(luma(fill: 100), at: 0)) == .send(start: 0))
        #expect(detector.next(frame(luma(fill: 100), at: 0.25)) == .nothing)
        #expect(detector.next(frame(luma(fill: 100), at: 0.5)) == .nothing)
        #expect(detector.next(frame(luma(fill: 100), at: 0.75)) == .nothing)
    }

    @Test("スライドの切り替え（全マスが変わる）は、変わったフレームでは送らず、止まって 1 秒後に、変わった時刻を映り始めた時刻として送る")
    func slideSwitchIsSentAfterOneSecondOfStillness() {
        var detector = makeDetector()
        #expect(detector.next(frame(luma(fill: 30), at: 0)) == .send(start: 0))
        #expect(detector.next(frame(luma(fill: 30), at: 0.25)) == .nothing)
        #expect(detector.next(frame(luma(fill: 220), at: 0.5)) == .nothing)
        #expect(detector.next(frame(luma(fill: 220), at: 0.75)) == .nothing)
        #expect(detector.next(frame(luma(fill: 220), at: 1.25)) == .nothing) // 変わってから 0.75 秒
        #expect(detector.next(frame(luma(fill: 220), at: 1.5)) == .send(start: 0.5)) // 変わってから 1 秒
        #expect(detector.next(frame(luma(fill: 220), at: 1.75)) == .nothing)
    }

    @Test("文字 1 行の追加（60 マス）は、止まって 1 秒後に送る")
    func oneTextLineAdditionIsSent() {
        let page = luma(fill: 240)
        let withLine = rewritten(page, columns: 60, rows: 1, to: 0)
        var detector = makeDetector()
        #expect(detector.next(frame(page, at: 0)) == .send(start: 0))
        #expect(detector.next(frame(withLine, at: 0.5)) == .nothing)
        #expect(detector.next(frame(withLine, at: 1.25)) == .nothing)
        #expect(detector.next(frame(withLine, at: 1.5)) == .send(start: 0.5))
    }

    @Test("表のセル 1 つの書き換え（16×4 マス = 64 マス > 0.5%）は、止まって 1 秒後に送る")
    func singleTableCellRewriteIsSent() {
        let page = luma(fill: 240)
        let rewrittenPage = rewritten(page, columns: 16, rows: 4, to: 40)
        var detector = makeDetector()
        #expect(detector.next(frame(page, at: 0)) == .send(start: 0))
        #expect(detector.next(frame(page, at: 0.25)) == .nothing)
        #expect(detector.next(frame(rewrittenPage, at: 0.5)) == .nothing)
        #expect(detector.next(frame(rewrittenPage, at: 1.25)) == .nothing)
        #expect(detector.next(frame(rewrittenPage, at: 1.5)) == .send(start: 0.5))
    }

    @Test("変わったマスが 0.5% 以下なら送らず、0.5% を超えたら送る（46 マスは送らず、47 マスは送る）")
    func changedCellRatioBoundary() {
        // 9216 マスの 0.5% は 46.08 マス。46 マスは 0.4991%、47 マスは 0.5100%
        let page = luma(fill: 240)
        var small = makeDetector()
        #expect(small.next(frame(page, at: 0)) == .send(start: 0))
        #expect(small.next(frame(rewritten(page, firstCells: 46, to: 0), at: 0.25)) == .nothing)
        #expect(small.next(frame(rewritten(page, firstCells: 46, to: 0), at: 1.25)) == .nothing)

        var large = makeDetector()
        #expect(large.next(frame(page, at: 0)) == .send(start: 0))
        #expect(large.next(frame(rewritten(page, firstCells: 47, to: 0), at: 0.25)) == .nothing)
        #expect(large.next(frame(rewritten(page, firstCells: 47, to: 0), at: 1.25)) == .send(start: 0.25))
    }

    @Test("輝度差が 10 のマスは変わったと数えず、11 のマスは数える（全マスで試す）")
    func lumaDifferenceBoundary() {
        var ten = makeDetector()
        #expect(ten.next(frame(luma(fill: 100), at: 0)) == .send(start: 0))
        #expect(ten.next(frame(luma(fill: 110), at: 0.25)) == .nothing) // 差 10
        #expect(ten.next(frame(luma(fill: 110), at: 1.25)) == .nothing)

        var tenDarker = makeDetector()
        #expect(tenDarker.next(frame(luma(fill: 100), at: 0)) == .send(start: 0))
        #expect(tenDarker.next(frame(luma(fill: 90), at: 0.25)) == .nothing) // 差 10（暗くなる向き）
        #expect(tenDarker.next(frame(luma(fill: 90), at: 1.25)) == .nothing)

        var eleven = makeDetector()
        #expect(eleven.next(frame(luma(fill: 100), at: 0)) == .send(start: 0))
        #expect(eleven.next(frame(luma(fill: 111), at: 0.25)) == .nothing)
        #expect(eleven.next(frame(luma(fill: 111), at: 1.25)) == .send(start: 0.25)) // 差 11
    }

    @Test("暗くなる向きの変化も数える（差の絶対値で比べる）")
    func darkeningIsCounted() {
        var detector = makeDetector()
        #expect(detector.next(frame(luma(fill: 100), at: 0)) == .send(start: 0))
        #expect(detector.next(frame(luma(fill: 89), at: 0.25)) == .nothing)
        #expect(detector.next(frame(luma(fill: 89), at: 1.25)) == .send(start: 0.25))
    }

    @Test("送った後の基準は、送った画面になる。元の画面に戻ったら、また送る")
    func baselineIsTheLastSentScreen() {
        var detector = makeDetector()
        #expect(detector.next(frame(luma(fill: 20), at: 0)) == .send(start: 0))
        #expect(detector.next(frame(luma(fill: 200), at: 1)) == .nothing)
        #expect(detector.next(frame(luma(fill: 200), at: 2)) == .send(start: 1))
        #expect(detector.next(frame(luma(fill: 200), at: 2.25)) == .nothing)
        #expect(detector.next(frame(luma(fill: 20), at: 3)) == .nothing)
        #expect(detector.next(frame(luma(fill: 20), at: 4)) == .send(start: 3)) // 全面が前の画面に戻るので、話している人の枠の抑えにはかけない
    }

    @Test("送らなかったフレームは基準にならない: 少しずつの差は、フレーム間ではなく最後に送った画面との差で積み上がる")
    func subThresholdChangesAccumulateAgainstLastSent() {
        // 40 マス（0.43%）だけ変わった画面は送らない。続けて別の 41 マスも変わると、
        // 最後に送った画面との差は 81 マス（0.88%）になって送る。直前のフレームとの差は 41 マスだけ
        let page = luma(fill: 240)
        let first = rewritten(page, firstCells: 40, to: 0)
        let second = rewritten(page, firstCells: 81, to: 0)

        var detector = makeDetector()
        #expect(detector.next(frame(page, at: 0)) == .send(start: 0))
        #expect(detector.next(frame(first, at: 0.25)) == .nothing)
        #expect(detector.next(frame(first, at: 1.25)) == .nothing)
        #expect(detector.next(frame(second, at: 1.5)) == .nothing)
        #expect(detector.next(frame(second, at: 2.5)) == .send(start: 1.5))
    }

    @Test("顔の小窓のゆっくりした動き（毎フレーム 4 ずつ）は、最後に送った画面との差が積み上がっても、動いている間は送らない")
    func slowFaceWindowMotionIsNeverSent() {
        // 10×10 = 100 マス（1.09%）が毎フレーム +4 ずつ明るくなる。フレーム間の差 4 は「動いた」（3 を超える）が、送る差（10）以下。
        // 最後に送った画面との差は 3 フレーム目で 12 を超えるが、動いているマスは比べないので、10 秒間一度も送らない
        let background = luma(fill: 60)
        var detector = makeDetector()
        #expect(detector.next(frame(background, at: 0)) == .send(start: 0))

        var sent: [Double] = []
        for step in 1...40 {
            let time = Double(step) * 0.25
            let current = rewritten(background, columns: 10, rows: 10, to: UInt8(60 + 4 * step))
            if case .send(let start) = detector.next(frame(current, at: time)) { sent.append(start) }
        }
        #expect(sent.isEmpty)
    }

    @Test("0.5% に満たない小さな領域は、大きく変わっても送らない（一度送った状態から、止まって 1 秒後でも）")
    func smallRegionChangeIsNotSent() {
        // 8×5 = 40 マス（0.43%）が真っ白から真っ黒に変わる
        let page = luma(fill: 255)
        let changed = rewritten(page, columns: 8, rows: 5, to: 0)
        var detector = makeDetector()
        #expect(detector.next(frame(page, at: 0)) == .send(start: 0))
        #expect(detector.next(frame(changed, at: 0.25)) == .nothing)
        #expect(detector.next(frame(changed, at: 1.25)) == .nothing)
    }

    @Test("会議アプリ本体ではウィンドウのタイトルを見ない: タイトルが変わっても画面が同じなら送らず、「なし」にもならない")
    func titleDoesNotAffectDecisionForMeetingApp() {
        var detector = makeDetector(zoomBundleID)
        #expect(detector.next(frame(luma(fill: 100), at: 0, title: "Zoom Meeting")) == .send(start: 0))
        #expect(detector.next(frame(luma(fill: 100), at: 0.25, title: otherTabTitle)) == .nothing)
        #expect(detector.next(frame(luma(fill: 100), at: 0.5, title: nil)) == .nothing)
        #expect(detector.next(frame(luma(fill: 100), at: 0.75, title: "")) == .nothing)
    }

    @Test("タイトルが同じでも、画面が変われば送る（会議アプリ本体）")
    func screenChangeIsSentRegardlessOfTitle() {
        var detector = makeDetector(zoomBundleID)
        #expect(detector.next(frame(luma(fill: 20), at: 0, title: "会議")) == .send(start: 0))
        #expect(detector.next(frame(luma(fill: 200), at: 0.25, title: "会議")) == .nothing)
        #expect(detector.next(frame(luma(fill: 200), at: 1.25, title: "会議")) == .send(start: 0.25))
    }
}

// 動いている場所を、比べる対象から外す（スクロール・動画・キャレット）。
@Suite("共有画面の判定器: 動いている場所を外す")
struct ScreenMotionExclusionTests {
    /// 行ごとの縞。`phase` が 1 つ進むと、全マスの輝度が入れ替わる（スクロール中の画面）。
    private func rowStripes(phase: Int) -> [UInt8] {
        var result = luma(fill: 0)
        for row in 0..<height {
            let value: UInt8 = (row + phase) % 2 == 0 ? 40 : 200
            for column in 0..<width { result[row * width + column] = value }
        }
        return result
    }

    /// 左上の 40×30 マス（13%）が、フレームごとに 40 と 200 を入れ替わる（動画）。ほかは 100。
    private func video(_ step: Int) -> [UInt8] {
        rewritten(luma(fill: 100), columns: 40, rows: 30, to: step % 2 == 0 ? 40 : 200)
    }

    @Test("スクロール（全面が毎フレーム変わる）は、動いている間は送らず、止まって 1 秒後に送る（止まる 0.75 秒後はまだ）")
    func scrollIsSentOneSecondAfterItStops() {
        var detector = makeDetector()
        #expect(detector.next(frame(rowStripes(phase: 0), at: 0)) == .send(start: 0))
        for step in 1...7 {
            #expect(detector.next(frame(rowStripes(phase: step), at: Double(step) * 0.25)) == .nothing, "step \(step)")
        }
        let stopped = rowStripes(phase: 7)
        #expect(detector.next(frame(stopped, at: 2.0)) == .nothing)
        #expect(detector.next(frame(stopped, at: 2.5)) == .nothing) // 止まって 0.75 秒
        #expect(detector.next(frame(stopped, at: 2.75)) == .send(start: 1.75)) // 止まって 1 秒。映り始めたのは最後に変わった時刻
    }

    @Test("動画（画面の 13% が毎フレーム変わる）は、動いている間は送らず、止まって 1 秒後に送る")
    func videoIsSentOneSecondAfterItStops() {
        var detector = makeDetector()
        #expect(detector.next(frame(video(0), at: 0)) == .send(start: 0))
        for step in 1...7 {
            #expect(detector.next(frame(video(step), at: Double(step) * 0.25)) == .nothing, "step \(step)")
        }
        #expect(detector.next(frame(video(7), at: 2.5)) == .nothing)
        #expect(detector.next(frame(video(7), at: 2.75)) == .send(start: 1.75))
    }

    @Test("OS が idle を出して輝度が変わらないフレームが続く場合も、前の輝度を今の時刻で入れ直せば、止まって 1 秒後に送る")
    func idleFramesAdvanceTimeWithPreviousLuma() {
        var detector = makeDetector()
        #expect(detector.next(frame(video(0), at: 0)) == .send(start: 0))
        for step in 1...7 {
            #expect(detector.next(frame(video(step), at: Double(step) * 0.25)) == .nothing, "step \(step)")
        }
        var previous: (luma: [UInt8], image: String)? = (luma: video(7), image: "image-7")
        var decisions: [ScreenDecision] = []
        for time in [2.0, 2.25, 2.5, 2.75] {
            let judged = screenFrameToJudge(
                .unchanged,
                previous: previous,
                render: {
                    Issue.record("idle のフレームでは輝度の画像を作り直さない")
                    return nil
                }
            )
            guard let judged else {
                Issue.record("前の輝度があれば、idle のフレームでも判定に入れる値が返る")
                return
            }
            previous = judged
            decisions.append(detector.next(frame(judged.luma, at: time)))
        }
        #expect(decisions == [.nothing, .nothing, .nothing, .send(start: 1.75)])
    }

    @Test("割合の分母は、動いている場所を外した後に比べたマスの数: 動画が動き続けていても、離れた 40 マスの文字（全体の 0.43%、比べたマスの 0.51%）は送る")
    func denominatorIsTheNumberOfComparedCells() {
        // 動画は左上の 40×30 マス。周り 2 マスまで外すと 42×32 = 1344 マスが外れ、比べるのは 7872 マス。
        // 文字は 80〜89 列 × 50〜53 行 = 40 マスで、動画から離れている。40 / 7872 = 0.508% は 0.5% を超えるが、40 / 9216 = 0.434% は超えない
        func page(_ step: Int, withText: Bool) -> [UInt8] {
            let base = video(step)
            return withText ? painted(base, column: 80, row: 50, columns: 10, rows: 4, to: 0) : base
        }
        var detector = makeDetector()
        #expect(detector.next(frame(page(0, withText: false), at: 0)) == .send(start: 0))
        // 0.25 秒に文字が現れ、動画は動き続ける。文字が止まって 1 秒（1.25 秒）で、動画が動いている最中でも送る
        for step in 1...4 {
            #expect(detector.next(frame(page(step, withText: true), at: Double(step) * 0.25)) == .nothing, "step \(step)")
        }
        #expect(detector.next(frame(page(5, withText: true), at: 1.25)) == .send(start: 0.25))
    }

    @Test("キャレット（1 マス）が点滅し続けても、2 マス離れた文字の追加は、止まって 1 秒後に送る（点は周り 1 マスまでしか外さない）")
    func blinkingCaretOnlyExcludesOneCellAround() {
        // キャレットは (40, 30) の 1 マス。文字は 42〜43 列 × 19〜42 行 = 48 マス（キャレットの 2 マス隣から）。
        // 48 マスは全体の 0.52% で、キャレットの周りを 2 マス外すと 43 マスに減って 0.5% を割る
        func caretPage(_ step: Int) -> [UInt8] {
            var page = luma(fill: 240)
            page[30 * width + 40] = step % 2 == 0 ? 0 : 255
            if step >= 4 { page = painted(page, column: 42, row: 19, columns: 2, rows: 24, to: 0) }
            return page
        }
        var detector = makeDetector()
        #expect(detector.next(frame(caretPage(0), at: 0)) == .send(start: 0))
        for step in 1...7 {
            #expect(detector.next(frame(caretPage(step), at: Double(step) * 0.25)) == .nothing, "step \(step)")
        }
        #expect(detector.next(frame(caretPage(8), at: 2.0)) == .send(start: 1.0))
    }

    /// 動画（20×20 マスの広く動く場所、60〜79 列 × 20〜39 行）の横に、`textColumn` 列の縦長の文字（48 マス）が現れる。
    /// 文字は 0.25 秒に現れ、動画は 2 秒まで動き続ける。時刻 0.25 秒ごとの判定を返す。
    private func decisionsWithTextBesideVideo(textColumn: Int) -> [ScreenDecision] {
        func screen(_ step: Int) -> [UInt8] {
            var page = painted(luma(fill: 100), column: 60, row: 20, columns: 20, rows: 20, to: step % 2 == 0 ? 40 : 200)
            if step >= 1 { page = painted(page, column: textColumn, row: 4, columns: 1, rows: 48, to: 0) }
            return page
        }
        var detector = makeDetector()
        _ = detector.next(frame(screen(0), at: 0))
        return (1...8).map { detector.next(frame(screen($0), at: Double($0) * 0.25)) }
    }

    @Test("広く動く場所の周り 2 マスは外す: 動画から 2 マス離れた文字（1 列の縦長）は、動画が動いている間は送らない")
    func wideMotionExcludesTwoCellsAround() {
        // 動画は 60 列から。58 列は 2 マス隣なので外れ、比べられる文字は 24 マス（0.28%）だけになる
        #expect(decisionsWithTextBesideVideo(textColumn: 58).allSatisfy { $0 == .nothing })
    }

    @Test("広く動く場所の周り 3 マスは外さない: 動画から 3 マス離れた文字は、止まって 1 秒後に送る")
    func wideMotionDoesNotExcludeThreeCellsAround() {
        let decisions = decisionsWithTextBesideVideo(textColumn: 57)
        #expect(decisions == [.nothing, .nothing, .nothing, .nothing, .send(start: 0.25), .nothing, .nothing, .nothing])
    }

    @Test("直近 10 秒によく動いていたマスは、止まって 1 秒たっても外したままにし、時間がたって平均が下がったら戻す")
    func frequentlyMovingCellsStayExcludedUntilAverageDecays() {
        var detector = makeDetector()
        #expect(detector.next(frame(video(0), at: 0)) == .send(start: 0))
        // 19 フレーム（4.75 秒）動き続ける。動いたフレームの割合の移動平均は約 0.38
        for step in 1...19 {
            #expect(detector.next(frame(video(step), at: Double(step) * 0.25)) == .nothing, "step \(step)")
        }
        let stopped = video(19)
        #expect(detector.next(frame(stopped, at: 5.75)) == .nothing) // 止まって 1 秒。平均は約 0.34 で、まだ 0.25 を超えている
        #expect(detector.next(frame(stopped, at: 14.75)) == .send(start: 4.75)) // 止まって 10 秒。平均は約 0.14
    }
}

// 話している人の枠の移動（前に送った画面のどれか 1 枚へそろって戻る）は送らない。
@Suite("共有画面の判定器: 話している人の枠")
struct ScreenSpeakerFrameTests {
    /// 4 人のタイル（2×2、各 64×36）のうち `speaker` 番目の下端に、64×4 マス（256 マス）の枠が付いた画面。
    private func tiles(speaker: Int) -> [UInt8] {
        painted(luma(fill: 100), column: (speaker % 2) * 64, row: (speaker / 2) * 36 + 32, columns: 64, rows: 4, to: 255)
    }

    @Test("最初の一巡（4 人）は送り、その後に前の画面へ戻る枠の移動は送らない")
    func speakerFrameMovementIsSuppressedAfterTheFirstRound() {
        var detector = makeDetector()
        #expect(detector.next(frame(tiles(speaker: 0), at: 0)) == .send(start: 0))
        #expect(detector.next(frame(tiles(speaker: 1), at: 1)) == .nothing)
        #expect(detector.next(frame(tiles(speaker: 1), at: 2)) == .send(start: 1))
        #expect(detector.next(frame(tiles(speaker: 2), at: 3)) == .nothing)
        #expect(detector.next(frame(tiles(speaker: 2), at: 4)) == .send(start: 3))
        #expect(detector.next(frame(tiles(speaker: 3), at: 5)) == .nothing)
        #expect(detector.next(frame(tiles(speaker: 3), at: 6)) == .send(start: 5))
        // 一巡した後は、どの枠も送らない
        #expect(detector.next(frame(tiles(speaker: 0), at: 7)) == .nothing)
        #expect(detector.next(frame(tiles(speaker: 0), at: 8)) == .nothing)
        #expect(detector.next(frame(tiles(speaker: 1), at: 9)) == .nothing)
        #expect(detector.next(frame(tiles(speaker: 1), at: 10)) == .nothing)
    }

    @Test("広い範囲が前の画面に戻るときは、前に送った画面と同じでも送る（スライド A → B → A）")
    func wideReturnToPreviousScreenIsSent() {
        var detector = makeDetector()
        #expect(detector.next(frame(luma(fill: 20), at: 0)) == .send(start: 0))
        #expect(detector.next(frame(luma(fill: 200), at: 1)) == .nothing)
        #expect(detector.next(frame(luma(fill: 200), at: 2)) == .send(start: 1))
        #expect(detector.next(frame(luma(fill: 20), at: 3)) == .nothing)
        #expect(detector.next(frame(luma(fill: 20), at: 4)) == .send(start: 3))
    }

    @Test("違うマスが全体の 10% 未満（921 マス）なら抑え、10% 以上（922 マス）なら、前の画面にそろっていても送る")
    func changedRatioBoundaryOfSpeakerFrame() {
        // 9216 マスの 10% は 921.6 マス
        func run(changedCells: Int) -> ScreenDecision {
            let original = luma(fill: 100)
            let changed = rewritten(original, firstCells: changedCells, to: 255)
            var detector = makeDetector()
            _ = detector.next(frame(original, at: 0))
            _ = detector.next(frame(changed, at: 1))
            _ = detector.next(frame(changed, at: 2)) // 送る（original には戻っていない）
            _ = detector.next(frame(original, at: 3))
            return detector.next(frame(original, at: 4))
        }
        #expect(run(changedCells: 921) == .nothing)
        #expect(run(changedCells: 922) == .send(start: 3))
    }

    @Test("前の画面との差が 6 以内なら「そろって同じ」、7 なら違う")
    func speakerFrameLumaToleranceBoundary() {
        func run(returnTo value: UInt8) -> ScreenDecision {
            let original = luma(fill: 100)
            let changed = rewritten(original, firstCells: 100, to: 255)
            var detector = makeDetector()
            _ = detector.next(frame(original, at: 0))
            _ = detector.next(frame(changed, at: 1))
            _ = detector.next(frame(changed, at: 2)) // 送る
            let returned = rewritten(original, firstCells: 100, to: value)
            _ = detector.next(frame(returned, at: 3))
            return detector.next(frame(returned, at: 4))
        }
        #expect(run(returnTo: 106) == .nothing) // original との差 6
        #expect(run(returnTo: 107) == .send(start: 3)) // original との差 7
    }

    @Test("違うマスは、マスごとに別々の画面と同じではなく、すべてのマスが 1 枚の同じ画面にそろったときだけ抑える")
    func differingCellsMustMatchOneScreenTogether() {
        // 領域 A（0〜59 マス）と B（60〜119 マス）。P は A だけ、Q は B だけが明るい。T は A も B も暗い。
        // R は A も B も明るい。T との違いは A と B で、A は P と、B は Q とそろうが、1 枚でそろう画面は無い
        let base = luma(fill: 100)
        func regions(a: UInt8, b: UInt8) -> [UInt8] {
            var result = base
            for index in 0..<60 { result[index] = a }
            for index in 60..<120 { result[index] = b }
            return result
        }
        var detector = makeDetector()
        #expect(detector.next(frame(regions(a: 100, b: 100), at: 0)) == .send(start: 0))
        // 画面を切り替えたフレームから 0.25 秒おきに 2 秒分入れる: 止まって 1 秒の 4 フレーム目に送り、その後は何も送らない
        func switchTo(_ screen: [UInt8], at time: Double) -> [ScreenDecision] {
            (0..<8).map { detector.next(frame(screen, at: time + Double($0) * 0.25)) }
        }
        func expected(start: Double) -> [ScreenDecision] {
            [.nothing, .nothing, .nothing, .nothing, .send(start: start), .nothing, .nothing, .nothing]
        }
        #expect(switchTo(regions(a: 255, b: 100), at: 2) == expected(start: 2))
        #expect(switchTo(regions(a: 100, b: 255), at: 4) == expected(start: 4))
        #expect(switchTo(regions(a: 50, b: 50), at: 6) == expected(start: 6))
        #expect(switchTo(regions(a: 255, b: 255), at: 8) == expected(start: 8))
    }

    @Test("覚えているのは、直近 30 枚の送った画面: 30 枚目に当たる画面には戻っても抑え、31 枚目に当たる画面は送る")
    func sentHistoryKeepsTheLatestThirtyScreens() {
        // 画面 k は、8×8 マスのブロック k だけが明るい。32 枚（k = 0〜31）を順に送ると、覚えているのは k = 2〜31 の 30 枚
        func screen(_ k: Int) -> [UInt8] {
            painted(luma(fill: 100), column: (k % 16) * 8, row: (k / 16) * 8, columns: 8, rows: 8, to: 255)
        }
        var detector = makeDetector()
        var sent: [Double] = []
        for k in 0..<32 {
            for time in [Double(2 * k), Double(2 * k + 1)] {
                if case .send(let start) = detector.next(frame(screen(k), at: time)) { sent.append(start) }
            }
        }
        #expect(sent == (0..<32).map { Double(2 * $0) })

        // 画面 2（30 枚目）は覚えているので抑える
        #expect(detector.next(frame(screen(2), at: 64)) == .nothing)
        #expect(detector.next(frame(screen(2), at: 65)) == .nothing)
        // 画面 1（31 枚目）は忘れているので送る。違うマスは、画面 31 の 64 マス（64 秒に暗くなった）と画面 1 の 64 マス（66 秒に明るくなった）で、時刻の中央値は 65
        #expect(detector.next(frame(screen(1), at: 66)) == .nothing)
        #expect(detector.next(frame(screen(1), at: 67)) == .send(start: 65))
    }
}

// 映り始めた時刻（違うマスが今の値になった時刻の中央値）。
@Suite("共有画面の判定器: 映り始めた時刻")
struct ScreenStartTimeTests {
    @Test("映り始めた時刻は、違うマスが今の値になった時刻の中央値（最初でも最後でも平均でもない）")
    func startIsMedianOfCellChangeTimes() {
        // 15 マスが 1 秒、25 マスが 2 秒、10 マスが 3 秒に変わる（合わせて 50 マス = 0.54%）。中央値は 2、平均は 1.9
        let base = luma(fill: 100)
        var detector = makeDetector()
        #expect(detector.next(frame(base, at: 0)) == .send(start: 0))
        #expect(detector.next(frame(rewritten(base, firstCells: 15, to: 200), at: 1)) == .nothing)
        #expect(detector.next(frame(rewritten(base, firstCells: 40, to: 200), at: 2)) == .nothing)
        let final = rewritten(base, firstCells: 50, to: 200)
        #expect(detector.next(frame(final, at: 3)) == .nothing)
        #expect(detector.next(frame(final, at: 4)) == .send(start: 2))
    }

    @Test("覚えている値から 10 以内の変化では、値になった時刻を更新しない（150 に変わった 0.25 秒が、158 になった 0.5 秒ではなく残る）")
    func smallDriftKeepsTheChangeTime() {
        let base = luma(fill: 100)
        var detector = makeDetector()
        #expect(detector.next(frame(base, at: 0)) == .send(start: 0))
        #expect(detector.next(frame(rewritten(base, firstCells: 50, to: 150), at: 0.25)) == .nothing)
        #expect(detector.next(frame(rewritten(base, firstCells: 50, to: 158), at: 0.5)) == .nothing)
        #expect(detector.next(frame(rewritten(base, firstCells: 50, to: 158), at: 1.5)) == .send(start: 0.25))
    }

    @Test("映り始めた時刻は、前に送ると決めたフレームの時刻より前にならない")
    func startIsNeverBeforeThePreviousSentTime() {
        let base = luma(fill: 100)
        var detector = makeDetector()
        #expect(detector.next(frame(base, at: 0)) == .send(start: 0))
        #expect(detector.next(frame(rewritten(base, firstCells: 50, to: 150), at: 0.25)) == .nothing)
        #expect(detector.next(frame(rewritten(base, firstCells: 50, to: 158), at: 0.5)) == .nothing)
        #expect(detector.next(frame(rewritten(base, firstCells: 50, to: 158), at: 1.5)) == .send(start: 0.25))
        // 150 から 10 以内（147）に変わっても、覚えている値の時刻は 0.25 のまま。前に送ると決めた 1.5 より前にはしない
        #expect(detector.next(frame(rewritten(base, firstCells: 50, to: 147), at: 2)) == .nothing)
        #expect(detector.next(frame(rewritten(base, firstCells: 50, to: 147), at: 3)) == .send(start: 1.5))
    }
}

// ブラウザのタブが会議のものでなくなったら「なし」を返す。
@Suite("共有画面の判定器: 会議以外のタブ（ブラウザ）")
struct ScreenBrowserTabTests {
    @Test("ブラウザで会議以外のタイトルになると「なし」を返し、続けて同じ状態でも、もう一度は返さない")
    func nonMeetingTabReturnsNoneOnce() {
        var detector = makeDetector(chromeBundleID)
        let page = luma(fill: 100)
        #expect(detector.next(frame(page, at: 0, title: meetTitle)) == .send(start: 0))
        #expect(detector.next(frame(page, at: 0.25, title: meetTitle)) == .nothing)
        #expect(detector.next(frame(page, at: 0.5, title: otherTabTitle)) == .none(start: 0.5))
        #expect(detector.next(frame(page, at: 0.75, title: otherTabTitle)) == .nothing)
        #expect(detector.next(frame(luma(fill: 200), at: 1, title: otherTabTitle)) == .nothing)
    }

    @Test("会議のタブに戻ったら、前と同じ画面でも、すぐ次の画面を送る")
    func returningToMeetingTabSendsImmediately() {
        var detector = makeDetector(chromeBundleID)
        let page = luma(fill: 100)
        #expect(detector.next(frame(page, at: 0, title: meetTitle)) == .send(start: 0))
        #expect(detector.next(frame(page, at: 1, title: otherTabTitle)) == .none(start: 1))
        #expect(detector.next(frame(page, at: 2, title: meetTitle)) == .send(start: 2))
        #expect(detector.next(frame(page, at: 2.25, title: meetTitle)) == .nothing)
    }

    @Test("会議のタブに戻った最初の画面は、話している人の枠の抑えにかけずに送る")
    func returningToMeetingTabSkipsSpeakerFrameSuppression() {
        func tiles(speaker: Int) -> [UInt8] {
            painted(luma(fill: 100), column: (speaker % 2) * 64, row: (speaker / 2) * 36 + 32, columns: 64, rows: 4, to: 255)
        }
        var detector = makeDetector(chromeBundleID)
        #expect(detector.next(frame(tiles(speaker: 0), at: 0, title: meetTitle)) == .send(start: 0))
        #expect(detector.next(frame(tiles(speaker: 1), at: 1, title: meetTitle)) == .nothing)
        #expect(detector.next(frame(tiles(speaker: 1), at: 2, title: meetTitle)) == .send(start: 1))
        // 画面 0 への枠の移動は、普通なら抑える
        #expect(detector.next(frame(tiles(speaker: 0), at: 3, title: meetTitle)) == .nothing)
        #expect(detector.next(frame(tiles(speaker: 0), at: 4, title: meetTitle)) == .nothing)
        #expect(detector.next(frame(tiles(speaker: 0), at: 5, title: otherTabTitle)) == .none(start: 5))
        #expect(detector.next(frame(tiles(speaker: 0), at: 6, title: meetTitle)) == .send(start: 6))
    }

    @Test("画像を一度も送っていないときに会議以外のタイトルが来ても何も返さず、会議のタブになった最初のフレームを送る")
    func nonMeetingTabBeforeAnySendIsNothing() {
        var detector = makeDetector(chromeBundleID)
        let page = luma(fill: 100)
        #expect(detector.next(frame(page, at: 0, title: otherTabTitle)) == .nothing)
        #expect(detector.next(frame(page, at: 0.25, title: otherTabTitle)) == .nothing)
        #expect(detector.next(frame(page, at: 1, title: meetTitle)) == .send(start: 1))
    }

    @Test("ブラウザでタイトルが読めない（nil・空）ときは、会議のタブとして画像で判定する（「なし」にしない）")
    func unreadableTitleDoesNotReturnNone() {
        var detector = makeDetector(chromeBundleID)
        let page = luma(fill: 100)
        #expect(detector.next(frame(page, at: 0, title: nil)) == .send(start: 0))
        #expect(detector.next(frame(page, at: 0.25, title: nil)) == .nothing)
        #expect(detector.next(frame(page, at: 0.5, title: "")) == .nothing)
    }

    @Test("会議アプリ本体（Zoom）では、タイトルが会議以外に変わっても「なし」にならず、同じ画面は送らない")
    func meetingAppNeverReturnsNoneForTitle() {
        var detector = makeDetector(zoomBundleID)
        let page = luma(fill: 100)
        #expect(detector.next(frame(page, at: 0, title: meetTitle)) == .send(start: 0))
        #expect(detector.next(frame(page, at: 0.25, title: otherTabTitle)) == .nothing)
        #expect(detector.next(frame(page, at: 0.5, title: otherTabTitle)) == .nothing)
        #expect(detector.next(frame(page, at: 0.75, title: meetTitle)) == .nothing)
    }

    @Test("会議以外のタブの間に溜めた動きの記録は消える: 戻った後、動いていた平均を引きずらずに、止まって 1 秒後に送る")
    func motionRecordIsClearedWhenWindowIsGone() {
        var detector = ScreenChangeDetector(bundleID: zoomBundleID)
        #expect(detector.next(frame(luma(fill: 100), at: 0)) == .send(start: 0))
        // 全面が 19 フレーム動き続ける。移動平均は約 0.38
        for step in 1...19 {
            #expect(detector.next(frame(luma(fill: step % 2 == 0 ? 100 : 160), at: Double(step) * 0.25)) == .nothing, "step \(step)")
        }
        #expect(detector.next(.windowGone(time: 5)) == .none(start: 5))
        #expect(detector.next(frame(luma(fill: 100), at: 5.25)) == .send(start: 5.25))
        #expect(detector.next(frame(luma(fill: 200), at: 6)) == .nothing)
        #expect(detector.next(frame(luma(fill: 200), at: 7)) == .send(start: 6))
    }
}

// idle のフレームから、判定器に入れる値を決める純粋な関数。
@Suite("共有画面: 判定に入れるフレーム（screenFrameToJudge）")
struct ScreenFrameToJudgeTests {
    private let previous: (luma: [UInt8], image: String)? = (luma: [1, 2, 3], image: "previous")

    @Test("画像が更新されたフレームは、輝度の画像を作り直した結果を使う")
    func updatedRendersTheFrame() {
        var renderCount = 0
        let judged = screenFrameToJudge(
            .updated,
            previous: previous,
            render: {
                renderCount += 1
                return (luma: [9, 9], image: "rendered")
            }
        )
        #expect(judged?.luma == [9, 9])
        #expect(judged?.image == "rendered")
        #expect(renderCount == 1)
    }

    @Test("更新されたのに輝度の画像を作れなかったときは nil（前の値で代用しない）")
    func updatedWithoutRenderResultIsNil() {
        let judged = screenFrameToJudge(.updated, previous: previous, render: { nil })
        #expect(judged == nil)
    }

    @Test("画像が変わっていない（idle）フレームは、輝度の画像を作り直さず、前の輝度と画像をそのまま返す")
    func unchangedReusesPreviousWithoutRendering() {
        var renderCount = 0
        let judged = screenFrameToJudge(
            .unchanged,
            previous: previous,
            render: {
                renderCount += 1
                return (luma: [9, 9], image: "rendered")
            }
        )
        #expect(judged?.luma == [1, 2, 3])
        #expect(judged?.image == "previous")
        #expect(renderCount == 0)
    }

    @Test("変わっていないフレームでも、前の値が無ければ nil（輝度の画像も作らない）")
    func unchangedWithoutPreviousIsNil() {
        var renderCount = 0
        let judged: (luma: [UInt8], image: String)? = screenFrameToJudge(
            .unchanged,
            previous: nil,
            render: {
                renderCount += 1
                return (luma: [9, 9], image: "rendered")
            }
        )
        #expect(judged == nil)
        #expect(renderCount == 0)
    }

    @Test("使えないフレームは nil で、輝度の画像も作らない")
    func unusableIsNil() {
        var renderCount = 0
        let judged = screenFrameToJudge(
            .unusable,
            previous: previous,
            render: {
                renderCount += 1
                return (luma: [9, 9], image: "rendered")
            }
        )
        #expect(judged == nil)
        #expect(renderCount == 0)
    }
}

@Suite("共有画面の判定器: ウィンドウが無くなったとき")
struct ScreenWindowGoneTests {
    @Test("画像を送った後にウィンドウが無くなると「なし」を返し、無くなった時刻を持つ")
    func windowGoneAfterSendReturnsNone() {
        var detector = makeDetector()
        #expect(detector.next(frame(luma(fill: 100), at: 0)) == .send(start: 0))
        #expect(detector.next(.windowGone(time: 3.5)) == .none(start: 3.5))
    }

    @Test("「なし」の後に同じ中身のフレームが映ったら、また送る（基準を消している）")
    func frameAfterGoneIsSentEvenIfIdentical() {
        var detector = makeDetector()
        #expect(detector.next(frame(luma(fill: 100), at: 0)) == .send(start: 0))
        #expect(detector.next(.windowGone(time: 3)) == .none(start: 3))
        #expect(detector.next(frame(luma(fill: 100), at: 4)) == .send(start: 4))
        #expect(detector.next(frame(luma(fill: 100), at: 4.25)) == .nothing)
    }

    @Test("すでに「なし」を返した後に、ウィンドウが無いという入力が続いても、何もしない")
    func repeatedGoneIsNothing() {
        var detector = makeDetector()
        #expect(detector.next(frame(luma(fill: 100), at: 0)) == .send(start: 0))
        #expect(detector.next(.windowGone(time: 3)) == .none(start: 3))
        #expect(detector.next(.windowGone(time: 3.25)) == .nothing)
    }

    @Test("画像を一度も送っていないときにウィンドウが無くなっても、何もしない")
    func goneBeforeAnySendIsNothing() {
        var detector = makeDetector()
        #expect(detector.next(.windowGone(time: 1)) == .nothing)
        // その後の最初のフレームは、最初のフレームとして送る
        #expect(detector.next(frame(luma(fill: 100), at: 2)) == .send(start: 2))
    }
}

@Suite("共有画面を撮るウィンドウの選び方")
struct ScreenWindowSelectionTests {
    private func candidate(_ id: UInt32, _ bundleID: String?, onScreen: Bool = true, _ width: Double, _ height: Double) -> ScreenWindowCandidate {
        ScreenWindowCandidate(id: id, bundleID: bundleID, isOnScreen: onScreen, width: width, height: height)
    }

    @Test("bundle id が一致するウィンドウのうち、面積が最大のものを選ぶ（幅や高さの最大ではなく面積）")
    func picksLargestAreaAmongMatching() {
        let windows = [
            candidate(1, "com.google.Chrome", 1000, 100), // 面積 100,000（幅が最大）
            candidate(2, "com.google.Chrome", 400, 400), // 面積 160,000
            candidate(3, "com.google.Chrome", 300, 300), // 面積 90,000
            candidate(4, "us.zoom.xos", 3000, 2000), // 別のアプリ（面積はもっと大きい）
        ]
        #expect(selectScreenWindow(bundleID: "com.google.Chrome", among: windows)?.id == 2)
    }

    @Test("画面に出ていないウィンドウは選ばない（面積が最大でも）")
    func skipsWindowsNotOnScreen() {
        let windows = [
            candidate(1, "us.zoom.xos", onScreen: false, 2000, 1500),
            candidate(2, "us.zoom.xos", 800, 600),
        ]
        #expect(selectScreenWindow(bundleID: "us.zoom.xos", among: windows)?.id == 2)
    }

    @Test("bundle id は完全に一致したものだけ。前方一致するだけの別のアプリは選ばない")
    func requiresExactBundleIdentifier() {
        let windows = [
            candidate(1, "com.google.ChromeCanary", 2000, 1500),
            candidate(2, "com.google.Chrome", 100, 100),
        ]
        #expect(selectScreenWindow(bundleID: "com.google.Chrome", among: windows)?.id == 2)
        #expect(selectScreenWindow(bundleID: "com.google.Chrome", among: [windows[0]]) == nil)
    }

    @Test("持ち主の bundle id が分からないウィンドウは選ばない")
    func skipsWindowsWithoutOwner() {
        let windows = [candidate(1, nil, 2000, 1500)]
        #expect(selectScreenWindow(bundleID: "us.zoom.xos", among: windows) == nil)
    }

    @Test("一致するウィンドウが無ければ nil")
    func noMatchReturnsNil() {
        #expect(selectScreenWindow(bundleID: "us.zoom.xos", among: []) == nil)
        #expect(selectScreenWindow(bundleID: "us.zoom.xos", among: [candidate(1, "com.apple.Safari", 800, 600)]) == nil)
    }
}

@Suite("共有画面のウィンドウの探し直し")
struct ScreenWindowSearchTests {
    private func candidate(_ id: UInt32, _ bundleID: String?, onScreen: Bool = true, _ width: Double, _ height: Double) -> ScreenWindowCandidate {
        ScreenWindowCandidate(id: id, bundleID: bundleID, isOnScreen: onScreen, width: width, height: height)
    }

    private let zoom = "us.zoom.xos"

    @Test("探し直す間隔は名前の付いた値で 2 秒")
    func namedRetryInterval() {
        #expect(screenWindowRetryInterval == 2.0)
    }

    @Test("未開始で候補が無い（空・別のアプリだけ・画面に出ていないものだけ）と、間隔を置いて探し直す")
    func notStartedWithoutCandidateRetries() {
        let cases: [[ScreenWindowCandidate]] = [
            [],
            [candidate(1, "com.apple.Safari", 800, 600)],
            [candidate(2, "us.zoom.xos", onScreen: false, 800, 600)],
            [candidate(3, nil, 800, 600)],
        ]
        for windows in cases {
            #expect(nextScreenWindowAction(bundleID: zoom, state: .notStarted, among: windows) == .retry(after: screenWindowRetryInterval))
        }
    }

    @Test("未開始で候補があれば、同じアプリの画面に出ているもののうち面積が最大のもので取り込みを始める")
    func notStartedStartsWithLargestOnScreenWindow() {
        let windows = [
            candidate(1, zoom, 1000, 100), // 面積 100,000
            candidate(2, zoom, 400, 400), // 面積 160,000
            candidate(3, zoom, onScreen: false, 3000, 2000), // 画面に出ていない
            candidate(4, "com.google.Chrome", 3000, 2000), // 別のアプリ
        ]
        #expect(nextScreenWindowAction(bundleID: zoom, state: .notStarted, among: windows) == .startCapture(windowID: 2))
    }

    @Test("撮っているウィンドウが候補に残っていれば、何もしない（ほかに大きいウィンドウがあっても乗り換えない）")
    func capturingWithWindowPresentDoesNothing() {
        let windows = [candidate(5, zoom, 400, 300), candidate(6, zoom, 2000, 1500)]
        #expect(nextScreenWindowAction(bundleID: zoom, state: .capturing(windowID: 5), among: windows) == .nothing)
    }

    @Test("撮っているウィンドウが候補に残っていれば、画面に出ていなくても何もしない（止まった経路は別の担当）")
    func capturingWithWindowPresentButOffScreenDoesNothing() {
        let windows = [candidate(5, zoom, onScreen: false, 400, 300)]
        #expect(nextScreenWindowAction(bundleID: zoom, state: .capturing(windowID: 5), among: windows) == .nothing)
    }

    @Test("撮っているウィンドウが無くなり、ほかの候補も無ければ、間隔を置いて探し直す")
    func capturingWindowGoneWithoutCandidateRetries() {
        #expect(nextScreenWindowAction(bundleID: zoom, state: .capturing(windowID: 5), among: []) == .retry(after: screenWindowRetryInterval))
        let others = [candidate(9, "com.apple.Safari", 800, 600)]
        #expect(nextScreenWindowAction(bundleID: zoom, state: .capturing(windowID: 5), among: others) == .retry(after: screenWindowRetryInterval))
    }

    @Test("撮っているウィンドウが無くなり、別の id の候補があれば、その id で取り込みを始める")
    func capturingWindowGoneStartsWithDifferentWindow() {
        let windows = [candidate(7, zoom, 300, 300), candidate(8, zoom, 600, 400)]
        #expect(nextScreenWindowAction(bundleID: zoom, state: .capturing(windowID: 5), among: windows) == .startCapture(windowID: 8))
    }

    @Test("無くなった状態で候補が無ければ探し直し、候補があれば前と違う id でも取り込みを始める")
    func windowGoneStateRetriesThenStarts() {
        #expect(nextScreenWindowAction(bundleID: zoom, state: .windowGone, among: []) == .retry(after: screenWindowRetryInterval))
        let windows = [candidate(42, zoom, 800, 600)]
        #expect(nextScreenWindowAction(bundleID: zoom, state: .windowGone, among: windows) == .startCapture(windowID: 42))
    }

    @Test("探し直しの結果は何度呼んでも同じ（回数で諦めない）")
    func retryHasNoLimit() {
        for _ in 0..<1000 {
            #expect(nextScreenWindowAction(bundleID: zoom, state: .notStarted, among: []) == .retry(after: screenWindowRetryInterval))
        }
    }
}

@Suite("送る画像の大きさ")
struct ScreenFitSizeTests {
    @Test("1280×720 に収まるように、縦横の比を保って縮める")
    func shrinksKeepingAspectRatio() {
        var size = fitScreenSize(width: 1920, height: 1080)
        #expect(size.width == 1280 && size.height == 720)
        size = fitScreenSize(width: 2560, height: 1440)
        #expect(size.width == 1280 && size.height == 720)
        // 幅が先に収まる縦長
        size = fitScreenSize(width: 1000, height: 2000)
        #expect(size.width == 360 && size.height == 720)
        // 高さに余裕のある横長（切り捨て）
        size = fitScreenSize(width: 3000, height: 1000)
        #expect(size.width == 1280 && size.height == 426)
        // 縮める倍率は幅と高さの小さい方
        size = fitScreenSize(width: 1500, height: 1000)
        #expect(size.width == 1080 && size.height == 720)
    }

    @Test("小さい画像は拡大しない")
    func doesNotEnlarge() {
        let size = fitScreenSize(width: 640, height: 360)
        #expect(size.width == 640 && size.height == 360)
    }

    @Test("極端に細長くても、1 未満にはしない")
    func neverBelowOne() {
        let size = fitScreenSize(width: 1, height: 5000)
        #expect(size.width == 1 && size.height == 720)
    }
}

@Suite("共有画面の判定器: 画像の生成とイベント化")
struct ScreenEventTests {
    @Test("画像の生成に失敗したら送らず、同じフレームの次の機会に送り直す（最後に送った画面は、送った画面だけ）")
    func failedEncodeIsRetriedWithSameFrame() {
        var detector = makeDetector()
        let a = ScreenFrame(luma: luma(fill: 20), time: 0, title: nil)
        let moving = ScreenFrame(luma: luma(fill: 200), time: 1.25, title: nil)
        let b = ScreenFrame(luma: luma(fill: 200), time: 2.25, title: nil)
        #expect(detector.screenEvent(for: a) { "A" } == .screen(start: 0, image: "A"))
        #expect(detector.screenEvent(for: moving) { "動いている間は作らない" } == nil)
        #expect(detector.screenEvent(for: b) { nil } == nil)
        #expect(detector.screenEvent(for: b) { "B" } == .screen(start: 1.25, image: "B"))
    }

    @Test("「なし」のときは画像を作らず、image: null のイベントを 1 回だけ返す（ブラウザの会議以外のタブ）")
    func nonMeetingTabEventHasNullImageWithoutEncoding() {
        var detector = makeDetector(chromeBundleID)
        let a = ScreenFrame(luma: luma(fill: 20), time: 0, title: meetTitle)
        let gone = ScreenFrame(luma: luma(fill: 20), time: 0.25, title: otherTabTitle)
        var encodeCount = 0
        #expect(detector.screenEvent(for: a) { "A" } == .screen(start: 0, image: "A"))
        #expect(detector.screenEvent(for: gone) { encodeCount += 1; return "X" } == .screen(start: 0.25, image: nil))
        #expect(detector.screenEvent(for: gone) { encodeCount += 1; return "X" } == nil)
        #expect(detector.screenEvent(windowGoneAt: 1) == nil)
        #expect(encodeCount == 0)
    }

    @Test("送らないフレームでは画像を作らない")
    func noEncodeWhenNotSending() {
        var detector = makeDetector()
        let a = ScreenFrame(luma: luma(fill: 20), time: 0, title: nil)
        var encodeCount = 0
        #expect(detector.screenEvent(for: a) { "A" } == .screen(start: 0, image: "A"))
        #expect(detector.screenEvent(for: a) { encodeCount += 1; return "A" } == nil)
        #expect(encodeCount == 0)
    }

    @Test("最初のフレームの生成に失敗しても、基準は空のまま（次のフレームを最初として送る）")
    func failedFirstEncodeKeepsNoBaseline() {
        var detector = makeDetector()
        let a = ScreenFrame(luma: luma(fill: 20), time: 0, title: nil)
        #expect(detector.screenEvent(for: a) { nil } == nil)
        #expect(detector.screenEvent(for: a) { "A" } == .screen(start: 0, image: "A"))
    }

    @Test("ウィンドウが無くなったら image: null のイベントを 1 回だけ返す。重複した通知や、何も送っていないときは nil")
    func windowGoneEventIsEmittedOnce() {
        var detector = makeDetector()
        #expect(detector.screenEvent(windowGoneAt: 1) == nil)
        let a = ScreenFrame(luma: luma(fill: 20), time: 0, title: nil)
        #expect(detector.screenEvent(for: a) { "A" } == .screen(start: 0, image: "A"))
        #expect(detector.screenEvent(windowGoneAt: 3) == .screen(start: 3, image: nil))
        #expect(detector.screenEvent(windowGoneAt: 3.25) == nil)
    }
}

/// `b` の画像の生成の最中に、別スレッドから `emitWindowGone` を呼ぶ。同期関数にして、スレッドの待ち合わせをここで行う。
private func emitWithWindowGoneDuringEncode(_ emitter: ScreenEventEmitter, frame b: ScreenFrame, goneAt time: Double) {
    let started = DispatchSemaphore(value: 0)
    let done = DispatchSemaphore(value: 0)
    emitter.emit(b) {
        Thread {
            started.signal()
            emitter.emitWindowGone(at: time)
            done.signal()
        }.start()
        _ = started.wait(timeout: .now() + 5)
        // 別スレッドが emitWindowGone に入る機会を与えてから画像を返す。
        Thread.sleep(forTimeInterval: 0.05)
        return "B"
    }
    // 同期の退行でスイートが止まらないよう、待ちには期限を付ける。
    _ = done.wait(timeout: .now() + 5)
}

private func collect(_ emitter: ScreenEventEmitter) async -> [HelperEvent] {
    emitter.close()
    var result: [HelperEvent] = []
    for await event in emitter.events { result.append(event) }
    return result
}

@Suite("共有画面のイベントの送出順")
struct ScreenEventEmitterTests {
    @Test("判定した順（画像 → 消失の null → 画像）のまま events に出る")
    func sequentialOrder() async {
        let emitter = ScreenEventEmitter(bundleID: zoomBundleID)
        emitter.emit(ScreenFrame(luma: luma(fill: 20), time: 0, title: nil)) { "A" }
        emitter.emitWindowGone(at: 3)
        emitter.emit(ScreenFrame(luma: luma(fill: 200), time: 1, title: nil)) { "B" }
        let events = await collect(emitter)
        #expect(events == [.screen(start: 0, image: "A"), .screen(start: 3, image: nil), .screen(start: 1, image: "B")])
    }

    @Test("画像の生成の途中で別スレッドから消失が来ても、null は画像の後に出る（最後の保持値が null になる）")
    func windowGoneDuringEncodeComesAfterImage() async {
        let emitter = ScreenEventEmitter(bundleID: zoomBundleID)
        emitter.emit(ScreenFrame(luma: luma(fill: 20), time: 0, title: nil)) { "A" }
        // 変わったフレームは動いている間なので送らない（画像も作らない）。止まって 1 秒後のフレームで送る
        emitter.emit(ScreenFrame(luma: luma(fill: 200), time: 1, title: nil)) { "動いている間は作らない" }
        emitWithWindowGoneDuringEncode(emitter, frame: ScreenFrame(luma: luma(fill: 200), time: 2, title: nil), goneAt: 5)
        let events = await collect(emitter)
        #expect(events == [.screen(start: 0, image: "A"), .screen(start: 1, image: "B"), .screen(start: 5, image: nil)])
    }

    @Test("ブラウザで会議以外のタブになると、image: null の screen が 1 回だけ出て、会議のタブに戻ると次の画面が出る")
    func nonMeetingTabEmitsNullOnceThenReturns() async {
        let emitter = ScreenEventEmitter(bundleID: chromeBundleID)
        let page = luma(fill: 20)
        emitter.emit(ScreenFrame(luma: page, time: 0, title: meetTitle)) { "A" }
        emitter.emit(ScreenFrame(luma: page, time: 0.25, title: otherTabTitle)) { "画像は作らない" }
        emitter.emit(ScreenFrame(luma: page, time: 0.5, title: otherTabTitle)) { "画像は作らない" }
        emitter.emit(ScreenFrame(luma: page, time: 0.75, title: meetTitle)) { "A2" }
        let events = await collect(emitter)
        #expect(events == [.screen(start: 0, image: "A"), .screen(start: 0.25, image: nil), .screen(start: 0.75, image: "A2")])
    }

    @Test("画像を一度も送っていないときに会議以外のタブが来ても、何も出ない")
    func nonMeetingTabBeforeAnyImageEmitsNothing() async {
        let emitter = ScreenEventEmitter(bundleID: chromeBundleID)
        emitter.emit(ScreenFrame(luma: luma(fill: 20), time: 0, title: otherTabTitle)) { "画像は作らない" }
        let events = await collect(emitter)
        #expect(events.isEmpty)
    }

    @Test("会議アプリ本体では、タイトルが会議以外に変わっても null の screen は出ない")
    func meetingAppTitleChangeEmitsNoNull() async {
        let emitter = ScreenEventEmitter(bundleID: zoomBundleID)
        let page = luma(fill: 20)
        emitter.emit(ScreenFrame(luma: page, time: 0, title: meetTitle)) { "A" }
        emitter.emit(ScreenFrame(luma: page, time: 0.25, title: otherTabTitle)) { "画像は作らない" }
        let events = await collect(emitter)
        #expect(events == [.screen(start: 0, image: "A")])
    }

    @Test("会議以外のタブで null を出した後に取り込みが止まっても、null は重ねず screen-off だけが続く")
    func captureStoppedAfterNonMeetingTabDoesNotRepeatNull() async {
        let emitter = ScreenEventEmitter(bundleID: chromeBundleID)
        let page = luma(fill: 20)
        emitter.emit(ScreenFrame(luma: page, time: 0, title: meetTitle)) { "A" }
        emitter.emit(ScreenFrame(luma: page, time: 1, title: otherTabTitle)) { "画像は作らない" }
        emitter.emitCaptureStopped(at: 2)
        let events = await collect(emitter)
        #expect(events == [.screen(start: 0, image: "A"), .screen(start: 1, image: nil), .screenOff(start: 2, reason: .許可なし)])
    }

    // Issue #421: 撮っていたウィンドウが無くなっても終わらずに探し直し、見つけ直したウィンドウの最初の画面を送る。
    @Test("ウィンドウが消えて見つけ直すと、画像 → null（重なった通知でも 1 回）→ 見つけ直した最初の画像（前と同じ画像でも）の順で、screen-off は出ない")
    func windowGoneThenRediscoveredSendsNullOnceThenFirstFrame() async {
        let emitter = ScreenEventEmitter(bundleID: zoomBundleID)
        emitter.emit(ScreenFrame(luma: luma(fill: 20), time: 0, title: nil)) { "A" }
        emitter.emitWindowGone(at: 3) // streamDidBecomeInactive
        emitter.emitWindowGone(at: 3.25) // handleStop（重なった通知）
        emitter.emit(ScreenFrame(luma: luma(fill: 20), time: 8, title: nil)) { "A2" } // 見つけ直したウィンドウの最初のフレーム（輝度は前と同じ）
        let events = await collect(emitter)
        #expect(events == [.screen(start: 0, image: "A"), .screen(start: 3, image: nil), .screen(start: 8, image: "A2")])
        #expect(!events.contains { if case .screenOff = $0 { return true } else { return false } })
    }

    @Test("開始時に見つからず何も送っていない emitter でも、後から見つかった最初のフレームは送る")
    func firstFrameAfterLateDiscoverySends() async {
        let emitter = ScreenEventEmitter(bundleID: zoomBundleID)
        emitter.emitWindowGone(at: 1)
        emitter.emit(ScreenFrame(luma: luma(fill: 20), time: 6, title: nil)) { "A" }
        let events = await collect(emitter)
        #expect(events == [.screen(start: 6, image: "A")])
    }

    @Test("終了後は何も送らず、画像も作らない")
    func nothingAfterClose() async {
        let emitter = ScreenEventEmitter(bundleID: zoomBundleID)
        emitter.close()
        var encodeCount = 0
        emitter.emit(ScreenFrame(luma: luma(fill: 20), time: 0, title: nil)) { encodeCount += 1; return "A" }
        emitter.emitWindowGone(at: 1)
        emitter.close()
        let events = await collect(emitter)
        #expect(events.isEmpty)
        #expect(encodeCount == 0)
    }

    // Issue #280: 取り込みが途中で止まった（ウィンドウはまだある）。画像を送っていれば null の screen を先に、その後に screen-off を 1 回だけ送る。
    @Test("画像を送った後に取り込みが止まると、null の screen → screen-off（許可なし）の順に出る")
    func captureStoppedAfterImageSendsNullThenScreenOff() async {
        let emitter = ScreenEventEmitter(bundleID: zoomBundleID)
        emitter.emit(ScreenFrame(luma: luma(fill: 20), time: 0, title: nil)) { "A" }
        emitter.emitCaptureStopped(at: 6)
        let events = await collect(emitter)
        #expect(events == [.screen(start: 0, image: "A"), .screen(start: 6, image: nil), .screenOff(start: 6, reason: .許可なし)])
    }

    @Test("画像を一度も送っていないときに止まると、screen-off だけが出る（null の screen は出さない）")
    func captureStoppedBeforeAnyImageSendsOnlyScreenOff() async {
        let emitter = ScreenEventEmitter(bundleID: zoomBundleID)
        emitter.emitCaptureStopped(at: 2)
        let events = await collect(emitter)
        #expect(events == [.screenOff(start: 2, reason: .許可なし)])
    }

    @Test("ウィンドウが消えた後に止まっても、null の screen は重ねず screen-off だけが続く")
    func captureStoppedAfterWindowGoneDoesNotRepeatNull() async {
        let emitter = ScreenEventEmitter(bundleID: zoomBundleID)
        emitter.emit(ScreenFrame(luma: luma(fill: 20), time: 0, title: nil)) { "A" }
        emitter.emitWindowGone(at: 3)
        emitter.emitCaptureStopped(at: 4)
        let events = await collect(emitter)
        #expect(events == [.screen(start: 0, image: "A"), .screen(start: 3, image: nil), .screenOff(start: 4, reason: .許可なし)])
    }

    @Test("ウィンドウが消えただけでは screen-off を出さない（許可の問題ではない）")
    func windowGoneAloneDoesNotSendScreenOff() async {
        let emitter = ScreenEventEmitter(bundleID: zoomBundleID)
        emitter.emit(ScreenFrame(luma: luma(fill: 20), time: 0, title: nil)) { "A" }
        emitter.emitWindowGone(at: 3)
        let events = await collect(emitter)
        #expect(events == [.screen(start: 0, image: "A"), .screen(start: 3, image: nil)])
        #expect(!events.contains { if case .screenOff = $0 { return true } else { return false } })
    }

    @Test("取り込みが止まったことの通知は 1 回だけ。2 回目以降は何も送らない")
    func captureStoppedOnlyOnce() async {
        let emitter = ScreenEventEmitter(bundleID: zoomBundleID)
        emitter.emit(ScreenFrame(luma: luma(fill: 20), time: 0, title: nil)) { "A" }
        emitter.emitCaptureStopped(at: 6)
        emitter.emitCaptureStopped(at: 7)
        let events = await collect(emitter)
        #expect(events == [.screen(start: 0, image: "A"), .screen(start: 6, image: nil), .screenOff(start: 6, reason: .許可なし)])
    }

    @Test("終了後に取り込みが止まっても何も送らない")
    func captureStoppedAfterCloseSendsNothing() async {
        let emitter = ScreenEventEmitter(bundleID: zoomBundleID)
        emitter.close()
        emitter.emitCaptureStopped(at: 1)
        let events = await collect(emitter)
        #expect(events.isEmpty)
    }
}

// Issue #280: 取り込みを始めるかどうかを、許可の結果から決める純粋な部分。許可の API はここでは呼ばない（CI に画面収録の許可が無い）。
@Suite("共有画面の取り込み方針（screenCapturePlan）")
struct ScreenCapturePlanTests {
    @Test("--no-screen なら許可の確認を呼ばず、取り込まない")
    func noScreenNeverChecksAccess() {
        var checks = 0
        let plan = screenCapturePlan(noScreen: true) { checks += 1; return true }
        #expect(plan == .off)
        #expect(checks == 0)
    }

    @Test("許可があれば取り込む（確認は 1 回だけ）")
    func grantedCaptures() {
        var checks = 0
        let plan = screenCapturePlan(noScreen: false) { checks += 1; return true }
        #expect(plan == .capture)
        #expect(checks == 1)
    }

    @Test("許可が無い・断られたなら取り込みを始めない")
    func deniedDoesNotCapture() {
        var checks = 0
        let plan = screenCapturePlan(noScreen: false) { checks += 1; return false }
        #expect(plan == .denied)
        #expect(checks == 1)
    }
}
