import { describe, expect, it } from "vitest";
import { applyCommand, initialEditorState } from "./commands";
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

describe("layoutTree sibling order", () => {
  /** 每一层的结点文本，从左到右。 */
  function rows(root: TreeNode): string[][] {
    const { boxes } = layoutTree(root, new Map(), OPTIONS, new Set());
    const result: string[][] = [];
    for (const box of [...boxes].sort((a, b) => a.x - b.x)) (result[box.depth] ??= []).push(box.node.text);
    return result;
  }

  it("places siblings left to right by time, whatever their order in the file", () => {
    const root = parseTree(`# 乱序

- [事件 2026-09-30 09:00] 根
  - [事件 2026-09-30 11:00] B
    - [事件 2026-09-30 11:20] B2
    - [事件 2026-09-30 11:10] B1
  - [事件 2026-09-30 10:00] A
`);
    expect(rows(root)).toEqual([["根"], ["A", "B"], ["B1", "B2"]]);
  });

  it("compares dates before clock times", () => {
    const root = parseTree(`# 跨天

- [事件 2026-09-30 09:00] 根
  - [事件 2026-10-01 08:00] 第二天早上
  - [事件 2026-09-30 23:00] 当天夜里
`);
    expect(rows(root)[1]).toEqual(["当天夜里", "第二天早上"]);
  });

  it("keeps the file order for siblings with the same time", () => {
    const root = parseTree(`# 同时

- [事件 2026-09-30 09:00] 根
  - [事件 2026-09-30 10:00] 甲
  - [事件 2026-09-30 10:00] 乙
  - [事件 2026-09-30 09:30] 丙
`);
    expect(rows(root)[1]).toEqual(["丙", "甲", "乙"]);
  });
});

describe("layoutTree after setTime", () => {
  it("moves a node to its new place among its siblings", () => {
    const parsed = parseNote(TREE);
    if (!parsed.ok) throw new Error(parsed.error.message);
    let state = initialEditorState(parsed.note);
    state = { ...state, selectedId: idOf(state.note.root, "A") };
    state = applyCommand(state, { type: "setTime", time: "2026-09-30 12:00" });
    const { boxes } = layoutTree(state.note.root, new Map(), OPTIONS, new Set());
    const row = boxes.filter((b) => b.depth === 1).sort((a, b) => a.x - b.x);
    expect(row.map((b) => b.node.text)).toEqual(["B", "A"]);
  });
});
