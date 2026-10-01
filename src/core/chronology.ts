// 时间派生信息：兄弟结点的顺序、每天第一个结点的日期标记、子结点早于父结点的违规标记。
//
// 兄弟结点的顺序不单独存储，由时间决定；文件里的顺序只用来打破时间相同的平局。
// 时间格式 `YYYY-MM-DD HH:MM` 按字符串比较即按时间比较。

import type { TreeNode } from "./note";

/** 子结点按时间从早到晚排列；时间相同时保持文件里的顺序。 */
export function sortedChildren(node: TreeNode): TreeNode[] {
  return [...node.children].sort((a, b) => compareTime(a.time, b.time));
}

function compareTime(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * 每天第一个出现的结点：按时间最早，时间相同时取树里靠前的（先父后子，先左后右）。
 * 返回这些结点的 id，界面在它们的时间前面额外显示日期。
 */
export function dayMarkers(root: TreeNode): ReadonlySet<string> {
  const firstOfDay = new Map<string, TreeNode>();
  const visit = (node: TreeNode) => {
    const day = node.time.slice(0, 10);
    const first = firstOfDay.get(day);
    if (!first || node.time < first.time) firstOfDay.set(day, node);
    sortedChildren(node).forEach(visit);
  };
  visit(root);
  return new Set([...firstOfDay.values()].map((n) => n.id));
}

/** 时间早于父结点的结点 id。只和直接的父结点比较；这种结点照样可以保存，界面标红提示。 */
export function timeViolations(root: TreeNode): ReadonlySet<string> {
  const ids = new Set<string>();
  const visit = (node: TreeNode) => {
    for (const child of node.children) {
      if (child.time < node.time) ids.add(child.id);
      visit(child);
    }
  };
  visit(root);
  return ids;
}
