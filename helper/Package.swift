// swift-tools-version: 6.0
import PackageDescription

// WebRTC AEC3 は helper/scripts/build-webrtc-apm.sh が helper/.deps/webrtc-apm/ にビルドする（無ければ CWebRTCAPM のビルドが、スクリプトを促すエラーで止まる）。
let webrtcAPM = "\(Context.packageDirectory)/.deps/webrtc-apm"
let webrtcAPMLibraries = [
    "libwebrtc-audio-processing-2", "libcommon_audio", "liblibbase", "liblibapi",
    "libsystem_wrappers", "liblibfft", "liblibpffft", "liblibrnnoise",
    "libabsl_base", "libabsl_container", "libabsl_crc", "libabsl_debugging", "libabsl_flags",
    "libabsl_hash", "libabsl_log", "libabsl_numeric", "libabsl_profiling", "libabsl_random",
    "libabsl_status", "libabsl_strings", "libabsl_synchronization", "libabsl_time", "libabsl_types",
].map { "\(webrtcAPM)/lib/\($0).a" }

let package = Package(
    name: "live-mindmap-helper",
    platforms: [.macOS("26.0")],
    products: [
        .executable(name: "live-mindmap-helper", targets: ["live-mindmap-helper"]),
    ],
    targets: [
        // 純粋なロジック（イベントの形・アプリの選択）と、Core Audio / SpeechAnalyzer / WebSocket の実装
        .target(name: "HelperCore", dependencies: ["CWebRTCAPM"]),
        // WebRTC AEC3 の C++ を閉じ込め、C の関数だけを公開するシム（Issue #112）
        .target(
            name: "CWebRTCAPM",
            cxxSettings: [
                .unsafeFlags([
                    "-std=c++17", "-DWEBRTC_POSIX", "-DWEBRTC_MAC", "-DWEBRTC_APM_DEBUG_DUMP=0",
                    "-I\(webrtcAPM)/src", "-I\(webrtcAPM)/src/webrtc", "-I\(webrtcAPM)/build", "-I\(webrtcAPM)/abseil",
                ]),
            ],
            linkerSettings: [.unsafeFlags(webrtcAPMLibraries)]
        ),
        // 引数の解釈と配線だけの薄い層
        .executableTarget(name: "live-mindmap-helper", dependencies: ["HelperCore"]),
        .testTarget(name: "HelperCoreTests", dependencies: ["HelperCore"]),
        // 音声認識の確定の遅れを測る開発者向けの道具（Issue #97）。製品には含めない
        .executableTarget(name: "stt-bench", dependencies: ["HelperCore"]),
        .testTarget(name: "SttBenchTests", dependencies: ["stt-bench", "HelperCore"]),
    ],
    swiftLanguageModes: [.v5]
)
