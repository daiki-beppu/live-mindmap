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
    /// ウィンドウのタイトル。判定には使わない（比べるのは画像だけ）。
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
    /// 画面が変わったので画像を送る。`start` はそのフレームの時刻（映り始めた時刻）。
    case send(start: Double)
    /// 画像を送った後にウィンドウが無くなった。`image: null` を送る。
    case none(start: Double)
    case nothing
}

/// 最後に送った画面とマスごとに比べ、変わったマスが多いときだけ「送る」を返す。
/// 基準を更新するのは送ったときだけなので、少しずつの変化もフレーム間ではなく最後に送った画面との差として積み上がる。
public struct ScreenChangeDetector: Sendable {
    private var lastSent: [UInt8]?

    public init() {}

    public mutating func next(_ input: ScreenInput) -> ScreenDecision {
        switch input {
        case .windowGone(let time):
            guard lastSent != nil else { return .nothing }
            lastSent = nil
            return .none(start: time)
        case .frame(let frame):
            if let base = lastSent, !hasChanged(frame.luma, from: base) { return .nothing }
            lastSent = frame.luma
            return .send(start: frame.time)
        }
    }

    /// フレームを判定し、送るときだけ `encode` で画像（base64）を作ってイベントにする。
    /// `encode` が nil を返したら、送っていない画面を「最後に送った画面」にしないよう、基準を判定の前へ戻して nil を返す。
    public mutating func screenEvent(for frame: ScreenFrame, encode: () -> String?) -> HelperEvent? {
        let before = self
        guard case .send(let start) = next(.frame(frame)) else { return nil }
        guard let image = encode() else {
            self = before
            return nil
        }
        return .screen(start: start, image: image)
    }

    /// ウィンドウが無くなったとき、画像を送った後なら `image: null` のイベントにする。それ以外は nil。
    public mutating func screenEvent(windowGoneAt time: Double) -> HelperEvent? {
        guard case .none(let start) = next(.windowGone(time: time)) else { return nil }
        return .screen(start: start, image: nil)
    }

    private func hasChanged(_ luma: [UInt8], from base: [UInt8]) -> Bool {
        guard luma.count == base.count, !luma.isEmpty else { return true }
        var changed = 0
        for index in 0..<luma.count where abs(Int(luma[index]) - Int(base[index])) > screenLumaDifferenceThreshold {
            changed += 1
        }
        return Double(changed) / Double(luma.count) > screenChangedCellRatioThreshold
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
