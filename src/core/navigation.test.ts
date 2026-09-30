import { describe, expect, it } from "vitest";
import { parseNote } from "./format";
import { layoutTree, type TreeLayout } from "./layout";
import { initialNavState, navigate, type Direction, type NavState } from "./navigation";
import { findNode, type TreeNode } from "./note";

// 这棵树在屏幕上排成三层：
//
//                 根
//         ┌───────┴───────┐
//         A               B
//      ┌──┴──┐         ┌──┴──┐
//      A1    A2        B1    B2
const TREE = `# 导航

- [事件 2026-09-30 09:00] 根
  - [事件 2026-09-30 10:00] A
    - [事件 2026-09-30 10:10] A1
    - [事件 2026-09-30 10:20] A2
  - [事件 2026-09-30 11:00] B
    - [事件 2026-09-30 11:10] B1
    - [事件 2026-09-30 11:20] B2
`;

function parseTree(md: string): TreeNode {
  const result = parseNote(md);
  if (!result.ok) throw new Error(result.error.message);
  return result.note.root;
}

function layoutOf(root: TreeNode): TreeLayout {
  return layoutTree(root, new Map(), {
    nodeWidth: 100,
    horizontalGap: 10,
    verticalGap: 20,
    defaultHeight: 40,
  });
}

/** 按文本找结点 id，测试里用文本指代结点更易读。 */
function idOf(root: TreeNode, text: string): string {
  const node = findNode(root, (n) => n.text === text);
  if (!node) throw new Error(`no node with text ${text}`);
  return node.id;
}

function textOf(root: TreeNode, id: string): string {
  const node = findNode(root, (n) => n.id === id);
  if (!node) throw new Error(`no node with id ${id}`);
  return node.text;
}

/** 从根结点出发依次按下方向键，返回每一步之后选中结点的文本。 */
function press(
  root: TreeNode,
  keys: Direction[],
  options: { collapsed?: ReadonlySet<string>; from?: NavState } = {},
): string[] {
  const layout = layoutOf(root);
  const collapsed = options.collapsed ?? new Set<string>();
  let state = options.from ?? initialNavState(root);
  return keys.map((key) => {
    state = navigate(root, state, key, { collapsed, layout });
    return textOf(root, state.selectedId);
  });
}

describe("initialNavState", () => {
  it("selects the root when a note is opened", () => {
    const root = parseTree(TREE);
    expect(initialNavState(root).selectedId).toBe(root.id);
  });
});

describe("↑", () => {
  it("does nothing on the root", () => {
    const root = parseTree(TREE);
    expect(press(root, ["up"])).toEqual(["根"]);
  });

  it("moves to the parent", () => {
    const root = parseTree(TREE);
    expect(press(root, ["down", "down", "up", "up"])).toEqual(["A", "A1", "A", "根"]);
  });
});

describe("↓", () => {
  it("moves to the earliest child when no child has been visited", () => {
    // 文件里后写的子结点时间更早，↓ 仍然应该去时间最早的那个。
    const root = parseTree(`# 导航

- [事件 2026-09-30 09:00] 根
  - [事件 2026-09-30 12:00] 晚
  - [事件 2026-09-30 10:00] 早
`);
    expect(press(root, ["down"])).toEqual(["早"]);
  });

  it("does nothing on a leaf", () => {
    const root = parseTree(TREE);
    expect(press(root, ["down", "down", "down"])).toEqual(["A", "A1", "A1"]);
  });

  it("returns to the child visited last", () => {
    const root = parseTree(TREE);
    expect(press(root, ["down", "right", "up", "down"])).toEqual(["A", "B", "根", "B"]);
  });

  it("remembers the last visited child at every level of the path", () => {
    const root = parseTree(TREE);
    expect(press(root, ["down", "down", "right", "up", "up", "down", "down"])).toEqual([
      "A", "A1", "A2", "A", "根", "A", "A2",
    ]);
  });

  it("remembers a child reached by crossing into another subtree", () => {
    const root = parseTree(TREE);
    // 从 A2 → 跨到 B1，B 上次访问过的子结点就是 B1。
    expect(press(root, ["down", "down", "right", "right", "up", "up", "down", "down"])).toEqual([
      "A", "A1", "A2", "B1", "B", "根", "B", "B1",
    ]);
  });

  it("does not descend into a collapsed node", () => {
    const root = parseTree(TREE);
    const collapsed = new Set([idOf(root, "A")]);
    expect(press(root, ["down", "down"], { collapsed })).toEqual(["A", "A"]);
  });

  it("falls back to the earliest child when the remembered child is gone", () => {
    const root = parseTree(TREE);
    const from: NavState = {
      selectedId: root.id,
      lastVisitedChild: new Map([[root.id, "deleted-node"]]),
    };
    expect(press(root, ["down"], { from })).toEqual(["A"]);
  });
});

describe("← / →", () => {
  it("moves between siblings", () => {
    const root = parseTree(TREE);
    expect(press(root, ["down", "right", "left"])).toEqual(["A", "B", "A"]);
  });

  it("does nothing at either end of the row", () => {
    const root = parseTree(TREE);
    expect(press(root, ["left", "right"])).toEqual(["根", "根"]);
    expect(press(root, ["down", "left", "right", "right"])).toEqual(["A", "A", "B", "B"]);
  });

  it("crosses into the neighbouring subtree on the same row", () => {
    const root = parseTree(TREE);
    expect(press(root, ["down", "down", "right", "right", "right", "left", "left", "left", "left"])).toEqual([
      "A", "A1", "A2", "B1", "B2", "B1", "A2", "A1", "A1",
    ]);
  });

  it("jumps over a subtree that has nothing on this row", () => {
    const root = parseTree(`# 导航

- [事件 2026-09-30 09:00] 根
  - [事件 2026-09-30 10:00] A
    - [事件 2026-09-30 10:10] A1
  - [事件 2026-09-30 11:00] M
  - [事件 2026-09-30 12:00] B
    - [事件 2026-09-30 12:10] B1
`);
    expect(press(root, ["down", "down", "right", "left"])).toEqual(["A", "A1", "B1", "A1"]);
  });

  it("skips nodes hidden inside a collapsed subtree", () => {
    const root = parseTree(`# 导航

- [事件 2026-09-30 09:00] 根
  - [事件 2026-09-30 10:00] A
    - [事件 2026-09-30 10:10] A1
  - [事件 2026-09-30 11:00] M
    - [事件 2026-09-30 11:10] M1
  - [事件 2026-09-30 12:00] B
    - [事件 2026-09-30 12:10] B1
`);
    const collapsed = new Set([idOf(root, "M")]);
    expect(press(root, ["down", "down", "right", "left"], { collapsed })).toEqual(["A", "A1", "B1", "A1"]);
  });
});
