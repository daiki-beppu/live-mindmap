// 標準出力・標準エラーへ Console 経由で出す文字列の改行の規則。Console.log／Console.error が末尾に改行を足すので、
// 改行で終わる文字列はその 1 つを外して渡す（出力のバイト列を、書いた文字列のままに保つ）。この規則はここだけが持つ
export const withoutFinalNewline = (text: string): string => (text.endsWith("\n") ? text.slice(0, -1) : text);
