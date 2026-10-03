#ifndef CWEBRTCAPM_H
#define CWEBRTCAPM_H

// WebRTC AEC3 への C の窓口。C++ の型は公開しない（実装は apm.cpp に閉じ込める）。
// 時刻合わせは呼び出し側の責務で、ここは 10 ms（sample_rate / 100 サンプル）ごとの reverse / capture だけを受け持つ。

#ifdef __cplusplus
extern "C" {
#endif

typedef struct ApmHandle *ApmRef;

/// 指定のサンプルレート・チャンネル数で APM を作る。失敗したら NULL。
ApmRef apm_create(int sample_rate, int channels);

/// 参照（スピーカーに出た音）の 10 ms 分を渡す。`frames` は sample_rate / 100。成功なら 0。
int apm_process_reverse(ApmRef handle, const float *frame, int frames);

/// マイクの 10 ms 分を処理し、その場で書き換える。`frames` は sample_rate / 100。成功なら 0。
int apm_process_capture(ApmRef handle, float *frame, int frames);

void apm_destroy(ApmRef handle);

#ifdef __cplusplus
}
#endif

#endif
