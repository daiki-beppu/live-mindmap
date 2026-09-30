// PROTOTYPE — 見比べ用の切り替えバー。←/→ キーでも切り替わる。
import { useEffect } from "react";

type Props = { variants: { key: string; name: string }[]; current: string; onChange: (k: string) => void };

export function Switcher({ variants, current, onChange }: Props) {
  const i = Math.max(0, variants.findIndex((v) => v.key === current));
  const go = (d: number) => {
    const next = variants[(i + d + variants.length) % variants.length]!.key;
    const u = new URL(location.href);
    u.searchParams.set("variant", next);
    history.replaceState(null, "", u);
    onChange(next);
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest("input,select,textarea,[contenteditable]")) return;
      if (e.key === "ArrowLeft") go(-1);
      if (e.key === "ArrowRight") go(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  if (import.meta.env.PROD) return null;
  const v = variants[i]!;
  return (
    <div className="switcher">
      <button onClick={() => go(-1)}>←</button>
      <span>{v.key}（{v.name}）</span>
      <button onClick={() => go(1)}>→</button>
    </div>
  );
}
