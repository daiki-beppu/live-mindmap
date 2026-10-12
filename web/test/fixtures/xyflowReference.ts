// @xyflow/system 0.0.83 の関数のうち、Foldkit の表示面の式の「写す元」にする 3 つ（Issue #829）。
// 出どころ: @xyflow/system 0.0.83 の dist/esm/index.js の getViewportForBounds（と parsePadding(s)・calculateAppliedPaddings・rendererPointToPoint・clamp）、getBezierPath（と getBezierEdgeCenter・calculateControlOffset・getControlWithCurvature）、Position。
// ライセンス: MIT（Copyright (c) 2019-2025 webkid GmbH）。下に全文。
// React と @xyflow を web の依存から消した後も、描いたマップの式（全体を収めるビューポート・エッジのベジェ）が React Flow と同じ値になることを、このテストの正解として比べ続けるために写した。
// 値の式は原本のままで、描き直していない（型の注釈だけを足した）。実装が式を変えたら、これと比べるテストが落ちる。
//
// MIT License
//
// Copyright (c) 2019-2025 webkid GmbH
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

export const Position = { Left: "left", Top: "top", Right: "right", Bottom: "bottom" } as const;
export type Position = (typeof Position)[keyof typeof Position];

type Bounds = { x: number; y: number; width: number; height: number };
type Viewport = { x: number; y: number; zoom: number };

const clamp = (val: number, min = 0, max = 1): number => Math.min(Math.max(val, min), max);

const rendererPointToPoint = ({ x, y }: { x: number; y: number }, [tx, ty, tScale]: [number, number, number]) => ({ x: x * tScale + tx, y: y * tScale + ty });

// padding は数値（割合）だけを使う（fitView の padding 0.1）
const parsePadding = (padding: number, viewport: number): number => Math.floor((viewport - viewport / (1 + padding)) * 0.5);

const parsePaddings = (padding: number, width: number, height: number) => {
  const paddingY = parsePadding(padding, height);
  const paddingX = parsePadding(padding, width);
  return { top: paddingY, right: paddingX, bottom: paddingY, left: paddingX, x: paddingX * 2, y: paddingY * 2 };
};

const calculateAppliedPaddings = (bounds: Bounds, x: number, y: number, zoom: number, width: number, height: number) => {
  const { x: left, y: top } = rendererPointToPoint(bounds, [x, y, zoom]);
  const { x: boundRight, y: boundBottom } = rendererPointToPoint({ x: bounds.x + bounds.width, y: bounds.y + bounds.height }, [x, y, zoom]);
  const right = width - boundRight;
  const bottom = height - boundBottom;
  return { left: Math.floor(left), top: Math.floor(top), right: Math.floor(right), bottom: Math.floor(bottom) };
};

export const getViewportForBounds = (bounds: Bounds, width: number, height: number, minZoom: number, maxZoom: number, padding: number): Viewport => {
  // First we resolve all the paddings to actual pixel values
  const p = parsePaddings(padding, width, height);
  const xZoom = (width - p.x) / bounds.width;
  const yZoom = (height - p.y) / bounds.height;
  // We calculate the new x, y, zoom for a centered view
  const zoom = Math.min(xZoom, yZoom);
  const clampedZoom = clamp(zoom, minZoom, maxZoom);
  const boundsCenterX = bounds.x + bounds.width / 2;
  const boundsCenterY = bounds.y + bounds.height / 2;
  const x = width / 2 - boundsCenterX * clampedZoom;
  const y = height / 2 - boundsCenterY * clampedZoom;
  // Then we calculate the minimum padding, to respect asymmetric paddings
  const newPadding = calculateAppliedPaddings(bounds, x, y, clampedZoom, width, height);
  // We only want to have an offset if the newPadding is smaller than the required padding
  const offset = {
    left: Math.min(newPadding.left - p.left, 0),
    top: Math.min(newPadding.top - p.top, 0),
    right: Math.min(newPadding.right - p.right, 0),
    bottom: Math.min(newPadding.bottom - p.bottom, 0),
  };
  return { x: x - offset.left + offset.right, y: y - offset.top + offset.bottom, zoom: clampedZoom };
};

const getBezierEdgeCenter = ({ sourceX, sourceY, targetX, targetY, sourceControlX, sourceControlY, targetControlX, targetControlY }: Record<string, number>) => {
  // cubic bezier t=0.5 mid point, not the actual mid point, but easy to calculate
  const centerX = sourceX! * 0.125 + sourceControlX! * 0.375 + targetControlX! * 0.375 + targetX! * 0.125;
  const centerY = sourceY! * 0.125 + sourceControlY! * 0.375 + targetControlY! * 0.375 + targetY! * 0.125;
  const offsetX = Math.abs(centerX - sourceX!);
  const offsetY = Math.abs(centerY - sourceY!);
  return [centerX, centerY, offsetX, offsetY] as const;
};

const calculateControlOffset = (distance: number, curvature: number): number => (distance >= 0 ? 0.5 * distance : curvature * 25 * Math.sqrt(-distance));

const getControlWithCurvature = ({ pos, x1, y1, x2, y2, c }: { pos: Position; x1: number; y1: number; x2: number; y2: number; c: number }): [number, number] => {
  switch (pos) {
    case Position.Left:
      return [x1 - calculateControlOffset(x1 - x2, c), y1];
    case Position.Right:
      return [x1 + calculateControlOffset(x2 - x1, c), y1];
    case Position.Top:
      return [x1, y1 - calculateControlOffset(y1 - y2, c)];
    case Position.Bottom:
      return [x1, y1 + calculateControlOffset(y2 - y1, c)];
  }
};

export const getBezierPath = ({
  sourceX,
  sourceY,
  sourcePosition = Position.Bottom,
  targetX,
  targetY,
  targetPosition = Position.Top,
  curvature = 0.25,
}: {
  sourceX: number;
  sourceY: number;
  sourcePosition?: Position;
  targetX: number;
  targetY: number;
  targetPosition?: Position;
  curvature?: number;
}): readonly [path: string, labelX: number, labelY: number, offsetX: number, offsetY: number] => {
  const [sourceControlX, sourceControlY] = getControlWithCurvature({ pos: sourcePosition, x1: sourceX, y1: sourceY, x2: targetX, y2: targetY, c: curvature });
  const [targetControlX, targetControlY] = getControlWithCurvature({ pos: targetPosition, x1: targetX, y1: targetY, x2: sourceX, y2: sourceY, c: curvature });
  const [labelX, labelY, offsetX, offsetY] = getBezierEdgeCenter({ sourceX, sourceY, targetX, targetY, sourceControlX, sourceControlY, targetControlX, targetControlY });
  return [`M${sourceX},${sourceY} C${sourceControlX},${sourceControlY} ${targetControlX},${targetControlY} ${targetX},${targetY}`, labelX, labelY, offsetX, offsetY];
};
