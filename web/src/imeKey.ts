export type KeyInput = {
  key: string;
  code: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  isComposing: boolean;
};

export type HalfWidthKey = Omit<KeyInput, "isComposing">;

const US_UNSHIFTED: Readonly<Record<string, string>> = {
  Minus: "-",
  Equal: "=",
  Slash: "/",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Backquote: "`",
  Space: " ",
};

const US_SHIFTED: Readonly<Record<string, string>> = {
  Slash: "?",
  Minus: "=",
  Equal: "=",
  Comma: "<",
  Period: ">",
};

function charOfCode(code: string, shiftKey: boolean): string | null {
  if (shiftKey) return US_SHIFTED[code] ?? null;
  const letter = /^Key([A-Z])$/.exec(code)?.[1];
  if (letter !== undefined) return letter.toLowerCase();
  const digit = /^Digit([0-9])$/.exec(code)?.[1];
  if (digit !== undefined) return digit;
  return US_UNSHIFTED[code] ?? null;
}

// 全角の字は 0xFEE0 を引くと半角になる（U+FF01〜FF5E）。
function fullWidthToHalf(key: string): string | null {
  if (key.length !== 1) return null;
  const cp = key.charCodeAt(0);
  return cp >= 0xff01 && cp <= 0xff5e ? String.fromCharCode(cp - 0xfee0) : null;
}

const isPrintableAscii = (key: string): boolean => key.length === 1 && key >= "!" && key <= "~";

export function halfWidthKeyOf(input: KeyInput): HalfWidthKey | null {
  const { key, code, shiftKey, ctrlKey, altKey, metaKey } = input;
  const make = (k: string | null): HalfWidthKey | null => (k === null ? null : { key: k, code, shiftKey, ctrlKey, altKey, metaKey });

  const half = fullWidthToHalf(key);
  if (half !== null) return make(half);
  if (key === "Process" || key === "Unidentified") return make(charOfCode(code, shiftKey));
  if (input.isComposing && key.length === 1) {
    return make(isPrintableAscii(key) ? key : charOfCode(code, shiftKey));
  }
  return null;
}
