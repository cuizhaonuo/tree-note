// 渲染结点文本中的行内 Markdown：**加粗**、[链接](url)、`行内代码`。
// 只生成 React 元素，不使用 innerHTML。

import type { ReactNode } from "react";

const INLINE_RE = /`([^`\n]+)`|\*\*([^*\n]+?)\*\*|\[([^\]\n]+)\]\(([^)\s]+)\)/g;
const SAFE_URL_RE = /^(https?:|mailto:|\/|\.{0,2}\/|#)/i;

export function InlineMarkdown({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(INLINE_RE)) {
    const index = match.index;
    if (index > last) parts.push(text.slice(last, index));
    const [whole, code, bold, linkText, href] = match;
    if (code !== undefined) {
      parts.push(<code key={index}>{code}</code>);
    } else if (bold !== undefined) {
      parts.push(<strong key={index}>{bold}</strong>);
    } else if (SAFE_URL_RE.test(href)) {
      parts.push(
        <a key={index} href={href} target="_blank" rel="noopener noreferrer">
          {linkText}
        </a>,
      );
    } else {
      parts.push(whole);
    }
    last = index + whole.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}
