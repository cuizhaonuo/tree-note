// 命令：applyCommand(状态, 命令) → 新状态。
//
// 状态是不可变的：命令返回新的笔记对象，只复制从根到被修改结点的那条路径。

import { initialNavState, parentMap, selectNode, type NavState } from "./navigation";
import { findNode, newEventNode, type Note, type TreeNode } from "./note";

export interface EditorState extends NavState {
  note: Note;
  /** 正在编辑的结点 id；null 表示选择状态。 */
  editingId: string | null;
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
  | { type: "commitEdit" };

/** 这些命令只在选择状态下有效，编辑状态下忽略。 */
const SELECTION_COMMANDS: ReadonlySet<Command["type"]> = new Set(["addChild", "addSibling", "startEdit"]);

export function initialEditorState(note: Note): EditorState {
  return { note, editingId: null, ...initialNavState(note.root) };
}

/** 新建笔记：根结点是一个空的事件，时间为 `time`，并且直接进入编辑状态。 */
export function newNoteState(title: string, time: string): EditorState {
  const root = newEventNode(time);
  return { ...initialEditorState({ title, root }), editingId: root.id };
}

export function applyCommand(state: EditorState, command: Command): EditorState {
  if (state.editingId !== null && SELECTION_COMMANDS.has(command.type)) return state;
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
  }
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

/** 确认时去掉首尾空白；空的叶子结点被删除并选中父结点。根结点和有子结点的结点留下。 */
function commitEdit(state: EditorState, id: string): EditorState {
  const node = findNode(state.note.root, (n) => n.id === id);
  if (!node) return { ...state, editingId: null };
  const text = node.text.trim();
  const parent = parentMap(state.note.root).get(id);
  if (text === "" && parent && node.children.length === 0) {
    const root = updateNode(state.note.root, parent.id, (p) => ({
      ...p,
      children: p.children.filter((c) => c.id !== id),
    }));
    return { ...state, note: { ...state.note, root }, selectedId: parent.id, editingId: null };
  }
  return { ...setText(state, id, text), editingId: null };
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
