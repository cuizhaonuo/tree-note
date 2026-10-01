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

/** 深度优先找第一个满足条件的结点。 */
export function findNode(root: TreeNode, predicate: (node: TreeNode) => boolean): TreeNode | undefined {
  const stack = [root];
  while (stack.length) {
    const node = stack.pop()!;
    if (predicate(node)) return node;
    stack.push(...node.children);
  }
  return undefined;
}

/** 新建结点默认是一个空的事件。 */
export function newEventNode(time: string): TreeNode {
  return { id: newNodeId(), kind: "event", time, text: "", children: [] };
}

/** 把本地时间格式化成结点时间 `YYYY-MM-DD HH:MM`。 */
export function formatNodeTime(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 结点时间的日期部分 `YYYY-MM-DD`。 */
export function nodeDate(time: string): string {
  return time.slice(0, 10);
}

/** 结点时间的时刻部分 `HH:MM`。 */
export function nodeClock(time: string): string {
  return time.slice(11);
}

/** `time` 是否是格式为 `YYYY-MM-DD HH:MM`、并且真实存在的日期和时间。 */
export function isValidNodeTime(time: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(time);
  if (!match) return false;
  const [y, m, d, hh, mm] = match.slice(1).map(Number);
  const probe = new Date(y, m - 1, d);
  return probe.getFullYear() === y && probe.getMonth() === m - 1 && probe.getDate() === d && hh < 24 && mm < 60;
}
