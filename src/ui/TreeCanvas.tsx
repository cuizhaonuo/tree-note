// 画布：标题在顶部，下方自上而下渲染整棵树。连线用 SVG，结点用 HTML。

import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { layoutTree, type LayoutOptions, type NodeBox } from "../core/layout";
import type { Note } from "../core/note";
import { InlineMarkdown } from "./InlineMarkdown";

const LAYOUT: LayoutOptions = {
  nodeWidth: 220,
  horizontalGap: 28,
  verticalGap: 48,
  defaultHeight: 56,
};
const PADDING = 40;

export function TreeCanvas({ note }: { note: Note }) {
  const [heights, setHeights] = useState<ReadonlyMap<string, number>>(new Map());
  const nodeEls = useRef(new Map<string, HTMLDivElement>());

  const layout = useMemo(() => layoutTree(note.root, heights, LAYOUT), [note, heights]);

  // 结点高度随文本行数变化：渲染后测量，高度有变化再重新布局。
  useLayoutEffect(() => {
    const measured = new Map<string, number>();
    for (const [id, el] of nodeEls.current) measured.set(id, el.offsetHeight);
    const changed =
      measured.size !== heights.size ||
      [...measured].some(([id, h]) => heights.get(id) !== h);
    if (changed) setHeights(measured);
  }, [layout, heights]);

  const { minX, maxX, maxY } = layout.bounds;
  const offsetX = PADDING - minX;
  const offsetY = PADDING;
  const width = maxX - minX + PADDING * 2;
  const height = maxY + PADDING * 2;

  return (
    <div className="canvas">
      <h1 className="note-title">{note.title}</h1>
      <div className="tree" style={{ width, height }}>
        <svg className="links" width={width} height={height}>
          {layout.links.map(({ parent, child }) => (
            <path
              key={child.node.id}
              d={linkPath(parent, child, offsetX, offsetY)}
            />
          ))}
        </svg>
        {layout.boxes.map((box) => (
          <div
            key={box.node.id}
            ref={(el) => {
              if (el) nodeEls.current.set(box.node.id, el);
              else nodeEls.current.delete(box.node.id);
            }}
            className={`node node-${box.node.kind}`}
            style={{ left: box.x + offsetX, top: box.y + offsetY, width: box.width }}
          >
            <div className="node-meta">
              {box.node.kind === "idea" && <span className="node-icon" aria-label="想法">💡</span>}
              <time dateTime={box.node.time.replace(" ", "T")} title={box.node.time}>
                {box.node.time.slice(11)}
              </time>
            </div>
            <div className="node-text">
              <InlineMarkdown text={box.node.text} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function linkPath(parent: NodeBox, child: NodeBox, dx: number, dy: number): string {
  const x1 = parent.x + parent.width / 2 + dx;
  const y1 = parent.y + parent.height + dy;
  const x2 = child.x + child.width / 2 + dx;
  const y2 = child.y + dy;
  const midY = (y1 + y2) / 2;
  return `M${x1},${y1} C${x1},${midY} ${x2},${midY} ${x2},${y2}`;
}
