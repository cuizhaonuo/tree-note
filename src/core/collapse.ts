// 折叠：在选择状态下按空格折叠或展开当前结点的子树。
//
// 折叠集合只保存在内存里，不写进文件。没有子结点的结点没有可隐藏的内容，不能折叠。

import { parentMap } from "./navigation";
import type { TreeNode } from "./note";

export function toggleCollapsed(collapsed: ReadonlySet<string>, node: TreeNode): ReadonlySet<string> {
  const next = new Set(collapsed);
  if (next.has(node.id)) next.delete(node.id);
  else if (node.children.length > 0) next.add(node.id);
  return next;
}

/** 展开一个结点（例如要在它下面新建子结点）。本来就展开着时原样返回。 */
export function expand(collapsed: ReadonlySet<string>, id: string): ReadonlySet<string> {
  if (!collapsed.has(id)) return collapsed;
  const next = new Set(collapsed);
  next.delete(id);
  return next;
}

/** 展开结点的所有祖先，让它可见（例如撤销或粘贴后选中了一个被折叠住的结点）。本来就可见时原样返回。 */
export function reveal(collapsed: ReadonlySet<string>, root: TreeNode, id: string): ReadonlySet<string> {
  const parents = parentMap(root);
  let next = collapsed;
  for (let p = parents.get(id); p; p = parents.get(p.id)) next = expand(next, p.id);
  return next;
}

/** 折叠这个结点后被隐藏的结点数量，即它的全部后代。 */
export function hiddenCount(node: TreeNode): number {
  return node.children.reduce((sum, child) => sum + 1 + hiddenCount(child), 0);
}
