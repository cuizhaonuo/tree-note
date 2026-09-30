// 领域模型：一篇笔记是一个标题加一棵树。标题不是结点。

export type NodeKind = "event" | "idea";

export interface TreeNode {
  /** 只在内存中使用，不写进文件。 */
  id: string;
  kind: NodeKind;
  /** 本地时间，精确到分钟，格式 `YYYY-MM-DD HH:MM`。 */
  time: string;
  /** 多行文本，可含行内 Markdown。 */
  text: string;
  children: TreeNode[];
}

export interface Note {
  title: string;
  root: TreeNode;
}

let nextId = 0;

export function newNodeId(): string {
  nextId++;
  return `n${nextId}`;
}
