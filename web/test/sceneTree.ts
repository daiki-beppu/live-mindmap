// scene テストが描いた木（VNode）を読む関数。会議・見返しのハーネスと、それを使うテストで同じものを使う
import { Option } from "effect";
import { attr, find, findAll, textContent } from "foldkit/scene";

export type VNode = Parameters<typeof textContent>[0];

export const attrOf = (vnode: VNode, name: string): string | undefined => Option.getOrUndefined(attr(vnode, name));
export const elementsOf = (vnode: VNode): VNode[] => (vnode.children ?? []).filter((c): c is VNode => typeof c !== "string" && c.sel !== undefined);
export const one = (html: VNode, css: string): VNode => Option.getOrThrow(find(html, css));
export const styleOf = (vnode: VNode): Record<string, string> => ((vnode.data as { style?: Record<string, string> } | undefined)?.style ?? {}) as Record<string, string>;

// マップのノード（data-node-id を持つ要素）の id
export const renderedIds = (html: VNode): string[] => findAll(html, "[data-node-id]").map((v) => attrOf(v, "data-node-id")!);
