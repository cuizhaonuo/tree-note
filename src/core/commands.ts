// 命令：applyCommand(状态, 命令) → 新状态。
//
// 状态是不可变的：命令返回新的笔记对象，只复制从根到被修改结点的那条路径。
//
// 撤销：每个改变了笔记的操作之前，记下当时的笔记和选中的结点。一次编辑（包括新建结点后
// 输入文字）从开始到确认算一步，确认时笔记没有变化就不记。撤销历史只保存在内存里。

import { initialNavState, parentMap, selectNode, type NavState } from "./navigation";
import { findNode, isValidNodeTime, newEventNode, type Note, type TreeNode } from "./note";

export interface EditorState extends NavState {
  note: Note;
  /** 正在编辑的结点 id；null 表示选择状态。 */
  editingId: string | null;
  /** 按 `x` 标记要剪切的结点 id；null 表示没有。 */
  cutId: string | null;
  /** 撤销历史，最近的一步在最后。 */
  undoStack: readonly Snapshot[];
  /** 编辑开始前的快照，确认时笔记有变化就记为一步；选择状态下是 null。 */
  editStart: Snapshot | null;
}

interface Snapshot {
  note: Note;
  selectedId: string;
}

export type Command =
  /** 新建子结点并开始编辑。`time` 是当前时间。 */
  | { type: "addChild"; time: string }
  /** 新建兄弟结点并开始编辑。根结点没有兄弟，什么都不做。 */
  | { type: "addSibling"; time: string }
  /** 编辑状态下替换正在编辑的结点的文本。 */
  | { type: "setText"; text: string }
  /** 进入编辑状态：编辑给定的结点（双击），没给就编辑选中的结点（F2）。 */
  | { type: "startEdit"; nodeId?: string }
  /** 确认编辑（Enter 或 Esc），回到选择状态。 */
  | { type: "commitEdit" }
  /** 删除选中的结点及其整棵子树，并选中它的父结点。根结点不能删除。 */
  | { type: "deleteSubtree" }
  /** 标记选中的结点要剪切；再按一次取消。根结点不能剪切。 */
  | { type: "cut" }
  /** 把被剪切的结点连同子树移成选中结点的子结点，并选中它。不能粘贴到它自己或它自己的子树里。 */
  | { type: "paste" }
  /** 选中的结点在事件和想法之间切换。 */
  | { type: "toggleKind" }
  /** 修改选中结点的时间。子结点可以早于父结点（界面会标红提示）。 */
  | { type: "setTime"; time: string }
  /** 修改笔记标题，去掉首尾空白。只改标题，不影响根结点。标题不能为空。 */
  | { type: "rename"; title: string }
  /** 撤销最近一步改变笔记的操作，恢复当时的笔记和选中的结点。 */
  | { type: "undo" };

/** 这些命令只在选择状态下有效，编辑状态下忽略。 */
const SELECTION_COMMANDS: ReadonlySet<Command["type"]> = new Set([
  "addChild",
  "addSibling",
  "startEdit",
  "deleteSubtree",
  "cut",
  "paste",
  "toggleKind",
  "setTime",
  "rename",
  "undo",
]);

export function initialEditorState(note: Note): EditorState {
  return { note, editingId: null, cutId: null, undoStack: [], editStart: null, ...initialNavState(note.root) };
}

/** 新建笔记：根结点是一个空的事件，时间为 `time`，并且直接进入编辑状态。 */
export function newNoteState(title: string, time: string): EditorState {
  const root = newEventNode(time);
  const state = initialEditorState({ title, root });
  return { ...state, editingId: root.id, editStart: snapshot(state) };
}

/**
 * 用户期望有效果、却被规则拒绝的命令，返回给用户看的原因；可以执行时返回 null。
 * applyCommand 对这些命令什么都不做，界面用这里的原因给出提示。
 */
export function commandError(state: EditorState, command: Command): string | null {
  if (isIgnored(state, command)) return null;
  switch (command.type) {
    case "deleteSubtree":
      return state.selectedId === state.note.root.id ? "根结点不能删除" : null;
    case "cut":
      return state.selectedId === state.note.root.id ? "根结点不能剪切" : null;
    case "paste": {
      const cut = state.cutId === null ? undefined : findNode(state.note.root, (n) => n.id === state.cutId);
      return cut && findNode(cut, (n) => n.id === state.selectedId)
        ? "不能粘贴到被剪切的结点自己或它的子树里"
        : null;
    }
    case "setTime":
      return isValidNodeTime(command.time) ? null : "时间应为有效的 YYYY-MM-DD HH:MM";
    case "rename":
      return command.title.trim() === "" ? "标题不能为空" : null;
    default:
      return null;
  }
}

export function applyCommand(state: EditorState, command: Command): EditorState {
  if (isIgnored(state, command) || commandError(state, command) !== null) return state;
  const next = execute(state, command);
  // 撤销本身不进撤销历史。
  return forgetMissingCut(command.type === "undo" ? next : record(state, next));
}

function isIgnored(state: EditorState, command: Command): boolean {
  return state.editingId !== null && SELECTION_COMMANDS.has(command.type);
}

function execute(state: EditorState, command: Command): EditorState {
  switch (command.type) {
    case "addChild":
      return addNode(state, state.selectedId, command.time);
    case "addSibling": {
      const parent = parentMap(state.note.root).get(state.selectedId);
      return parent ? addNode(state, parent.id, command.time) : state;
    }
    case "startEdit": {
      const id = command.nodeId ?? state.selectedId;
      if (!findNode(state.note.root, (n) => n.id === id)) return state;
      return { ...state, ...selectNode(state.note.root, state, id), editingId: id };
    }
    case "setText":
      return state.editingId === null ? state : setText(state, state.editingId, command.text);
    case "commitEdit":
      return state.editingId === null ? state : commitEdit(state, state.editingId);
    case "deleteSubtree":
      return deleteSubtree(state, state.selectedId);
    case "cut":
      return { ...state, cutId: state.cutId === state.selectedId ? null : state.selectedId };
    case "paste":
      return state.cutId === null ? state : paste(state, state.cutId, state.selectedId);
    case "toggleKind":
      return updateSelected(state, (node) => ({ ...node, kind: node.kind === "event" ? "idea" : "event" }));
    case "setTime":
      return updateSelected(state, (node) => (node.time === command.time ? node : { ...node, time: command.time }));
    case "rename": {
      const title = command.title.trim();
      return title === state.note.title ? state : { ...state, note: { ...state.note, title } };
    }
    case "undo":
      return undo(state);
  }
}

function snapshot(state: EditorState): Snapshot {
  return { note: state.note, selectedId: state.selectedId };
}

/** 把 `before` → `after` 记进撤销历史。编辑中只记下开始前的快照，确认时再决定是否算一步。 */
function record(before: EditorState, after: EditorState): EditorState {
  if (after === before) return after;
  const start = before.editingId === null ? snapshot(before) : before.editStart;
  if (after.editingId !== null) return { ...after, editStart: start };
  const changed = start !== null && !sameNote(start.note, after.note);
  return { ...after, editStart: null, undoStack: changed ? [...after.undoStack, start] : after.undoStack };
}

function undo(state: EditorState): EditorState {
  const last = state.undoStack.at(-1);
  if (!last) return state;
  return {
    ...state,
    ...selectNode(last.note.root, state, last.selectedId),
    note: last.note,
    undoStack: state.undoStack.slice(0, -1),
  };
}

function sameNote(a: Note, b: Note): boolean {
  return a === b || (a.title === b.title && sameTree(a.root, b.root));
}

function sameTree(a: TreeNode, b: TreeNode): boolean {
  return (
    a === b ||
    (a.id === b.id &&
      a.kind === b.kind &&
      a.time === b.time &&
      a.text === b.text &&
      a.children.length === b.children.length &&
      a.children.every((child, i) => sameTree(child, b.children[i])))
  );
}

/** 被剪切的结点已经不在树里了（被删除），就取消剪切。 */
function forgetMissingCut(state: EditorState): EditorState {
  if (state.cutId === null || findNode(state.note.root, (n) => n.id === state.cutId)) return state;
  return { ...state, cutId: null };
}

function addNode(state: EditorState, parentId: string, time: string): EditorState {
  const child = newEventNode(time);
  const root = updateNode(state.note.root, parentId, (p) => ({ ...p, children: [...p.children, child] }));
  return {
    ...state,
    ...selectNode(root, state, child.id),
    note: { ...state.note, root },
    editingId: child.id,
  };
}

function setText(state: EditorState, id: string, text: string): EditorState {
  const root = updateNode(state.note.root, id, (node) => (node.text === text ? node : { ...node, text }));
  return root === state.note.root ? state : { ...state, note: { ...state.note, root } };
}

function updateSelected(state: EditorState, update: (node: TreeNode) => TreeNode): EditorState {
  const root = updateNode(state.note.root, state.selectedId, update);
  return root === state.note.root ? state : { ...state, note: { ...state.note, root } };
}

function deleteSubtree(state: EditorState, id: string): EditorState {
  const parent = parentMap(state.note.root).get(id);
  if (!parent) return state;
  return { ...state, note: { ...state.note, root: removeNode(state.note.root, parent.id, id) }, selectedId: parent.id };
}

function paste(state: EditorState, cutId: string, targetId: string): EditorState {
  const node = findNode(state.note.root, (n) => n.id === cutId);
  const parent = parentMap(state.note.root).get(cutId);
  // 粘贴回原来的父结点：笔记不变，只取消剪切。
  if (!node || !parent || parent.id === targetId) return { ...state, cutId: null };
  const root = updateNode(removeNode(state.note.root, parent.id, cutId), targetId, (t) => ({
    ...t,
    children: [...t.children, node],
  }));
  return { ...state, ...selectNode(root, state, cutId), note: { ...state.note, root }, cutId: null };
}

/** 确认时去掉首尾空白；空的叶子结点被删除并选中父结点。根结点和有子结点的结点留下。 */
function commitEdit(state: EditorState, id: string): EditorState {
  const node = findNode(state.note.root, (n) => n.id === id);
  if (!node) return { ...state, editingId: null };
  const text = node.text.trim();
  const parent = parentMap(state.note.root).get(id);
  if (text === "" && parent && node.children.length === 0) {
    const root = removeNode(state.note.root, parent.id, id);
    return { ...state, note: { ...state.note, root }, selectedId: parent.id, editingId: null };
  }
  return { ...setText(state, id, text), editingId: null };
}

/** 返回新树：从 `parentId` 的子结点里去掉 `id`（连同它的子树）。 */
function removeNode(root: TreeNode, parentId: string, id: string): TreeNode {
  return updateNode(root, parentId, (p) => ({ ...p, children: p.children.filter((c) => c.id !== id) }));
}

/** 返回新树：id 为 `id` 的结点被替换成 `update` 的结果，路径上的祖先被复制。 */
function updateNode(root: TreeNode, id: string, update: (node: TreeNode) => TreeNode): TreeNode {
  if (root.id === id) return update(root);
  let changed = false;
  const children = root.children.map((child) => {
    const next = updateNode(child, id, update);
    if (next !== child) changed = true;
    return next;
  });
  return changed ? { ...root, children } : root;
}
