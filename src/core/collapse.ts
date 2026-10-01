// 折叠：在选择状态下按空格折叠或展开当前结点的子树。
//
// 折叠集合只保存在内存里，不写进文件。没有子结点的结点没有可隐藏的内容，不能折叠。

import type { TreeNode } from "./note";

export function toggleCollapsed(collapsed: ReadonlySet<string>, node: TreeNode): ReadonlySet<string> {
  const next = new Set(collapsed);
  if (next.has(node.id)) next.delete(node.id);
  else if (node.children.length > 0) next.add(node.id);
  return next;
}

/** 折叠这个结点后被隐藏的结点数量，即它的全部后代。 */
export function hiddenCount(node: TreeNode): number {
  return node.children.reduce((sum, child) => sum + 1 + hiddenCount(child), 0);
}
