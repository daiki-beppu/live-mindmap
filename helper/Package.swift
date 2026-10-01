// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "live-mindmap-helper",
    platforms: [.macOS("26.0")],
    products: [
        .executable(name: "live-mindmap-helper", targets: ["live-mindmap-helper"]),
    ],
    targets: [
        // 純粋なロジック（イベントの形・アプリの選択）と、Core Audio / SpeechAnalyzer / WebSocket の実装
        .target(name: "HelperCore"),
        // 引数の解釈と配線だけの薄い層
        .executableTarget(name: "live-mindmap-helper", dependencies: ["HelperCore"]),
        .testTarget(name: "HelperCoreTests", dependencies: ["HelperCore"]),
    ],
    swiftLanguageModes: [.v5]
)
