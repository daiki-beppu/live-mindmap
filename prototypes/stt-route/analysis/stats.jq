def pct(p): sort | .[((length-1)*p|floor)] | .*10|round/10;
map(select(.final)) | {
  n: length,
  len_p50: (map(.end-.start)|pct(0.5)), len_p95: (map(.end-.start)|pct(0.95)), len_max: (map(.end-.start)|max|.*10|round/10),
  lag_p50: (map(.lag)|pct(0.5)), lag_p95: (map(.lag)|pct(0.95)),
  start_to_final_p50: (map(.arrived-.start)|pct(0.5)), start_to_final_p95: (map(.arrived-.start)|pct(0.95)),
  chars_p50: (map(.text|length)|pct(0.5))
}
