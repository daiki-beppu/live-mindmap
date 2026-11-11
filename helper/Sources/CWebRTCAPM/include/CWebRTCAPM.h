#ifndef CWEBRTCAPM_H
#define CWEBRTCAPM_H

#ifdef __cplusplus
extern "C" {
#endif

typedef struct ApmHandle *ApmRef;

typedef struct {
    float ep_strength_default_gain;
    float suppressor_normal_mask_lf_enr_suppress;
    int stream_delay_ms;
} ApmEchoSettings;

ApmRef apm_create(int sample_rate, int channels, const ApmEchoSettings *settings);

int apm_process_reverse(ApmRef handle, const float *frame, int frames);

int apm_process_capture(ApmRef handle, float *frame, int frames);

void apm_destroy(ApmRef handle);

#ifdef __cplusplus
}
#endif

#endif
