// 布局：用 d3-hierarchy 的 tidy tree 算法把树自上而下排开。
//
// 结点宽度固定，高度由界面测量后传入（多行文本高度不同）。
// 同一深度的结点排在同一行，行高取这一层最高的结点。
// 被折叠的结点的后代不参与布局，也不占位置。

import { hierarchy, tree } from "d3-hierarchy";
import type { TreeNode } from "./note";

export interface LayoutOptions {
  nodeWidth: number;
  /** 兄弟结点之间的水平间距。 */
  horizontalGap: number;
  /** 相邻两层之间的垂直间距。 */
  verticalGap: number;
  /** 尚未测量到高度的结点使用这个高度。 */
  defaultHeight: number;
}

export interface NodeBox {
  node: TreeNode;
  depth: number;
  /** 左上角坐标，根结点的中心线在 x = 0。 */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Link {
  parent: NodeBox;
  child: NodeBox;
}

export interface TreeLayout {
  boxes: NodeBox[];
  links: Link[];
  /** 所有结点的包围盒。 */
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
}

export function layoutTree(
  root: TreeNode,
  heights: ReadonlyMap<string, number>,
  options: LayoutOptions,
  collapsed: ReadonlySet<string> = new Set(),
): TreeLayout {
  const { nodeWidth, horizontalGap, verticalGap, defaultHeight } = options;
  const heightOf = (node: TreeNode) => heights.get(node.id) ?? defaultHeight;

  const h = hierarchy(root, (node) => (collapsed.has(node.id) ? undefined : node.children));
  // 行高只影响 y，x 由 tidy tree 计算，所以 nodeSize 的第二维用 1 占位。
  tree<TreeNode>().nodeSize([nodeWidth + horizontalGap, 1])(h);

  const rowHeights: number[] = [];
  h.each((d) => {
    rowHeights[d.depth] = Math.max(rowHeights[d.depth] ?? 0, heightOf(d.data));
  });
  const rowTops: number[] = [];
  let top = 0;
  for (const rowHeight of rowHeights) {
    rowTops.push(top);
    top += rowHeight + verticalGap;
  }

  const boxById = new Map<string, NodeBox>();
  const boxes: NodeBox[] = [];
  h.each((d) => {
    const box: NodeBox = {
      node: d.data,
      depth: d.depth,
      x: (d.x ?? 0) - nodeWidth / 2,
      y: rowTops[d.depth],
      width: nodeWidth,
      height: heightOf(d.data),
    };
    boxById.set(d.data.id, box);
    boxes.push(box);
  });

  const links: Link[] = h.links().map(({ source, target }) => ({
    parent: boxById.get(source.data.id)!,
    child: boxById.get(target.data.id)!,
  }));

  const bounds = {
    minX: Math.min(...boxes.map((b) => b.x)),
    minY: 0,
    maxX: Math.max(...boxes.map((b) => b.x + b.width)),
    maxY: Math.max(...boxes.map((b) => b.y + b.height)),
  };

  return { boxes, links, bounds };
}
