import { describe, expect, it } from "vitest";
import { parseNote, serializeNote } from "./format";
import type { Note } from "./note";

// 规格中给出的约定格式示例。
const SPEC_EXAMPLE = `# 训练 wheat 检测模型

- [事件 2026-09-30 14:32] 跑 baseline
  - [想法 2026-09-30 14:40] 试试更大的 backbone
  - [事件 2026-09-30 15:10] 改 \`lr=1e-4\` 重跑
    结果 mAP **42.1**，比之前高
    - [事件 2026-10-01 09:05] 看可视化
`;

function parseOk(md: string): Note {
  const result = parseNote(md);
  if (!result.ok) throw new Error(`expected ok, got line ${result.error.line}: ${result.error.message}`);
  return result.note;
}

function parseError(md: string) {
  const result = parseNote(md);
  if (result.ok) throw new Error("expected a parse error");
  return result.error;
}

function roundTrip(md: string): string {
  return serializeNote(parseOk(md));
}

describe("parseNote", () => {
  it("reads the title and a single root node", () => {
    const note = parseOk("# 训练 wheat 检测模型\n\n- [事件 2026-09-30 14:32] 跑 baseline\n");
    expect(note.title).toBe("训练 wheat 检测模型");
    expect(note.root).toMatchObject({
      kind: "event",
      time: "2026-09-30 14:32",
      text: "跑 baseline",
      children: [],
    });
  });

  it("builds the nested tree from indented list items", () => {
    const { root } = parseOk(SPEC_EXAMPLE);
    expect(root.children.map((c) => [c.kind, c.time, c.text])).toEqual([
      ["idea", "2026-09-30 14:40", "试试更大的 backbone"],
      ["event", "2026-09-30 15:10", "改 `lr=1e-4` 重跑\n结果 mAP **42.1**，比之前高"],
    ]);
    expect(root.children[1].children).toMatchObject([
      { kind: "event", time: "2026-10-01 09:05", text: "看可视化", children: [] },
    ]);
  });

  it("gives every node a distinct id", () => {
    const { root } = parseOk(SPEC_EXAMPLE);
    const ids = [root.id, ...root.children.map((c) => c.id), root.children[1].children[0].id];
    expect(new Set(ids).size).toBe(4);
  });

  it("keeps inline Markdown in the text verbatim", () => {
    const { root } = parseOk(
      "# t\n\n- [事件 2026-09-30 14:32] **粗体** [链接](https://example.com) `a_b*c*`\n",
    );
    expect(root.text).toBe("**粗体** [链接](https://example.com) `a_b*c*`");
  });

  it("accepts a node with empty text", () => {
    const { root } = parseOk("# t\n\n- [想法 2026-09-30 14:32]\n");
    expect(root).toMatchObject({ kind: "idea", text: "" });
  });

  it("keeps blank lines inside multi-line text", () => {
    const { root } = parseOk("# t\n\n- [事件 2026-09-30 14:32] 第一行\n\n  第三行\n");
    expect(root.text).toBe("第一行\n\n第三行");
  });

  it("keeps extra indentation of continuation lines as part of the text", () => {
    const { root } = parseOk("# t\n\n- [事件 2026-09-30 14:32] 命令：\n    python train.py\n");
    expect(root.text).toBe("命令：\n  python train.py");
  });

  it("tolerates CRLF line endings and a missing final newline", () => {
    const { root } = parseOk("# t\r\n\r\n- [事件 2026-09-30 14:32] a\r\n  - [想法 2026-09-30 14:33] b");
    expect(root.children[0].text).toBe("b");
  });
});

describe("serializeNote / round-trip", () => {
  it("writes the spec example back unchanged", () => {
    expect(roundTrip(SPEC_EXAMPLE)).toBe(SPEC_EXAMPLE);
  });

  it("round-trips multi-line text, blank lines inside text and empty nodes", () => {
    const md = `# 多行

- [事件 2026-09-30 14:32] 第一行
  第二行

  第四行
  - [想法 2026-09-30 14:40]
    - [事件 2026-09-30 14:50] 深层
      续行
  - [事件 2026-09-30 15:00] 兄弟
`;
    expect(roundTrip(md)).toBe(md);
  });

  it("writes a note built in memory in the agreed format", () => {
    const note: Note = {
      title: "手写",
      root: {
        id: "a",
        kind: "event",
        time: "2026-09-30 09:00",
        text: "开始\n**第二行**",
        children: [{ id: "b", kind: "idea", time: "2026-09-30 09:10", text: "想法", children: [] }],
      },
    };
    expect(serializeNote(note)).toBe(
      "# 手写\n\n- [事件 2026-09-30 09:00] 开始\n  **第二行**\n  - [想法 2026-09-30 09:10] 想法\n",
    );
  });

  it("text lines that look like list items survive a round-trip as text", () => {
    const note: Note = {
      title: "t",
      root: {
        id: "a",
        kind: "event",
        time: "2026-09-30 09:00",
        text: "清单\n- [ ] 待办\n\\- [x] 已转义",
        children: [],
      },
    };
    const reparsed = parseOk(serializeNote(note));
    expect(reparsed.root.text).toBe(note.root.text);
    expect(reparsed.root.children).toEqual([]);
  });
});

describe("parseNote errors", () => {
  it("reports a missing title", () => {
    expect(parseError("- [事件 2026-09-30 14:32] a\n")).toMatchObject({ line: 1 });
  });

  it("reports a file without a root node", () => {
    expect(parseError("# 只有标题\n\n").message).toMatch(/没有根结点/);
  });

  it("reports more than one top-level list item", () => {
    const error = parseError("# t\n\n- [事件 2026-09-30 14:32] a\n- [事件 2026-09-30 14:33] b\n");
    expect(error).toMatchObject({ line: 4 });
    expect(error.message).toMatch(/只能有一个顶层列表项/);
  });

  it.each([
    ["missing time", "- [事件] a"],
    ["unknown kind", "- [任务 2026-09-30 14:32] a"],
    ["impossible date", "- [事件 2026-02-30 14:32] a"],
    ["impossible hour", "- [事件 2026-09-30 25:00] a"],
  ])("reports an unparsable prefix (%s)", (_name, item) => {
    const error = parseError(`# t\n\n${item}\n`);
    expect(error.line).toBe(3);
  });

  it("reports an unparsable prefix on a nested item", () => {
    const error = parseError("# t\n\n- [事件 2026-09-30 14:32] a\n  - [事件 昨天] b\n");
    expect(error.line).toBe(4);
  });

  it("reports a stray line that is not part of the list", () => {
    expect(parseError("# t\n\n- [事件 2026-09-30 14:32] a\n随便一行\n")).toMatchObject({ line: 4 });
  });

  it("reports text between the title and the root node", () => {
    expect(parseError("# t\n\n前言\n- [事件 2026-09-30 14:32] a\n")).toMatchObject({ line: 3 });
  });
});
