import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

// 共有画面の画像まわり（ライブの `ScreenCapture` と、録画の映像の `FileScreen` が共有する）。
// 輝度の画像・送る JPEG・送ると決めた画面の OCR を、どちらも同じ関数で作る。

func printScreenError(_ message: String) {
    FileHandle.standardError.write(Data(("screen: " + message + "\n").utf8))
}

/// 128×72 のグレーに縮めた輝度（行の並び）。
func lumaGrid(of image: CGImage) -> [UInt8]? {
    var pixels = [UInt8](repeating: 0, count: screenGridWidth * screenGridHeight)
    let drawn = pixels.withUnsafeMutableBytes { buffer -> Bool in
        guard let context = CGContext(
            data: buffer.baseAddress,
            width: screenGridWidth,
            height: screenGridHeight,
            bitsPerComponent: 8,
            bytesPerRow: screenGridWidth,
            space: CGColorSpaceCreateDeviceGray(),
            bitmapInfo: CGImageAlphaInfo.none.rawValue
        ) else { return false }
        context.interpolationQuality = .medium
        context.draw(image, in: CGRect(x: 0, y: 0, width: screenGridWidth, height: screenGridHeight))
        return true
    }
    return drawn ? pixels : nil
}

/// ImageIO で JPEG にする。画像の大きさは呼び出し側が 1280×720 に収めてある。
func jpegData(of image: CGImage) -> Data? {
    let data = NSMutableData()
    guard let destination = CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
    CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: screenJPEGQuality] as CFDictionary)
    guard CGImageDestinationFinalize(destination) else { return nil }
    return data as Data
}

/// 送ると決めた画面の中身（JPEG と OCR の行）を作る。JPEG を作れなければ nil（この画面は送らない）。
/// OCR は失敗しても画像は送り、失敗印を付ける。原因と再試行結果は OCR の共通処理が出す。
/// OCR を同期で待つので、映像のキュー・画面収録のキューの上で呼ぶ（`recognizeScreenTextBlocking`）。
@available(*, noasync, message: "並行処理のスレッドを塞ぐ。映像のキュー・画面収録のキューの上で呼ぶ")
func screenShot(of image: CGImage) -> ScreenShot? {
    guard let jpeg = jpegData(of: image) else {
        printScreenError("JPEG を作れなかったので、この画面は送らない")
        return nil
    }
    let lines = recognizeScreenTextBlocking(image)
    return ScreenShot(jpeg: jpeg, recognizedLines: lines)
}
