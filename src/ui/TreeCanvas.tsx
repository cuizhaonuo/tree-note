// 画布：标题在顶部，下方自上而下渲染整棵树。连线用 SVG，结点用 HTML。
//
// 选择状态：方向键移动选中状态，Enter / Shift+Enter 新建子结点 / 兄弟结点，F2 或双击编辑。
// 编辑状态：Enter 或 Esc 确认，Shift+Enter 换行。选中的结点会滚动到视野中央。

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { applyCommand, type Command, type EditorState } from "../core/commands";
import { layoutTree, type LayoutOptions, type NodeBox } from "../core/layout";
import { navigate, type Direction } from "../core/navigation";
import { formatNodeTime, type Note } from "../core/note";
import { InlineMarkdown } from "./InlineMarkdown";

const LAYOUT: LayoutOptions = {
  nodeWidth: 220,
  horizontalGap: 28,
  verticalGap: 48,
  defaultHeight: 56,
};
const PADDING = 40;

const ARROW_KEYS: Record<string, Direction> = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
};
// 折叠功能还没有实现，暂时没有结点被折叠。
const NO_COLLAPSED: ReadonlySet<string> = new Set();

interface TreeCanvasProps {
  initialState: EditorState;
  /** 笔记内容变化后调用（不包括打开时的初始内容）。 */
  onNoteChange: (note: Note) => void;
}

export function TreeCanvas({ initialState, onNoteChange }: TreeCanvasProps) {
  const [heights, setHeights] = useState<ReadonlyMap<string, number>>(new Map());
  const nodeEls = useRef(new Map<string, HTMLDivElement>());

  const [state, setState] = useState(initialState);
  const { note } = state;
  const dispatch = useCallback((command: Command) => setState((s) => applyCommand(s, command)), []);

  const layout = useMemo(() => layoutTree(note.root, heights, LAYOUT), [note, heights]);

  useEffect(() => {
    if (note !== initialState.note) onNoteChange(note);
  }, [note, initialState.note, onNoteChange]);

  useEffect(() => {
    if (state.editingId !== null) return;
    function onKeyDown(e: KeyboardEvent) {
      // 编辑框里确认用的 Enter 会继续冒泡到这里，它已经被处理过了（defaultPrevented），不能再新建结点。
      if (e.defaultPrevented || isTextInput(e.target) || e.altKey || e.ctrlKey || e.metaKey) return;
      const direction = ARROW_KEYS[e.key];
      if (direction && !e.shiftKey) {
        e.preventDefault();
        setState((s) => ({ ...s, ...navigate(s.note.root, s, direction, { collapsed: NO_COLLAPSED, layout }) }));
        return;
      }
      // 按住不放时不连续新建结点：第一次按下之后焦点已经在新结点的编辑框里了。
      if (e.repeat) return;
      if (e.key === "Enter") {
        e.preventDefault();
        const time = formatNodeTime(new Date());
        dispatch(e.shiftKey ? { type: "addSibling", time } : { type: "addChild", time });
      } else if (e.key === "F2" && !e.shiftKey) {
        e.preventDefault();
        dispatch({ type: "startEdit" });
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [layout, state.editingId, dispatch]);

  // 只在选中结点变化时滚动，重新布局不会把用户手动滚开的视野拉回来。
  useEffect(() => {
    nodeEls.current
      .get(state.selectedId)
      ?.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" });
  }, [state.selectedId]);

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
            className={`node node-${box.node.kind}${box.node.id === state.selectedId ? " selected" : ""}`}
            aria-current={box.node.id === state.selectedId || undefined}
            style={{ left: box.x + offsetX, top: box.y + offsetY, width: box.width }}
            onDoubleClick={() => dispatch({ type: "startEdit", nodeId: box.node.id })}
          >
            <div className="node-meta">
              {box.node.kind === "idea" && <span className="node-icon" aria-label="想法">💡</span>}
              <time dateTime={box.node.time.replace(" ", "T")} title={box.node.time}>
                {box.node.time.slice(11)}
              </time>
            </div>
            {box.node.id === state.editingId ? (
              <NodeTextEditor
                text={box.node.text}
                onChange={(text) => dispatch({ type: "setText", text })}
                onCommit={() => dispatch({ type: "commitEdit" })}
              />
            ) : (
              <div className="node-text">
                <InlineMarkdown text={box.node.text} />
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function NodeTextEditor({
  text,
  onChange,
  onCommit,
}: {
  text: string;
  onChange: (text: string) => void;
  onCommit: () => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);

  // 进入编辑时聚焦并把光标放到末尾。不让浏览器滚动，滚动由选中结点的居中逻辑负责。
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  function onKeyDown(e: ReactKeyboardEvent<HTMLTextAreaElement>) {
    // 输入法正在组字时，Enter 和 Esc 属于输入法。
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if ((e.key === "Enter" && !e.shiftKey) || e.key === "Escape") {
      e.preventDefault();
      onCommit();
    }
  }

  return (
    <textarea
      ref={ref}
      className="node-text node-editor"
      value={text}
      rows={1}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={onKeyDown}
      // 点到别处时确认；切换窗口导致的失焦不算，回来后可以继续编辑。
      onBlur={() => {
        if (document.hasFocus()) onCommit();
      }}
    />
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

function isTextInput(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || target.tagName === "INPUT" || target.tagName === "TEXTAREA")
  );
}
