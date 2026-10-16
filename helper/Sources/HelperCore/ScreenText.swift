import CoreGraphics
import Foundation
import Vision

// 共有画面の文字を読む（Issue #643）。変化の判定で送ると決めた画面だけに、`screenShot(of:)`（ScreenImage.swift）の中でかける。

/// Vision の OCR は、内部の処理を Swift の並行処理のスレッドに積み、その終わりをセマフォで待つ。
/// 並行処理のスレッド（コア数ぶんしかない）の上で同期で呼ぶと、OCR が自分の握ったスレッドの空きを待って止まり、
/// 同時に呼ぶ数がコア数に届くとプロセスごと止まる（コアの少ない CI のランナーで IT が丸ごと止まった。Issue #1197）。
/// 並行処理の文脈からは、このキューの上で呼ぶ。
private let screenTextQueue = DispatchQueue(label: "live-mindmap.screen-text")

/// 画像に映った文字を、認識した行ごとに上から順に返す。日本語と英語を読む。認識に失敗したら nil。文字が無ければ空の配列。
/// OCR は `screenTextQueue` の上で行い、並行処理のスレッドを塞がない。
public func recognizeScreenText(_ image: CGImage) async -> [String]? {
    await withCheckedContinuation { continuation in
        screenTextQueue.async { continuation.resume(returning: recognizeScreenTextBlocking(image)) }
    }
}

/// `recognizeScreenText` の同期の版。OCR が終わるまでスレッドを止めて待つので、並行処理のスレッドの上では呼ばない
/// （映像のキュー・画面収録のキューの上の `screenShot(of:)` から呼ぶ）。
@available(*, noasync, message: "並行処理のスレッドを塞ぐ。async の文脈からは recognizeScreenText を await する")
func recognizeScreenTextBlocking(_ image: CGImage) -> [String]? {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.recognitionLanguages = ["ja-JP", "en-US"]
    request.usesLanguageCorrection = true
    do {
        try VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
    } catch {
        return nil
    }
    return (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }
}
