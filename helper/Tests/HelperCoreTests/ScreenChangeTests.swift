import Foundation
import Testing
import HelperCore

// 共有画面の判定器（取り込みから切り離した純粋な部分）。合成した輝度のフレームを順に入れて試す。
// ScreenCaptureKit は呼ばない（CI のジョブには画面収録の許可が無い）。

private let width = Int(screenGridWidth)
private let height = Int(screenGridHeight)
private let cellCount = width * height

/// 128×72 の輝度。全マスが `fill`。
private func luma(fill: UInt8) -> [UInt8] {
    [UInt8](repeating: fill, count: cellCount)
}

/// `base` の、左上から `columns`×`rows` の長方形のマスを `value` に書き換えた輝度。
private func rewritten(_ base: [UInt8], columns: Int, rows: Int, to value: UInt8) -> [UInt8] {
    var result = base
    for row in 0..<rows {
        for column in 0..<columns { result[row * width + column] = value }
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
}

@Suite("共有画面の判定器")
struct ScreenChangeDetectorTests {
    @Test("最初のフレームは送る。映り始めた時刻は、そのフレームの時刻")
    func firstFrameIsSent() {
        var detector = ScreenChangeDetector()
        #expect(detector.next(frame(luma(fill: 100), at: 2.5)) == .send(start: 2.5))
    }

    @Test("同じ画面が続く間は送らない（一度送った後の、同じ輝度のフレーム）")
    func identicalFramesAreNotSent() {
        var detector = ScreenChangeDetector()
        #expect(detector.next(frame(luma(fill: 100), at: 0)) == .send(start: 0))
        #expect(detector.next(frame(luma(fill: 100), at: 0.25)) == .nothing)
        #expect(detector.next(frame(luma(fill: 100), at: 0.5)) == .nothing)
        #expect(detector.next(frame(luma(fill: 100), at: 0.75)) == .nothing)
    }

    @Test("スライドの切り替え（全マスが変わる）は、送ると決めたフレームの時刻で送る")
    func slideSwitchIsSent() {
        var detector = ScreenChangeDetector()
        #expect(detector.next(frame(luma(fill: 30), at: 0)) == .send(start: 0))
        #expect(detector.next(frame(luma(fill: 30), at: 0.25)) == .nothing)
        #expect(detector.next(frame(luma(fill: 220), at: 0.5)) == .send(start: 0.5))
        #expect(detector.next(frame(luma(fill: 220), at: 0.75)) == .nothing)
    }

    @Test("表のセル 1 つの書き換え（16×4 マス = 64 マス > 0.5%）は送る")
    func singleTableCellRewriteIsSent() {
        let page = luma(fill: 240)
        var detector = ScreenChangeDetector()
        #expect(detector.next(frame(page, at: 0)) == .send(start: 0))
        #expect(detector.next(frame(page, at: 0.25)) == .nothing)
        #expect(detector.next(frame(rewritten(page, columns: 16, rows: 4, to: 40), at: 0.5)) == .send(start: 0.5))
    }

    @Test("変わったマスが 0.5% 以下なら送らず、0.5% を超えたら送る（46 マスは送らず、47 マスは送る）")
    func changedCellRatioBoundary() {
        // 9216 マスの 0.5% は 46.08 マス。46 マスは 0.4991%、47 マスは 0.5100%
        let page = luma(fill: 240)
        var detector = ScreenChangeDetector()
        #expect(detector.next(frame(page, at: 0)) == .send(start: 0))
        #expect(detector.next(frame(rewritten(page, firstCells: 46, to: 0), at: 0.25)) == .nothing)
        #expect(detector.next(frame(rewritten(page, firstCells: 47, to: 0), at: 0.5)) == .send(start: 0.5))
    }

    @Test("輝度差が 10 のマスは変わったと数えず、11 のマスは数える（全マスで試す）")
    func lumaDifferenceBoundary() {
        var detector = ScreenChangeDetector()
        #expect(detector.next(frame(luma(fill: 100), at: 0)) == .send(start: 0))
        #expect(detector.next(frame(luma(fill: 110), at: 0.25)) == .nothing) // 差 10
        #expect(detector.next(frame(luma(fill: 90), at: 0.5)) == .nothing) // 差 10（暗くなる向き）
        #expect(detector.next(frame(luma(fill: 111), at: 0.75)) == .send(start: 0.75)) // 差 11
    }

    @Test("暗くなる向きの変化も数える（差の絶対値で比べる）")
    func darkeningIsCounted() {
        var detector = ScreenChangeDetector()
        #expect(detector.next(frame(luma(fill: 100), at: 0)) == .send(start: 0))
        #expect(detector.next(frame(luma(fill: 89), at: 0.25)) == .send(start: 0.25))
    }

    @Test("送った後の基準は、送った画面になる。元の画面に戻ったら、また送る")
    func baselineIsTheLastSentScreen() {
        var detector = ScreenChangeDetector()
        #expect(detector.next(frame(luma(fill: 20), at: 0)) == .send(start: 0))
        #expect(detector.next(frame(luma(fill: 200), at: 1)) == .send(start: 1))
        #expect(detector.next(frame(luma(fill: 200), at: 1.25)) == .nothing)
        #expect(detector.next(frame(luma(fill: 20), at: 2)) == .send(start: 2))
    }

    @Test("送らなかったフレームは基準にならない: 少しずつの差は、フレーム間ではなく最後に送った画面との差で積み上がる")
    func subThresholdChangesAccumulateAgainstLastSent() {
        // 40 マス（0.43%）だけ変わったフレームは送らない。続けて別の 40 マスも変わると、
        // 最後に送った画面との差は 80 マス（0.87%）になって送る。直前のフレームとの差は 40 マスのまま
        let page = luma(fill: 240)
        let first = rewritten(page, firstCells: 40, to: 0)
        var second = first
        for index in 40..<80 { second[index] = 0 }

        var detector = ScreenChangeDetector()
        #expect(detector.next(frame(page, at: 0)) == .send(start: 0))
        #expect(detector.next(frame(first, at: 0.25)) == .nothing)
        #expect(detector.next(frame(second, at: 0.5)) == .send(start: 0.5))
    }

    @Test("顔の小窓のゆっくりした動き（毎フレーム 1 ずつ）は、フレーム間では差 1 でも、最後に送った画面との差が 10 を超えるたびにだけ送る")
    func slowFaceWindowMotionSendsOnlyWhenOverThreshold() {
        // 10×10 = 100 マス（1.09%）が毎フレーム +1 ずつ明るくなる。
        // フレーム間の比較なら一度も送らない。最後に送った画面との比較なら、差が 11 になる 11 フレームごとに送る
        let background = luma(fill: 60)
        var detector = ScreenChangeDetector()
        #expect(detector.next(frame(background, at: 0)) == .send(start: 0))

        var sent: [Double] = []
        for step in 1...40 {
            let time = Double(step) * 0.25
            let current = rewritten(background, columns: 10, rows: 10, to: UInt8(60 + step))
            if case .send(let start) = detector.next(frame(current, at: time)) { sent.append(start) }
        }
        let expected: [Double] = [11, 22, 33].map { $0 * 0.25 } // 式のまま #expect に置くと、型検査が時間切れになる
        #expect(sent == expected)
    }

    @Test("0.5% に満たない小さな領域は、大きく変わっても送らない（一度送った状態から）")
    func smallRegionChangeIsNotSent() {
        // 8×5 = 40 マス（0.43%）が真っ白から真っ黒に変わる
        let page = luma(fill: 255)
        var detector = ScreenChangeDetector()
        #expect(detector.next(frame(page, at: 0)) == .send(start: 0))
        #expect(detector.next(frame(rewritten(page, columns: 8, rows: 5, to: 0), at: 0.25)) == .nothing)
    }

    @Test("ウィンドウのタイトルは判定に使わない: タイトルが変わっても画面が同じなら送らない")
    func titleDoesNotAffectDecision() {
        var detector = ScreenChangeDetector()
        #expect(detector.next(frame(luma(fill: 100), at: 0, title: "会議 A")) == .send(start: 0))
        #expect(detector.next(frame(luma(fill: 100), at: 0.25, title: "会議 B")) == .nothing)
        #expect(detector.next(frame(luma(fill: 100), at: 0.5, title: nil)) == .nothing)
    }

    @Test("タイトルが同じでも、画面が変われば送る")
    func screenChangeIsSentRegardlessOfTitle() {
        var detector = ScreenChangeDetector()
        #expect(detector.next(frame(luma(fill: 20), at: 0, title: "会議")) == .send(start: 0))
        #expect(detector.next(frame(luma(fill: 200), at: 0.25, title: "会議")) == .send(start: 0.25))
    }
}

@Suite("共有画面の判定器: ウィンドウが無くなったとき")
struct ScreenWindowGoneTests {
    @Test("画像を送った後にウィンドウが無くなると「なし」を返し、無くなった時刻を持つ")
    func windowGoneAfterSendReturnsNone() {
        var detector = ScreenChangeDetector()
        #expect(detector.next(frame(luma(fill: 100), at: 0)) == .send(start: 0))
        #expect(detector.next(.windowGone(time: 3.5)) == .none(start: 3.5))
    }

    @Test("「なし」の後に同じ中身のフレームが映ったら、また送る（基準を消している）")
    func frameAfterGoneIsSentEvenIfIdentical() {
        var detector = ScreenChangeDetector()
        #expect(detector.next(frame(luma(fill: 100), at: 0)) == .send(start: 0))
        #expect(detector.next(.windowGone(time: 3)) == .none(start: 3))
        #expect(detector.next(frame(luma(fill: 100), at: 4)) == .send(start: 4))
        #expect(detector.next(frame(luma(fill: 100), at: 4.25)) == .nothing)
    }

    @Test("すでに「なし」を返した後に、ウィンドウが無いという入力が続いても、何もしない")
    func repeatedGoneIsNothing() {
        var detector = ScreenChangeDetector()
        #expect(detector.next(frame(luma(fill: 100), at: 0)) == .send(start: 0))
        #expect(detector.next(.windowGone(time: 3)) == .none(start: 3))
        #expect(detector.next(.windowGone(time: 3.25)) == .nothing)
    }

    @Test("画像を一度も送っていないときにウィンドウが無くなっても、何もしない")
    func goneBeforeAnySendIsNothing() {
        var detector = ScreenChangeDetector()
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
        var detector = ScreenChangeDetector()
        let a = ScreenFrame(luma: luma(fill: 20), time: 0, title: nil)
        let b = ScreenFrame(luma: luma(fill: 200), time: 1.25, title: nil)
        #expect(detector.screenEvent(for: a) { "A" } == .screen(start: 0, image: "A"))
        #expect(detector.screenEvent(for: b) { nil } == nil)
        #expect(detector.screenEvent(for: b) { "B" } == .screen(start: 1.25, image: "B"))
    }

    @Test("送らないフレームでは画像を作らない")
    func noEncodeWhenNotSending() {
        var detector = ScreenChangeDetector()
        let a = ScreenFrame(luma: luma(fill: 20), time: 0, title: nil)
        var encodeCount = 0
        #expect(detector.screenEvent(for: a) { "A" } == .screen(start: 0, image: "A"))
        #expect(detector.screenEvent(for: a) { encodeCount += 1; return "A" } == nil)
        #expect(encodeCount == 0)
    }

    @Test("最初のフレームの生成に失敗しても、基準は空のまま（次のフレームを最初として送る）")
    func failedFirstEncodeKeepsNoBaseline() {
        var detector = ScreenChangeDetector()
        let a = ScreenFrame(luma: luma(fill: 20), time: 0, title: nil)
        #expect(detector.screenEvent(for: a) { nil } == nil)
        #expect(detector.screenEvent(for: a) { "A" } == .screen(start: 0, image: "A"))
    }

    @Test("ウィンドウが無くなったら image: null のイベントを 1 回だけ返す。重複した通知や、何も送っていないときは nil")
    func windowGoneEventIsEmittedOnce() {
        var detector = ScreenChangeDetector()
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
        let emitter = ScreenEventEmitter()
        emitter.emit(ScreenFrame(luma: luma(fill: 20), time: 0, title: nil)) { "A" }
        emitter.emitWindowGone(at: 3)
        emitter.emit(ScreenFrame(luma: luma(fill: 200), time: 1, title: nil)) { "B" }
        let events = await collect(emitter)
        #expect(events == [.screen(start: 0, image: "A"), .screen(start: 3, image: nil), .screen(start: 1, image: "B")])
    }

    @Test("画像の生成の途中で別スレッドから消失が来ても、null は画像の後に出る（最後の保持値が null になる）")
    func windowGoneDuringEncodeComesAfterImage() async {
        let emitter = ScreenEventEmitter()
        emitter.emit(ScreenFrame(luma: luma(fill: 20), time: 0, title: nil)) { "A" }
        emitWithWindowGoneDuringEncode(emitter, frame: ScreenFrame(luma: luma(fill: 200), time: 1, title: nil), goneAt: 5)
        let events = await collect(emitter)
        #expect(events == [.screen(start: 0, image: "A"), .screen(start: 1, image: "B"), .screen(start: 5, image: nil)])
    }

    @Test("終了後は何も送らず、画像も作らない")
    func nothingAfterClose() async {
        let emitter = ScreenEventEmitter()
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
        let emitter = ScreenEventEmitter()
        emitter.emit(ScreenFrame(luma: luma(fill: 20), time: 0, title: nil)) { "A" }
        emitter.emitCaptureStopped(at: 6)
        let events = await collect(emitter)
        #expect(events == [.screen(start: 0, image: "A"), .screen(start: 6, image: nil), .screenOff(start: 6, reason: .許可なし)])
    }

    @Test("画像を一度も送っていないときに止まると、screen-off だけが出る（null の screen は出さない）")
    func captureStoppedBeforeAnyImageSendsOnlyScreenOff() async {
        let emitter = ScreenEventEmitter()
        emitter.emitCaptureStopped(at: 2)
        let events = await collect(emitter)
        #expect(events == [.screenOff(start: 2, reason: .許可なし)])
    }

    @Test("ウィンドウが消えた後に止まっても、null の screen は重ねず screen-off だけが続く")
    func captureStoppedAfterWindowGoneDoesNotRepeatNull() async {
        let emitter = ScreenEventEmitter()
        emitter.emit(ScreenFrame(luma: luma(fill: 20), time: 0, title: nil)) { "A" }
        emitter.emitWindowGone(at: 3)
        emitter.emitCaptureStopped(at: 4)
        let events = await collect(emitter)
        #expect(events == [.screen(start: 0, image: "A"), .screen(start: 3, image: nil), .screenOff(start: 4, reason: .許可なし)])
    }

    @Test("ウィンドウが消えただけでは screen-off を出さない（許可の問題ではない）")
    func windowGoneAloneDoesNotSendScreenOff() async {
        let emitter = ScreenEventEmitter()
        emitter.emit(ScreenFrame(luma: luma(fill: 20), time: 0, title: nil)) { "A" }
        emitter.emitWindowGone(at: 3)
        let events = await collect(emitter)
        #expect(events == [.screen(start: 0, image: "A"), .screen(start: 3, image: nil)])
        #expect(!events.contains { if case .screenOff = $0 { return true } else { return false } })
    }

    @Test("取り込みが止まったことの通知は 1 回だけ。2 回目以降は何も送らない")
    func captureStoppedOnlyOnce() async {
        let emitter = ScreenEventEmitter()
        emitter.emit(ScreenFrame(luma: luma(fill: 20), time: 0, title: nil)) { "A" }
        emitter.emitCaptureStopped(at: 6)
        emitter.emitCaptureStopped(at: 7)
        let events = await collect(emitter)
        #expect(events == [.screen(start: 0, image: "A"), .screen(start: 6, image: nil), .screenOff(start: 6, reason: .許可なし)])
    }

    @Test("終了後に取り込みが止まっても何も送らない")
    func captureStoppedAfterCloseSendsNothing() async {
        let emitter = ScreenEventEmitter()
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
