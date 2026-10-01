import { isValidElement, type ReactElement, type ReactNode } from "react";

// 関数として直接呼んだ部品が返す要素の木から、指定したタグの要素を前から順に集める（DOM を使わずにクリックの配線を確かめる）。
export function findAll(node: ReactNode, tag: string): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap((n) => findAll(n, tag));
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  const own = node.type === tag ? [node] : [];
  return [...own, ...findAll(node.props.children as ReactNode, tag)];
}

// 要素の木に含まれる文字をつなげて返す。
export function textOf(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (!isValidElement<Record<string, unknown>>(node)) return "";
  return textOf(node.props.children as ReactNode);
}
