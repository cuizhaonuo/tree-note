// 导航：在选择状态下用方向键在结点之间移动。
//
// ↑ 到父结点；↓ 到上次访问过的子结点，没访问过就到时间最早的子结点；
// ← / → 到屏幕上同一层相邻的结点，可以跨过不同的子树。
// 被折叠的结点的后代不可见，导航会跳过它们。

import type { TreeLayout } from "./layout";
import { findNode, type TreeNode } from "./note";

export type Direction = "up" | "down" | "left" | "right";

export interface NavState {
  selectedId: string;
  /** 结点 id → 它上次访问过的子结点 id。只保存在内存里。 */
  lastVisitedChild: ReadonlyMap<string, string>;
}

export interface NavView {
  /** 被折叠的结点 id：它们的后代不可见。 */
  collapsed: ReadonlySet<string>;
  layout: TreeLayout;
}

export function initialNavState(root: TreeNode): NavState {
  return { selectedId: root.id, lastVisitedChild: new Map() };
}

export function navigate(root: TreeNode, state: NavState, direction: Direction, view: NavView): NavState {
  const parents = parentMap(root);
  const selected = findNode(root, (n) => n.id === state.selectedId);
  if (!selected) return initialNavState(root);

  const target = (() => {
    switch (direction) {
      case "up":
        return parents.get(selected.id);
      case "down":
        return childToEnter(selected, state.lastVisitedChild, view.collapsed);
      case "left":
        return rowNeighbour(selected, -1, parents, view);
      case "right":
        return rowNeighbour(selected, 1, parents, view);
    }
  })();
  if (!target) return state;
  return { selectedId: target.id, lastVisitedChild: recordVisit(target, parents, state.lastVisitedChild) };
}

function childToEnter(
  node: TreeNode,
  lastVisitedChild: ReadonlyMap<string, string>,
  collapsed: ReadonlySet<string>,
): TreeNode | undefined {
  if (collapsed.has(node.id) || node.children.length === 0) return undefined;
  const remembered = node.children.find((c) => c.id === lastVisitedChild.get(node.id));
  // 时间格式 `YYYY-MM-DD HH:MM` 按字符串比较即按时间比较；时间相同时取文件里靠前的。
  return remembered ?? node.children.reduce((earliest, c) => (c.time < earliest.time ? c : earliest));
}

/** 屏幕上同一层、在 `step` 方向上紧挨着的可见结点。 */
function rowNeighbour(
  node: TreeNode,
  step: -1 | 1,
  parents: ReadonlyMap<string, TreeNode>,
  view: NavView,
): TreeNode | undefined {
  const box = view.layout.boxes.find((b) => b.node.id === node.id);
  if (!box) return undefined;
  const row = view.layout.boxes
    .filter((b) => b.depth === box.depth && isVisible(b.node, parents, view.collapsed))
    .sort((a, b) => a.x - b.x);
  return row[row.indexOf(box) + step]?.node;
}

function isVisible(node: TreeNode, parents: ReadonlyMap<string, TreeNode>, collapsed: ReadonlySet<string>): boolean {
  for (let p = parents.get(node.id); p; p = parents.get(p.id)) {
    if (collapsed.has(p.id)) return false;
  }
  return true;
}

/** 选中一个结点时，它路径上的每个祖先都记住“上次访问过的子结点”。 */
function recordVisit(
  node: TreeNode,
  parents: ReadonlyMap<string, TreeNode>,
  lastVisitedChild: ReadonlyMap<string, string>,
): ReadonlyMap<string, string> {
  const next = new Map(lastVisitedChild);
  for (let child = node, p = parents.get(node.id); p; child = p, p = parents.get(p.id)) {
    next.set(p.id, child.id);
  }
  return next;
}

function parentMap(root: TreeNode): Map<string, TreeNode> {
  const parents = new Map<string, TreeNode>();
  const stack = [root];
  while (stack.length) {
    const node = stack.pop()!;
    for (const child of node.children) {
      parents.set(child.id, node);
      stack.push(child);
    }
  }
  return parents;
}
