import { describe, expect, it } from "vitest";
import { parseNote } from "./format";
import type { Note } from "./note";
import { nodeAtPath, searchNotes, type SearchHit } from "./search";

function parse(md: string): Note {
  const result = parseNote(md);
  if (!result.ok) throw new Error(result.error.message);
  return result.note;
}

const wheat = parse(`# 训练 wheat 检测模型

- [事件 2026-09-30 14:32] 跑 baseline
  - [想法 2026-09-30 14:40] 试试更大的 backbone
  - [事件 2026-09-30 15:10] 改 \`lr=1e-4\` 重跑
    结果 mAP **42.1**，比之前高
    - [事件 2026-10-01 09:05] 换 Backbone 再看可视化
`);

const diary = parse(`# 日记

- [事件 2026-09-29 08:00] 早上读论文
  - [想法 2026-09-29 09:00] 论文里的 backbone 也许能用
`);

const notes = [
  { file: "训练 wheat 检测模型.md", note: wheat },
  { file: "日记.md", note: diary },
];

/** 把高亮片段写成 `前[关键词]后` 的形式，便于比较。 */
function marked(hit: SearchHit): string {
  return hit.snippet.map((s) => (s.match ? `[${s.text}]` : s.text)).join("");
}

describe("searchNotes", () => {
  it("finds every node in every note whose text contains the keyword, ignoring case", () => {
    const hits = searchNotes(notes, "backbone");
    expect(hits.map((h) => [h.file, h.title, h.time, marked(h)])).toEqual([
      ["训练 wheat 检测模型.md", "训练 wheat 检测模型", "2026-09-30 14:40", "试试更大的 [backbone]"],
      ["训练 wheat 检测模型.md", "训练 wheat 检测模型", "2026-10-01 09:05", "换 [Backbone] 再看可视化"],
      ["日记.md", "日记", "2026-09-29 09:00", "论文里的 [backbone] 也许能用"],
    ]);
  });

  it("locates each hit's node again in a freshly parsed copy of the same file", () => {
    const source = `# 乱序

- [事件 2026-09-30 09:00] 根
  - [事件 2026-09-30 11:00] 晚一点的 A
    - [事件 2026-09-30 12:00] 目标 A1
  - [事件 2026-09-30 10:00] 早一点的 B
    - [事件 2026-09-30 10:30] 目标 B1
`;
    const hits = searchNotes([{ file: "乱序.md", note: parse(source) }], "目标");
    const reopened = parse(source).root;
    expect(hits.map((h) => nodeAtPath(reopened, h.path)?.text)).toEqual(["目标 B1", "目标 A1"]);
  });

  it("finds nothing at a path that no longer exists", () => {
    expect(nodeAtPath(wheat.root, [5])).toBeUndefined();
    expect(nodeAtPath(wheat.root, [0, 0])).toBeUndefined();
  });

  it("finds a note by its title, pointing at the root, before the note's matching nodes", () => {
    const hits = searchNotes(notes, "日记");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ file: "日记.md", inTitle: true, time: "2026-09-29 08:00", path: [] });
    expect(marked(hits[0])).toBe("[日记]");

    const wheatHits = searchNotes(notes, "WHEAT");
    expect(wheatHits.map((h) => h.inTitle)).toEqual([true]);
    expect(searchNotes(notes, "backbone").every((h) => !h.inTitle)).toBe(true);
  });

  it("finds nothing for a blank query", () => {
    expect(searchNotes(notes, "")).toEqual([]);
    expect(searchNotes(notes, "  ")).toEqual([]);
  });

  it("treats space-separated words as keywords that must all appear, highlighting every occurrence", () => {
    expect(searchNotes(notes, "论文 BACKBONE").map(marked)).toEqual(["[论文]里的 [backbone] 也许能用"]);

    const repeated = parse(`# 重复

- [事件 2026-09-30 09:00] 先跑 a，再跑 b，最后跑 ab
`);
    expect(searchNotes([{ file: "重复.md", note: repeated }], "跑 a").map(marked)).toEqual([
      "先[跑] [a]，再[跑] b，最后[跑] [a]b",
    ]);
  });

  describe("snippet", () => {
    function snippetOf(text: string, query: string): string {
      const note = parse(`# 片段\n\n- [事件 2026-09-30 09:00] ${text.replaceAll("\n", "\n  ")}\n`);
      return marked(searchNotes([{ file: "片段.md", note }], query)[0]);
    }

    it("shows the lines of a multi-line node joined by spaces", () => {
      expect(snippetOf("第一行\n第二行有关键词\n第三行", "关键")).toBe("第一行 第二行有[关键]词 第三行");
    });

    it("cuts a long text to a window around the first match, marking the cuts with an ellipsis", () => {
      const text = "x".repeat(50) + "关键" + "y".repeat(200) + "关键";
      expect(snippetOf(text, "关键")).toBe("…" + "x".repeat(20) + "[关键]" + "y".repeat(78) + "…");
    });

    it("does not cut a character outside the basic plane in half", () => {
      const text = "😀".repeat(30) + "a关键";
      expect(snippetOf(text, "关键")).toBe("…" + "😀".repeat(10) + "a[关键]");
    });
  });
});
