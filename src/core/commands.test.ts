import { describe, expect, it } from "vitest";
import { applyCommand, commandError, initialEditorState, newNoteState, type Command, type EditorState } from "./commands";
import { parseNote, serializeNote } from "./format";
import { findNode } from "./note";

const NOW = "2026-10-01 12:00";

const TREE = `# 命令

- [事件 2026-09-30 09:00] 根
  - [事件 2026-09-30 10:00] A
    - [事件 2026-09-30 10:10] A1
  - [事件 2026-09-30 11:00] B
`;

function open(md: string): EditorState {
  const result = parseNote(md);
  if (!result.ok) throw new Error(result.error.message);
  return initialEditorState(result.note);
}

function run(state: EditorState, commands: Command[]): EditorState {
  return commands.reduce(applyCommand, state);
}

/** 先选中文本为 `text` 的结点。测试里用文本指代结点更易读。 */
function selecting(state: EditorState, text: string): EditorState {
  const node = findNode(state.note.root, (n) => n.text === text);
  if (!node) throw new Error(`no node with text ${text}`);
  return { ...state, selectedId: node.id };
}

function textOf(state: EditorState, id: string | null): string | null {
  if (id === null) return null;
  const node = findNode(state.note.root, (n) => n.id === id);
  if (!node) throw new Error(`no node with id ${id}`);
  return node.text;
}

describe("addChild (Enter)", () => {
  it("adds an empty event child with the given time and starts editing it", () => {
    const state = run(selecting(open(TREE), "B"), [{ type: "addChild", time: NOW }]);
    expect(serializeNote(state.note)).toBe(`# 命令

- [事件 2026-09-30 09:00] 根
  - [事件 2026-09-30 10:00] A
    - [事件 2026-09-30 10:10] A1
  - [事件 2026-09-30 11:00] B
    - [事件 2026-10-01 12:00]
`);
    expect(state.editingId).toBe(state.selectedId);
    expect(textOf(state, state.selectedId)).toBe("");
  });
});

describe("addSibling (Shift+Enter)", () => {
  it("adds an empty event under the same parent and starts editing it", () => {
    const state = run(selecting(open(TREE), "A1"), [{ type: "addSibling", time: NOW }]);
    expect(serializeNote(state.note)).toBe(`# 命令

- [事件 2026-09-30 09:00] 根
  - [事件 2026-09-30 10:00] A
    - [事件 2026-09-30 10:10] A1
    - [事件 2026-10-01 12:00]
  - [事件 2026-09-30 11:00] B
`);
    expect(state.editingId).toBe(state.selectedId);
    expect(textOf(state, state.selectedId)).toBe("");
  });

  it("does nothing on the root", () => {
    const before = open(TREE);
    expect(applyCommand(before, { type: "addSibling", time: NOW })).toBe(before);
  });
});

describe("editing text", () => {
  it("writes the typed text into the node and goes back to selection on commit", () => {
    const state = run(selecting(open(TREE), "B"), [
      { type: "addChild", time: NOW },
      { type: "setText", text: "改 `lr=1e-4` 重跑\n结果 mAP **42.1**" },
      { type: "commitEdit" },
    ]);
    expect(serializeNote(state.note)).toBe(`# 命令

- [事件 2026-09-30 09:00] 根
  - [事件 2026-09-30 10:00] A
    - [事件 2026-09-30 10:10] A1
  - [事件 2026-09-30 11:00] B
    - [事件 2026-10-01 12:00] 改 \`lr=1e-4\` 重跑
      结果 mAP **42.1**
`);
    expect(state.editingId).toBeNull();
    expect(textOf(state, state.selectedId)).toBe("改 `lr=1e-4` 重跑\n结果 mAP **42.1**");
  });

  it("lets Enter, Enter keep growing the tree downwards", () => {
    const state = run(open(TREE), [
      { type: "addChild", time: NOW },
      { type: "setText", text: "C" },
      { type: "commitEdit" },
      { type: "addChild", time: NOW },
      { type: "setText", text: "C1" },
      { type: "commitEdit" },
    ]);
    expect(serializeNote(state.note)).toBe(`# 命令

- [事件 2026-09-30 09:00] 根
  - [事件 2026-09-30 10:00] A
    - [事件 2026-09-30 10:10] A1
  - [事件 2026-09-30 11:00] B
  - [事件 2026-10-01 12:00] C
    - [事件 2026-10-01 12:00] C1
`);
  });

  it("trims surrounding whitespace on commit", () => {
    const state = run(selecting(open(TREE), "B"), [
      { type: "addChild", time: NOW },
      { type: "setText", text: "  C\n\n" },
      { type: "commitEdit" },
    ]);
    expect(textOf(state, state.selectedId)).toBe("C");
  });

  it("ignores text and commit outside editing", () => {
    const before = selecting(open(TREE), "B");
    expect(run(before, [{ type: "setText", text: "x" }, { type: "commitEdit" }])).toBe(before);
  });
});

describe("committing an empty node", () => {
  it("deletes a new node left empty and selects its parent", () => {
    const before = selecting(open(TREE), "A");
    const state = run(before, [{ type: "addChild", time: NOW }, { type: "commitEdit" }]);
    expect(serializeNote(state.note)).toBe(TREE);
    expect(textOf(state, state.selectedId)).toBe("A");
    expect(state.editingId).toBeNull();
  });

  it("treats whitespace-only text as empty", () => {
    const state = run(selecting(open(TREE), "A"), [
      { type: "addSibling", time: NOW },
      { type: "setText", text: " \n " },
      { type: "commitEdit" },
    ]);
    expect(serializeNote(state.note)).toBe(TREE);
    expect(textOf(state, state.selectedId)).toBe("根");
  });

  it("deletes an existing leaf whose text was cleared", () => {
    const state = run(selecting(open(TREE), "B"), [
      { type: "startEdit" },
      { type: "setText", text: "" },
      { type: "commitEdit" },
    ]);
    expect(serializeNote(state.note)).toBe(`# 命令

- [事件 2026-09-30 09:00] 根
  - [事件 2026-09-30 10:00] A
    - [事件 2026-09-30 10:10] A1
`);
    expect(textOf(state, state.selectedId)).toBe("根");
  });

  it("keeps an emptied node that has children, so a subtree is never lost without confirmation", () => {
    const state = run(selecting(open(TREE), "A"), [
      { type: "startEdit" },
      { type: "setText", text: "" },
      { type: "commitEdit" },
    ]);
    expect(serializeNote(state.note)).toBe(`# 命令

- [事件 2026-09-30 09:00] 根
  - [事件 2026-09-30 10:00]
    - [事件 2026-09-30 10:10] A1
  - [事件 2026-09-30 11:00] B
`);
    expect(textOf(state, state.selectedId)).toBe("");
    expect(state.editingId).toBeNull();
  });

  it("keeps an empty root", () => {
    const state = run(open(TREE), [{ type: "startEdit" }, { type: "setText", text: "" }, { type: "commitEdit" }]);
    expect(serializeNote(state.note)).toBe(`# 命令

- [事件 2026-09-30 09:00]
  - [事件 2026-09-30 10:00] A
    - [事件 2026-09-30 10:10] A1
  - [事件 2026-09-30 11:00] B
`);
    expect(state.selectedId).toBe(state.note.root.id);
    expect(state.editingId).toBeNull();
  });
});

describe("startEdit (F2 / double-click)", () => {
  it("edits the selected node", () => {
    const state = run(selecting(open(TREE), "B"), [{ type: "startEdit" }]);
    expect(textOf(state, state.editingId)).toBe("B");
  });

  it("selects and edits the given node", () => {
    const opened = open(TREE);
    const a1 = findNode(opened.note.root, (n) => n.text === "A1")!;
    const state = run(opened, [{ type: "startEdit", nodeId: a1.id }]);
    expect(state.selectedId).toBe(a1.id);
    expect(state.editingId).toBe(a1.id);
  });
});

describe("select (click)", () => {
  it("selects the given node without editing it", () => {
    const opened = open(TREE);
    const a1 = findNode(opened.note.root, (n) => n.text === "A1")!;
    const state = run(opened, [{ type: "select", nodeId: a1.id }]);
    expect(state.selectedId).toBe(a1.id);
    expect(state.editingId).toBeNull();
  });

  it("remembers the path so ↓ from the parent comes back to it", () => {
    const opened = open(TREE);
    const b = findNode(opened.note.root, (n) => n.text === "B")!;
    const state = run(opened, [{ type: "select", nodeId: b.id }]);
    expect(state.lastVisitedChild.get(opened.note.root.id)).toBe(b.id);
  });

  it("changes nothing when the node is already selected", () => {
    const before = selecting(open(TREE), "B");
    expect(run(before, [{ type: "select", nodeId: before.selectedId }])).toBe(before);
  });
});

describe("while editing", () => {
  it("ignores the selection-mode commands", () => {
    const editing = run(selecting(open(TREE), "B"), [{ type: "startEdit" }]);
    expect(
      run(editing, [
        { type: "addChild", time: NOW },
        { type: "addSibling", time: NOW },
        { type: "startEdit" },
        { type: "select", nodeId: editing.note.root.id },
      ]),
    ).toBe(editing);
  });
});

describe("newNoteState (Ctrl+N)", () => {
  it("creates a note with an empty event root that is being edited", () => {
    const state = newNoteState("训练 wheat 检测模型", NOW);
    expect(serializeNote(state.note)).toBe(`# 训练 wheat 检测模型

- [事件 2026-10-01 12:00]
`);
    expect(state.selectedId).toBe(state.note.root.id);
    expect(state.editingId).toBe(state.note.root.id);
  });

  it("keeps the root when its first edit is committed empty", () => {
    const state = run(newNoteState("空笔记", NOW), [{ type: "commitEdit" }]);
    expect(serializeNote(state.note)).toBe(`# 空笔记

- [事件 2026-10-01 12:00]
`);
    expect(state.editingId).toBeNull();
  });
});

describe("deleteSubtree (Delete)", () => {
  it("removes the selected node with its whole subtree and selects the parent", () => {
    const state = run(selecting(open(TREE), "A"), [{ type: "deleteSubtree" }]);
    expect(serializeNote(state.note)).toBe(`# 命令

- [事件 2026-09-30 09:00] 根
  - [事件 2026-09-30 11:00] B
`);
    expect(textOf(state, state.selectedId)).toBe("根");
  });

  it("refuses to delete the root and explains why", () => {
    const before = open(TREE);
    expect(commandError(before, { type: "deleteSubtree" })).toBe("根结点不能删除");
    expect(applyCommand(before, { type: "deleteSubtree" })).toBe(before);
  });
});

describe("cut (x) and paste (v)", () => {
  it("marks the selected node as cut without changing the note", () => {
    const before = selecting(open(TREE), "A");
    const state = run(before, [{ type: "cut" }]);
    expect(textOf(state, state.cutId)).toBe("A");
    expect(state.note).toBe(before.note);
  });

  it("moves the cut node with its subtree under the selected target, selects it and clears the mark", () => {
    const cut = run(selecting(open(TREE), "A"), [{ type: "cut" }]);
    const state = run(selecting(cut, "B"), [{ type: "paste" }]);
    expect(serializeNote(state.note)).toBe(`# 命令

- [事件 2026-09-30 09:00] 根
  - [事件 2026-09-30 11:00] B
    - [事件 2026-09-30 10:00] A
      - [事件 2026-09-30 10:10] A1
`);
    expect(textOf(state, state.selectedId)).toBe("A");
    expect(state.cutId).toBeNull();
  });

  it("can move a node up to an ancestor", () => {
    const cut = run(selecting(open(TREE), "A1"), [{ type: "cut" }]);
    const state = run(selecting(cut, "根"), [{ type: "paste" }]);
    expect(serializeNote(state.note)).toBe(`# 命令

- [事件 2026-09-30 09:00] 根
  - [事件 2026-09-30 10:00] A
  - [事件 2026-09-30 11:00] B
  - [事件 2026-09-30 10:10] A1
`);
  });

  it("pressing x again on the cut node cancels the cut", () => {
    const state = run(selecting(open(TREE), "A"), [{ type: "cut" }, { type: "cut" }]);
    expect(state.cutId).toBeNull();
  });

  it("refuses to cut the root", () => {
    const before = open(TREE);
    expect(commandError(before, { type: "cut" })).toBe("根结点不能剪切");
    expect(applyCommand(before, { type: "cut" })).toBe(before);
  });

  it("refuses to paste a node into itself or its own subtree", () => {
    const cut = run(selecting(open(TREE), "A"), [{ type: "cut" }]);
    for (const target of ["A", "A1"]) {
      const before = selecting(cut, target);
      expect(commandError(before, { type: "paste" })).toBe("不能粘贴到被剪切的结点自己或它的子树里");
      expect(applyCommand(before, { type: "paste" })).toBe(before);
    }
  });

  it("pasting under the node's current parent leaves the note unchanged", () => {
    const cut = run(selecting(open(TREE), "A"), [{ type: "cut" }]);
    const state = run(selecting(cut, "根"), [{ type: "paste" }]);
    expect(state.note).toBe(cut.note);
    expect(state.cutId).toBeNull();
  });

  it("does nothing when nothing is cut", () => {
    const before = selecting(open(TREE), "B");
    expect(commandError(before, { type: "paste" })).toBeNull();
    expect(applyCommand(before, { type: "paste" })).toBe(before);
  });

  it("forgets the cut when the cut node is deleted", () => {
    const state = run(selecting(open(TREE), "A1"), [{ type: "cut" }]);
    const deleted = run(selecting(state, "A"), [{ type: "deleteSubtree" }]);
    expect(deleted.cutId).toBeNull();
  });
});

describe("undo (Ctrl+Z)", () => {
  const UNDO: Command = { type: "undo" };

  it("restores a deleted subtree and selects the deleted node again", () => {
    const state = run(selecting(open(TREE), "A"), [{ type: "deleteSubtree" }, UNDO]);
    expect(serializeNote(state.note)).toBe(TREE);
    expect(textOf(state, state.selectedId)).toBe("A");
  });

  it("moves a pasted node back where it was", () => {
    const cut = run(selecting(open(TREE), "A"), [{ type: "cut" }]);
    const state = run(selecting(cut, "B"), [{ type: "paste" }, UNDO]);
    expect(serializeNote(state.note)).toBe(TREE);
    expect(textOf(state, state.selectedId)).toBe("B");
  });

  it("removes a new node together with the text typed into it in one step", () => {
    const state = run(selecting(open(TREE), "B"), [
      { type: "addChild", time: NOW },
      { type: "setText", text: "C" },
      { type: "setText", text: "C1" },
      { type: "commitEdit" },
      UNDO,
    ]);
    expect(serializeNote(state.note)).toBe(TREE);
    expect(textOf(state, state.selectedId)).toBe("B");
  });

  it("restores the text from before an edit in one step", () => {
    const state = run(selecting(open(TREE), "B"), [
      { type: "startEdit" },
      { type: "setText", text: "B'" },
      { type: "setText", text: "B''" },
      { type: "commitEdit" },
      UNDO,
    ]);
    expect(serializeNote(state.note)).toBe(TREE);
    expect(textOf(state, state.selectedId)).toBe("B");
  });

  it("brings back a leaf that was deleted by committing it empty", () => {
    const state = run(selecting(open(TREE), "B"), [
      { type: "startEdit" },
      { type: "setText", text: "" },
      { type: "commitEdit" },
      UNDO,
    ]);
    expect(serializeNote(state.note)).toBe(TREE);
    expect(textOf(state, state.selectedId)).toBe("B");
  });

  it("does not record steps that leave the note unchanged", () => {
    const deleted = run(selecting(open(TREE), "B"), [{ type: "deleteSubtree" }]);
    const state = run(selecting(deleted, "A"), [
      // 新建后什么都没写：结点被丢弃
      { type: "addChild", time: NOW },
      { type: "commitEdit" },
      // 改了又改回原样
      { type: "startEdit" },
      { type: "setText", text: "A'" },
      { type: "setText", text: "A" },
      { type: "commitEdit" },
      // 剪切标记不改变笔记
      { type: "cut" },
      { type: "cut" },
      UNDO,
    ]);
    expect(serializeNote(state.note)).toBe(TREE);
  });

  it("undoes several steps in reverse order", () => {
    const cut = run(selecting(open(TREE), "A1"), [{ type: "cut" }]);
    let state = run(selecting(cut, "B"), [
      { type: "paste" },
      { type: "addChild", time: NOW },
      { type: "setText", text: "C" },
      { type: "commitEdit" },
    ]);
    state = run(selecting(state, "A"), [{ type: "deleteSubtree" }]);
    expect(serializeNote(state.note)).toBe(`# 命令

- [事件 2026-09-30 09:00] 根
  - [事件 2026-09-30 11:00] B
    - [事件 2026-09-30 10:10] A1
      - [事件 2026-10-01 12:00] C
`);

    state = run(state, [UNDO]);
    expect(serializeNote(state.note)).toBe(`# 命令

- [事件 2026-09-30 09:00] 根
  - [事件 2026-09-30 10:00] A
  - [事件 2026-09-30 11:00] B
    - [事件 2026-09-30 10:10] A1
      - [事件 2026-10-01 12:00] C
`);
    state = run(state, [UNDO]);
    expect(serializeNote(state.note)).toBe(`# 命令

- [事件 2026-09-30 09:00] 根
  - [事件 2026-09-30 10:00] A
  - [事件 2026-09-30 11:00] B
    - [事件 2026-09-30 10:10] A1
`);
    state = run(state, [UNDO]);
    expect(serializeNote(state.note)).toBe(TREE);
    expect(run(state, [UNDO])).toBe(state);
  });

  it("does nothing when there is nothing to undo", () => {
    const before = open(TREE);
    expect(applyCommand(before, UNDO)).toBe(before);
  });

  it("is ignored while editing, so the text box keeps its own undo", () => {
    const editing = run(selecting(open(TREE), "B"), [
      { type: "deleteSubtree" },
      { type: "startEdit" },
      { type: "setText", text: "根'" },
    ]);
    expect(applyCommand(editing, UNDO)).toBe(editing);
  });

  it("keeps the cut mark when the cut node survives the undo", () => {
    const state = run(selecting(open(TREE), "B"), [{ type: "deleteSubtree" }]);
    const undone = run(selecting(state, "A"), [{ type: "cut" }, UNDO]);
    expect(textOf(undone, undone.cutId)).toBe("A");
  });

  it("drops the cut mark when the undo removes the cut node", () => {
    const state = run(selecting(open(TREE), "B"), [
      { type: "addChild", time: NOW },
      { type: "setText", text: "C" },
      { type: "commitEdit" },
      { type: "cut" },
      UNDO,
    ]);
    expect(state.cutId).toBeNull();
  });

  it("keeps the root of a new note that is undone back to empty", () => {
    const state = run(newNoteState("新笔记", NOW), [{ type: "setText", text: "开始" }, { type: "commitEdit" }, UNDO]);
    expect(serializeNote(state.note)).toBe(`# 新笔记

- [事件 2026-10-01 12:00]
`);
    expect(state.selectedId).toBe(state.note.root.id);
  });
});

describe("toggleKind (i)", () => {
  it("switches the selected node between event and idea", () => {
    const once = run(selecting(open(TREE), "A1"), [{ type: "toggleKind" }]);
    expect(serializeNote(once.note)).toContain("    - [想法 2026-09-30 10:10] A1\n");
    const twice = run(once, [{ type: "toggleKind" }]);
    expect(serializeNote(twice.note)).toBe(TREE);
  });

  it("can be undone", () => {
    const state = run(selecting(open(TREE), "A1"), [{ type: "toggleKind" }, { type: "undo" }]);
    expect(serializeNote(state.note)).toBe(TREE);
  });

  it("is ignored while editing, so `i` can be typed", () => {
    const editing = run(selecting(open(TREE), "B"), [{ type: "startEdit" }]);
    expect(applyCommand(editing, { type: "toggleKind" })).toBe(editing);
  });
});

describe("setTime (t)", () => {
  it("changes the date and time of the selected node", () => {
    const state = run(selecting(open(TREE), "B"), [{ type: "setTime", time: "2026-10-02 08:05" }]);
    expect(serializeNote(state.note)).toContain("  - [事件 2026-10-02 08:05] B\n");
  });

  it("can be undone", () => {
    const state = run(selecting(open(TREE), "B"), [{ type: "setTime", time: "2026-10-02 08:05" }, { type: "undo" }]);
    expect(serializeNote(state.note)).toBe(TREE);
  });

  it("allows a child to be earlier than its parent", () => {
    const state = run(selecting(open(TREE), "A1"), [{ type: "setTime", time: "2026-09-29 23:59" }]);
    expect(serializeNote(state.note)).toContain("    - [事件 2026-09-29 23:59] A1\n");
  });

  it("refuses a time that does not exist and explains why", () => {
    const before = selecting(open(TREE), "B");
    for (const time of ["2026-02-30 10:00", "2026-10-01 24:00", "2026-10-01 9:00", ""]) {
      expect(commandError(before, { type: "setTime", time })).toBe("时间应为有效的 YYYY-MM-DD HH:MM");
      expect(applyCommand(before, { type: "setTime", time })).toBe(before);
    }
  });

  it("does not record an undo step when the time is unchanged", () => {
    const state = run(selecting(open(TREE), "B"), [{ type: "setTime", time: "2026-09-30 11:00" }]);
    expect(state.undoStack).toHaveLength(0);
  });
});

describe("rename (Ctrl+R)", () => {
  it("changes only the title, not the root or the selection", () => {
    const before = selecting(open(TREE), "A");
    const state = applyCommand(before, { type: "rename", title: "新标题" });
    expect(serializeNote(state.note)).toBe(TREE.replace("# 命令", "# 新标题"));
    expect(state.selectedId).toBe(before.selectedId);
  });

  it("can be undone", () => {
    const state = run(open(TREE), [{ type: "rename", title: "新标题" }, { type: "undo" }]);
    expect(serializeNote(state.note)).toBe(TREE);
  });

  it("trims spaces around the title", () => {
    const state = applyCommand(open(TREE), { type: "rename", title: "  新标题 \n" });
    expect(state.note.title).toBe("新标题");
  });

  it("refuses an empty title and explains why", () => {
    const before = open(TREE);
    for (const title of ["", "   "]) {
      expect(commandError(before, { type: "rename", title })).toBe("标题不能为空");
      expect(applyCommand(before, { type: "rename", title })).toBe(before);
    }
  });

  it("does not record an undo step when the title is unchanged", () => {
    const state = applyCommand(open(TREE), { type: "rename", title: " 命令 " });
    expect(state.undoStack).toHaveLength(0);
  });
});
