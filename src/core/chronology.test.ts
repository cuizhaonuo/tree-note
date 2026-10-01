import { describe, expect, it } from "vitest";
import { dayMarkers, timeViolations } from "./chronology";
import { parseNote } from "./format";
import { findNode, type TreeNode } from "./note";

function parseTree(md: string): TreeNode {
  const result = parseNote(md);
  if (!result.ok) throw new Error(result.error.message);
  return result.note.root;
}

/** 把一组结点 id 换成结点文本，排好序便于比较。 */
function texts(root: TreeNode, ids: ReadonlySet<string>): string[] {
  return [...ids].map((id) => findNode(root, (n) => n.id === id)!.text).sort();
}

describe("dayMarkers", () => {
  it("marks the earliest node of each day, wherever it is in the tree", () => {
    const root = parseTree(`# 跨天

- [事件 2026-09-30 09:00] 根
  - [事件 2026-09-30 10:00] A
    - [事件 2026-10-01 11:00] A1
  - [事件 2026-09-30 15:00] B
    - [事件 2026-10-01 09:05] B1
      - [事件 2026-10-01 10:00] B11
`);
    expect(texts(root, dayMarkers(root))).toEqual(["B1", "根"]);
  });

  it("marks only one node when several share the earliest time of a day, preferring the one that comes first in the tree", () => {
    const root = parseTree(`# 同时

- [事件 2026-09-30 09:00] 根
  - [事件 2026-10-01 08:00] 乙
  - [事件 2026-10-01 08:00] 甲
    - [事件 2026-09-30 08:00] 甲1
`);
    // 9 月 30 日：甲1（08:00）比根（09:00）早；10 月 1 日：乙、甲同时，乙在文件里靠前。
    expect(texts(root, dayMarkers(root))).toEqual(["乙", "甲1"]);
  });

  it("marks the root of a single-day tree", () => {
    const root = parseTree(`# 一天

- [事件 2026-09-30 09:00] 根
  - [事件 2026-09-30 10:00] A
`);
    expect(texts(root, dayMarkers(root))).toEqual(["根"]);
  });
});

describe("timeViolations", () => {
  it("flags each child that is earlier than its own parent", () => {
    const root = parseTree(`# 补记

- [事件 2026-09-30 09:00] 根
  - [事件 2026-09-30 08:00] 早于根
    - [事件 2026-09-30 08:30] 晚于父但早于根
  - [事件 2026-09-30 10:00] A
    - [事件 2026-09-29 23:00] 前一天
`);
    expect(texts(root, timeViolations(root))).toEqual(["前一天", "早于根"]);
  });

  it("does not flag a child with the same time as its parent", () => {
    const root = parseTree(`# 同时

- [事件 2026-09-30 09:00] 根
  - [事件 2026-09-30 09:00] A
`);
    expect(timeViolations(root).size).toBe(0);
  });
});
