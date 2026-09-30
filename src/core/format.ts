// 格式：笔记 Markdown 文件与 Note 之间的解析与写回。
//
// 约定格式（见 .scratch/tree-note/spec.md）：
//
//   # 标题
//
//   - [事件 2026-09-30 14:32] 根结点文本
//     续行与列表项正文对齐
//     - [想法 2026-09-30 14:40] 子结点
//
// 每层缩进 2 个空格；深度 d 的列表项以 2d 个空格开头，它的续行以 2d+2 个空格开头。
// 文本中恰好以 `- [` 开头的行（前面可能有反斜杠）在写回时多加一个 `\`，
// 以免被误读成子结点；解析时再去掉一个。

import type { Note, NodeKind, TreeNode } from "./note";
import { newNodeId } from "./note";

export interface ParseError {
  /** 1-based line number in the source file. */
  line: number;
  message: string;
}

export type ParseResult =
  | { ok: true; note: Note }
  | { ok: false; error: ParseError };

const KIND_LABELS: Record<NodeKind, string> = { event: "事件", idea: "想法" };
const LABEL_KINDS: Record<string, NodeKind> = { 事件: "event", 想法: "idea" };

const TITLE_RE = /^# (.*)$/;
const ITEM_RE = /^- \[(\S+) (\d{4}-\d{2}-\d{2} \d{2}:\d{2})\](?: (.*))?$/;
const ITEM_START_RE = /^- \[/;
const ESCAPED_ITEM_START_RE = /^\\*- \[/;
const INDENT = "  ";

export function parseNote(source: string): ParseResult {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const fail = (index: number, message: string): ParseResult => ({
    ok: false,
    error: { line: index + 1, message },
  });

  let i = 0;
  while (i < lines.length && isBlank(lines[i])) i++;
  const titleMatch = i < lines.length ? TITLE_RE.exec(lines[i]) : null;
  if (!titleMatch) return fail(i, "文件应以一级标题（# 标题）开头");
  const title = titleMatch[1];
  i++;

  let root: TreeNode | null = null;
  // stack[d] 是当前路径上深度为 d 的结点。
  const stack: TreeNode[] = [];
  let pendingBlankLines = 0;

  for (; i < lines.length; i++) {
    const line = lines[i];
    if (isBlank(line)) {
      pendingBlankLines++;
      continue;
    }
    const indent = line.length - line.trimStart().length;
    const rest = line.slice(indent);
    const last = stack[stack.length - 1];
    const bodyIndent = stack.length * INDENT.length;

    const isItemPosition = indent % INDENT.length === 0 && indent <= bodyIndent;
    if (isItemPosition && ITEM_START_RE.test(rest)) {
      const depth = indent / INDENT.length;
      if (depth === 0 && root) return fail(i, "只能有一个顶层列表项（根结点）");
      const match = ITEM_RE.exec(rest);
      if (!match) return fail(i, "列表项前缀无法解析，应为 [事件 YYYY-MM-DD HH:MM] 或 [想法 YYYY-MM-DD HH:MM]");
      const kind = LABEL_KINDS[match[1]];
      if (!kind) return fail(i, `未知的结点类型“${match[1]}”，应为“事件”或“想法”`);
      if (!isValidTime(match[2])) return fail(i, `时间“${match[2]}”不是有效的日期和时间`);

      const node: TreeNode = {
        id: newNodeId(),
        kind,
        time: match[2],
        text: match[3] ?? "",
        children: [],
      };
      stack.length = depth;
      if (depth === 0) root = node;
      else stack[depth - 1].children.push(node);
      stack.push(node);
      pendingBlankLines = 0;
      continue;
    }

    if (last && indent >= bodyIndent) {
      const textLine = unescapeTextLine(line.slice(bodyIndent));
      last.text += "\n".repeat(pendingBlankLines + 1) + textLine;
      pendingBlankLines = 0;
      continue;
    }

    return fail(i, root ? "无法识别的行：缩进不符合列表结构" : "标题下面应该是根结点列表项");
  }

  if (!root) return fail(lines.length - 1, "没有根结点：标题下面需要一个顶层列表项");
  return { ok: true, note: { title, root } };
}

export function serializeNote(note: Note): string {
  const out: string[] = [`# ${note.title}`, ""];
  writeNode(note.root, 0, out);
  return out.join("\n") + "\n";
}

function writeNode(node: TreeNode, depth: number, out: string[]): void {
  const indent = INDENT.repeat(depth);
  const [first, ...rest] = node.text.split("\n");
  const prefix = `${indent}- [${KIND_LABELS[node.kind]} ${node.time}]`;
  out.push(first ? `${prefix} ${first}` : prefix);
  for (const textLine of rest) {
    out.push(isBlank(textLine) ? "" : `${indent}${INDENT}${escapeTextLine(textLine)}`);
  }
  for (const child of node.children) writeNode(child, depth + 1, out);
}

function escapeTextLine(line: string): string {
  return ESCAPED_ITEM_START_RE.test(line) ? `\\${line}` : line;
}

function unescapeTextLine(line: string): string {
  return ESCAPED_ITEM_START_RE.test(line) ? line.slice(1) : line;
}

function isBlank(line: string): boolean {
  return line.trim() === "";
}

function isValidTime(time: string): boolean {
  const [date, clock] = time.split(" ");
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = clock.split(":").map(Number);
  const probe = new Date(y, m - 1, d);
  return (
    probe.getFullYear() === y &&
    probe.getMonth() === m - 1 &&
    probe.getDate() === d &&
    hh < 24 &&
    mm < 60
  );
}
