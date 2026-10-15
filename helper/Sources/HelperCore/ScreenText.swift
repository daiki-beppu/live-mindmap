import CoreGraphics
import Foundation
import Vision

// 共有画面の文字を読む（Issue #643）。変化の判定で送ると決めた画面だけに、`screenShot(of:)`（ScreenImage.swift）の中でかける。

/// 画像に映った文字を、認識した行ごとに上から順に返す。日本語と英語を読む。認識に失敗したら nil。文字が無ければ空の配列。
public func recognizeScreenText(_ image: CGImage) -> [String]? {
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
