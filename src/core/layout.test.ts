import { describe, expect, it } from "vitest";
import { parseNote } from "./format";
import { layoutTree, type LayoutOptions } from "./layout";
import { findNode, type TreeNode } from "./note";

const OPTIONS: LayoutOptions = { nodeWidth: 100, horizontalGap: 10, verticalGap: 20, defaultHeight: 40 };

//                 根
//         ┌───────┴───────┐
//         A               B
//      ┌──┴──┐            │
//      A1    A2           B1
const TREE = `# 布局

- [事件 2026-09-30 09:00] 根
  - [事件 2026-09-30 10:00] A
    - [事件 2026-09-30 10:10] A1
    - [事件 2026-09-30 10:20] A2
  - [事件 2026-09-30 11:00] B
    - [事件 2026-09-30 11:10] B1
`;

function parseTree(md: string): TreeNode {
  const result = parseNote(md);
  if (!result.ok) throw new Error(result.error.message);
  return result.note.root;
}

function idOf(root: TreeNode, text: string): string {
  const node = findNode(root, (n) => n.text === text);
  if (!node) throw new Error(`no node with text ${text}`);
  return node.id;
}

describe("layoutTree with collapsed nodes", () => {
  it("leaves out the descendants of a collapsed node but keeps the node itself", () => {
    const root = parseTree(TREE);
    const layout = layoutTree(root, new Map(), OPTIONS, new Set([idOf(root, "A")]));
    expect(layout.boxes.map((b) => b.node.text).sort()).toEqual(["A", "B", "B1", "根"]);
    expect(layout.links.map((l) => l.child.node.text).sort()).toEqual(["A", "B", "B1"]);
  });

  it("does not reserve room for hidden nodes", () => {
    const root = parseTree(TREE);
    const width = (collapsed: ReadonlySet<string>) => {
      const { minX, maxX } = layoutTree(root, new Map(), OPTIONS, collapsed).bounds;
      return maxX - minX;
    };
    // 折叠 A 之后最宽的一层只剩 A、B 两个结点。
    expect(width(new Set([idOf(root, "A")]))).toBe(210);
    // 展开时最底层是 A1、A2、B1；d3 默认让不同父结点的相邻结点间隔两倍。
    expect(width(new Set())).toBe(430);
  });
});
