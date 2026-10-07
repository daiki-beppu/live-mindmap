import { useEffect } from "react";
import { halfWidthKeyOf } from "./imeKey.ts";

// 日本語入力がオンのキーを、半角のキーにして元の target へ送り直す。
// ライブラリは isTrusted を見ないので、送り直したイベントも登録したキーに一致する。
// keyup は送り直さない（登録は keydown だけを見る）。
export function useImeKeyRedispatch(): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const out = halfWidthKeyOf(e);
      if (out === null || e.target === null) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      e.target.dispatchEvent(
        new KeyboardEvent("keydown", {
          ...out,
          repeat: e.repeat,
          location: e.location,
          bubbles: true,
          cancelable: true,
          composed: true,
        }),
      );
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);
}
