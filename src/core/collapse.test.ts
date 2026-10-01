import { describe, expect, it } from "vitest";
import { expand, hiddenCount, toggleCollapsed } from "./collapse";
import { parseNote } from "./format";
import { findNode, type TreeNode } from "./note";

const TREE = `# 折叠

- [事件 2026-09-30 09:00] 根
  - [事件 2026-09-30 10:00] A
    - [事件 2026-09-30 10:10] A1
      - [事件 2026-09-30 10:15] A1a
    - [事件 2026-09-30 10:20] A2
  - [事件 2026-09-30 11:00] B
`;

function parseTree(md: string): TreeNode {
  const result = parseNote(md);
  if (!result.ok) throw new Error(result.error.message);
  return result.note.root;
}

function nodeOf(root: TreeNode, text: string): TreeNode {
  const node = findNode(root, (n) => n.text === text);
  if (!node) throw new Error(`no node with text ${text}`);
  return node;
}

describe("toggleCollapsed", () => {
  it("collapses an expanded node and expands it again", () => {
    const root = parseTree(TREE);
    const a = nodeOf(root, "A");
    const collapsed = toggleCollapsed(new Set(), a);
    expect([...collapsed]).toEqual([a.id]);
    expect([...toggleCollapsed(collapsed, a)]).toEqual([]);
  });

  it("does nothing on a leaf, which has nothing to hide", () => {
    const root = parseTree(TREE);
    expect([...toggleCollapsed(new Set(), nodeOf(root, "B"))]).toEqual([]);
  });

  it("keeps other collapsed nodes untouched", () => {
    const root = parseTree(TREE);
    const a1 = nodeOf(root, "A1");
    const a = nodeOf(root, "A");
    expect([...toggleCollapsed(new Set([a1.id]), a)].sort()).toEqual([a.id, a1.id].sort());
  });
});

describe("expand", () => {
  it("expands a collapsed node and leaves the others collapsed", () => {
    const root = parseTree(TREE);
    const a = nodeOf(root, "A");
    const a1 = nodeOf(root, "A1");
    expect([...expand(new Set([a.id, a1.id]), a.id)]).toEqual([a1.id]);
  });

  it("does nothing on a node that is already expanded", () => {
    const root = parseTree(TREE);
    const collapsed = new Set([nodeOf(root, "A1").id]);
    expect(expand(collapsed, nodeOf(root, "A").id)).toBe(collapsed);
  });
});

describe("hiddenCount", () => {
  it("counts every descendant of a collapsed node", () => {
    const root = parseTree(TREE);
    expect(hiddenCount(nodeOf(root, "A"))).toBe(3);
    expect(hiddenCount(root)).toBe(5);
    expect(hiddenCount(nodeOf(root, "B"))).toBe(0);
  });
});
