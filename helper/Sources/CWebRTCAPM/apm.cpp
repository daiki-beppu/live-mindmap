#include "CWebRTCAPM.h"

#if !__has_include("api/audio/audio_processing.h")
#error "WebRTC AEC3 のライブラリが無い。helper/scripts/build-webrtc-apm.sh を実行してから、もう一度ビルドする"
#endif

#include <algorithm>
#include <memory>
#include <vector>

#include "api/audio/audio_processing.h"
#include "api/audio/echo_canceller3_config.h"
#include "api/audio/echo_control.h"
#include "modules/audio_processing/aec3/echo_canceller3.h"
#include "api/scoped_refptr.h"

struct ApmHandle {
    rtc::scoped_refptr<webrtc::AudioProcessing> apm;
    webrtc::StreamConfig config;
    // reverse の出力先。呼び出し側の const な参照を書き換えないための作業領域。
    std::vector<float> reverseScratch;
};

namespace {

// APM は、AEC3 の設定を `AudioProcessing::Config` から受け取れない。設定を持った EchoCanceller3 を作る工場を差し込む。
class ConfiguredEchoControlFactory : public webrtc::EchoControlFactory {
public:
    explicit ConfiguredEchoControlFactory(const webrtc::EchoCanceller3Config &config) : config_(config) {}

    std::unique_ptr<webrtc::EchoControl> Create(int sample_rate_hz, int num_render_channels, int num_capture_channels) override {
        return std::make_unique<webrtc::EchoCanceller3>(
            config_, std::nullopt, sample_rate_hz, static_cast<size_t>(num_render_channels), static_cast<size_t>(num_capture_channels));
    }

private:
    webrtc::EchoCanceller3Config config_;
};

}  // namespace

extern "C" {

ApmRef apm_create(int sample_rate, int channels, const ApmEchoSettings *settings) {
    if (sample_rate <= 0 || channels <= 0 || !settings) return nullptr;

    webrtc::EchoCanceller3Config aec3;
    aec3.ep_strength.default_gain = settings->ep_strength_default_gain;
    if (!webrtc::EchoCanceller3Config::Validate(&aec3)) return nullptr;

    webrtc::AudioProcessing::Config config;
    config.echo_canceller.enabled = true;
    config.echo_canceller.mobile_mode = false;
    config.high_pass_filter.enabled = true;
    config.gain_controller1.enabled = false;
    config.gain_controller2.enabled = false;
    config.noise_suppression.enabled = false;

    auto apm = webrtc::AudioProcessingBuilder()
                   .SetConfig(config)
                   .SetEchoControlFactory(std::make_unique<ConfiguredEchoControlFactory>(aec3))
                   .Create();
    if (!apm) return nullptr;
    return new ApmHandle{apm, webrtc::StreamConfig(sample_rate, static_cast<size_t>(channels)), {}};
}

int apm_process_reverse(ApmRef handle, const float *frame, int frames) {
    if (!handle || !frame || frames != static_cast<int>(handle->config.num_frames())) return -1;
    // 参照はモノラルの 1 チャンネルだけ。ポインタの配列で渡し、出力は作業領域に受ける。
    handle->reverseScratch.assign(frame, frame + frames);
    const float *input[1] = {handle->reverseScratch.data()};
    float *output[1] = {handle->reverseScratch.data()};
    return handle->apm->ProcessReverseStream(input, handle->config, handle->config, output);
}

int apm_process_capture(ApmRef handle, float *frame, int frames) {
    if (!handle || !frame || frames != static_cast<int>(handle->config.num_frames())) return -1;
    const float *input[1] = {frame};
    float *output[1] = {frame};
    return handle->apm->ProcessStream(input, handle->config, handle->config, output);
}

void apm_destroy(ApmRef handle) { delete handle; }

}  // extern "C"
