// 全文搜索：在笔记库所有笔记的标题和所有结点文字里找关键词。
//
// 用空格隔开的多个关键词必须全部出现（不区分大小写），每一处出现都高亮。
// 片段把多行文本连成一行，太长时只保留第一处匹配附近的一段。
// 结果按笔记的先后排列；同一篇笔记里标题在前，结点按树上的顺序（先父后子，兄弟按时间）。
//
// 结点 id 每次解析都重新生成，所以结果用路径（从根往下每一层在文件里的下标）指明结点，
// 重新打开文件后用 locateHit 找回它。搜索之后笔记可能又改过，路径上已经换成别的结点，
// 所以还要核对时间和文本，对不上就当作找不到。

import { sortedChildren } from "./chronology";
import type { Note, TreeNode } from "./note";

/** 片段里第一处匹配前面最多保留的字符数。 */
const SNIPPET_BEFORE = 20;
/** 片段最多保留的字符数（不算省略号）。 */
const SNIPPET_LENGTH = 100;

export interface SearchableNote {
  /** 笔记文件名，打开结果时用来找到文件。 */
  file: string;
  note: Note;
}

/** 片段里的一段文字；`match` 表示它是要高亮的关键词。 */
export interface SnippetPart {
  text: string;
  match: boolean;
}

/** 从根到某个结点，每一层在父结点 children 里的下标（文件里的顺序）；根结点是空数组。 */
export type NodePath = readonly number[];

/** 搜索结果指向的结点：位置，加上搜索时它的时间和文本，用来确认它还是那个结点。 */
export interface NodeLocator {
  path: NodePath;
  time: string;
  text: string;
}

export interface SearchHit extends NodeLocator {
  file: string;
  title: string;
  /** 匹配的是标题而不是结点：这时结果指向根结点，片段是标题。 */
  inTitle: boolean;
  snippet: SnippetPart[];
}

export function searchNotes(notes: readonly SearchableNote[], query: string): SearchHit[] {
  const hits: SearchHit[] = [];
  const matcher = keywordMatcher(query);
  if (!matcher) return hits;
  for (const { file, note } of notes) {
    const titleSnippet = matcher(note.title);
    if (titleSnippet) {
      const { time, text } = note.root;
      hits.push({ file, title: note.title, inTitle: true, path: [], time, text, snippet: titleSnippet });
    }
    const visit = (node: TreeNode, path: NodePath) => {
      const snippet = matcher(node.text);
      if (snippet) hits.push({ file, title: note.title, inTitle: false, path, time: node.time, text: node.text, snippet });
      const indices = new Map(node.children.map((child, index) => [child, index]));
      for (const child of sortedChildren(node)) visit(child, [...path, indices.get(child)!]);
    };
    visit(note.root, []);
  }
  return hits;
}

type Matcher = (text: string) => SnippetPart[] | null;

/** 查询里没有关键词时返回 null；否则返回的函数在文本包含全部关键词时给出高亮后的文本。 */
function keywordMatcher(query: string): Matcher | null {
  const keywords = query.split(/\s+/).filter(Boolean);
  if (keywords.length === 0) return null;
  const patterns = keywords.map((k) => new RegExp(escapeRegExp(k), "iu"));
  // 长的关键词优先，这样一个关键词包含另一个时高亮整段。
  const anyKeyword = new RegExp(
    [...keywords].sort((a, b) => b.length - a.length).map(escapeRegExp).join("|"),
    "giu",
  );
  return (text) => {
    if (!patterns.every((p) => p.test(text))) return null;
    const line = text.replaceAll("\n", " ");
    const matches = [...line.matchAll(anyKeyword)].map((m) => ({ start: m.index, end: m.index + m[0].length }));
    const start = codePointBoundary(line, Math.max(0, matches[0].start - SNIPPET_BEFORE));
    const end = codePointBoundary(line, Math.min(line.length, start + SNIPPET_LENGTH));

    const parts: SnippetPart[] = [];
    const push = (from: number, to: number, match: boolean) => {
      from = Math.max(from, start);
      to = Math.min(to, end);
      if (from >= to) return;
      const last = parts[parts.length - 1];
      if (last?.match === match) last.text += line.slice(from, to);
      else parts.push({ text: line.slice(from, to), match });
    };
    let done = start;
    for (const m of matches) {
      push(done, m.start, false);
      push(m.start, m.end, true);
      done = m.end;
    }
    push(done, end, false);
    if (start > 0) parts.unshift({ text: "…", match: false });
    if (end < line.length) parts.push({ text: "…", match: false });
    return parts;
  };
}

/** 如果 `index` 落在一对代理项中间，往前挪到这个字符的开头。 */
function codePointBoundary(text: string, index: number): number {
  const code = text.charCodeAt(index);
  return index > 0 && code >= 0xdc00 && code <= 0xdfff ? index - 1 : index;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 找回搜索结果指向的结点；结点已经不在、或者那个位置上换成了别的结点时返回 undefined。 */
export function locateHit(root: TreeNode, locator: NodeLocator): TreeNode | undefined {
  let node: TreeNode | undefined = root;
  for (const index of locator.path) node = node?.children[index];
  return node && node.time === locator.time && node.text === locator.text ? node : undefined;
}
