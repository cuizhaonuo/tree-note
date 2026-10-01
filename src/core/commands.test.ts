import { describe, expect, it } from "vitest";
import { applyCommand, initialEditorState, newNoteState, type Command, type EditorState } from "./commands";
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

describe("while editing", () => {
  it("ignores the selection-mode commands", () => {
    const editing = run(selecting(open(TREE), "B"), [{ type: "startEdit" }]);
    expect(
      run(editing, [{ type: "addChild", time: NOW }, { type: "addSibling", time: NOW }, { type: "startEdit" }]),
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
