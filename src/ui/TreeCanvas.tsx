// 画布：标题在顶部，下方自上而下渲染整棵树。连线用 SVG，结点用 HTML。
//
// 选择状态：方向键移动选中状态，Enter / Shift+Enter 新建子结点 / 兄弟结点，F2 或双击编辑。
// 编辑状态：Enter 或 Esc 确认，Shift+Enter 换行。
// 空格折叠或展开选中结点的子树，折叠状态只保存在内存里。
// Delete 确认后删除子树；x 标记剪切，v 粘贴为选中结点的子结点；Ctrl+Z 撤销。被拒绝的操作给出提示。
// 画布用 d3-zoom 缩放（滚轮）和平移（拖动），选中的结点会移动到视野中央。

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { select } from "d3-selection";
import "d3-transition";
import { zoom, zoomIdentity, type ZoomBehavior } from "d3-zoom";
import { expand, hiddenCount, reveal, toggleCollapsed } from "../core/collapse";
import { applyCommand, commandError, type Command, type EditorState } from "../core/commands";
import { layoutTree, type LayoutOptions, type NodeBox } from "../core/layout";
import { navigate, type Direction } from "../core/navigation";
import { findNode, formatNodeTime, type Note, type TreeNode } from "../core/note";
import { InlineMarkdown } from "./InlineMarkdown";

const LAYOUT: LayoutOptions = {
  nodeWidth: 220,
  horizontalGap: 28,
  verticalGap: 48,
  defaultHeight: 56,
};
/** 打开笔记时根结点离视野顶部的距离。 */
const TOP_MARGIN = 24;
const SCALE_EXTENT: [number, number] = [0.1, 2];
const HINT_MS = 2500;

const ARROW_KEYS: Record<string, Direction> = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
};

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
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [hint, setHint] = useState<{ text: string } | null>(null);

  // 每次提示都是新对象，同一句提示连续出现时也会重新计时。
  useEffect(() => {
    if (!hint) return;
    const timer = setTimeout(() => setHint(null), HINT_MS);
    return () => clearTimeout(timer);
  }, [hint]);

  // 撤销或粘贴后选中的结点可能藏在被折叠的子树里，展开它的祖先。
  useEffect(() => {
    setCollapsed((c) => reveal(c, note.root, state.selectedId));
  }, [note, state.selectedId]);

  const layout = useMemo(() => layoutTree(note.root, heights, LAYOUT, collapsed), [note, heights, collapsed]);

  const viewportEl = useRef<HTMLDivElement>(null);
  const treeEl = useRef<HTMLDivElement>(null);
  const zoomBehavior = useRef<ZoomBehavior<HTMLDivElement, unknown>>(null);

  // 变换直接写到 DOM 上，缩放和拖动时不触发 React 重新渲染。
  useEffect(() => {
    const viewport = viewportEl.current!;
    const behavior = zoom<HTMLDivElement, unknown>()
      .scaleExtent(SCALE_EXTENT)
      // 编辑框里的拖动用来选择文字，不平移画布；滚轮照常缩放。
      .filter((e: Event) => defaultZoomFilter(e) && (e.type === "wheel" || !isTextInput(e.target)))
      .on("zoom", ({ transform: { x, y, k } }) => {
        // 不能用 transform.toString()：它是不带单位的 SVG 写法，CSS 会当作无效值忽略。
        treeEl.current!.style.transform = `translate(${x}px, ${y}px) scale(${k})`;
      });
    // 双击用来编辑结点，不缩放。
    select(viewport).call(behavior).on("dblclick.zoom", null);
    // 根结点的中心线在 x = 0：打开时把它放在视野顶部正中。
    behavior.transform(select(viewport), zoomIdentity.translate(viewport.clientWidth / 2, TOP_MARGIN));
    zoomBehavior.current = behavior;
    return () => {
      select(viewport).on(".zoom", null);
    };
  }, []);

  // 和上一次的内容比，而不是和打开时比：撤销回打开时的内容也要保存。
  const lastNote = useRef(initialState.note);
  useEffect(() => {
    if (note === lastNote.current) return;
    lastNote.current = note;
    onNoteChange(note);
  }, [note, onNoteChange]);

  const selected = findNode(note.root, (n) => n.id === state.selectedId);

  useEffect(() => {
    if (state.editingId !== null || confirmingDelete) return;
    /** 被规则拒绝的命令只给出提示；允许时执行 `proceed`，默认直接执行命令。 */
    function attempt(command: Command, proceed = () => dispatch(command)) {
      const error = commandError(state, command);
      if (error) setHint({ text: error });
      else proceed();
    }
    function onKeyDown(e: KeyboardEvent) {
      // 编辑框里确认用的 Enter 会继续冒泡到这里，它已经被处理过了（defaultPrevented），不能再新建结点。
      if (e.defaultPrevented || isTextInput(e.target)) return;
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "z") {
        e.preventDefault();
        dispatch({ type: "undo" });
        return;
      }
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      const direction = ARROW_KEYS[e.key];
      if (direction && !e.shiftKey) {
        e.preventDefault();
        setState((s) => ({ ...s, ...navigate(s.note.root, s, direction, { collapsed, layout }) }));
        return;
      }
      // 按住不放时不连续新建结点（第一次按下之后焦点已经在新结点的编辑框里了），也不反复折叠。
      if (e.repeat) return;
      if (e.key === " " && !e.shiftKey) {
        e.preventDefault();
        if (selected) setCollapsed((c) => toggleCollapsed(c, selected));
      } else if (e.key === "Enter") {
        e.preventDefault();
        // 新的子结点要能看见并编辑，所以先展开选中的结点。
        if (!e.shiftKey) setCollapsed((c) => expand(c, state.selectedId));
        const time = formatNodeTime(new Date());
        dispatch(e.shiftKey ? { type: "addSibling", time } : { type: "addChild", time });
      } else if (e.key === "F2" && !e.shiftKey) {
        e.preventDefault();
        dispatch({ type: "startEdit" });
      } else if (e.key === "Delete" && !e.shiftKey) {
        e.preventDefault();
        attempt({ type: "deleteSubtree" }, () => setConfirmingDelete(true));
      } else if (e.key === "x" || e.key === "v") {
        e.preventDefault();
        attempt({ type: e.key === "x" ? "cut" : "paste" });
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [state, selected, layout, collapsed, confirmingDelete, dispatch]);

  // 只在选中结点变化或折叠/展开时居中，其他重新布局不会把用户手动拖开的视野拉回来。
  // 新出现的结点要等测量出真实高度后再居中，否则多行结点会偏。
  // 当前缩放比例保持不变，translateTo 按这个比例把结点中心移到视野中央。
  // 刚打开时选中的是根结点，它已经在视野顶部了，不需要居中。
  const lastCenteredFor = useRef({ selectedId: state.selectedId, collapsed });
  const centerPending = useRef(false);
  useEffect(() => {
    if (lastCenteredFor.current.selectedId !== state.selectedId || lastCenteredFor.current.collapsed !== collapsed) {
      lastCenteredFor.current = { selectedId: state.selectedId, collapsed };
      centerPending.current = true;
    }
    const box = layout.boxes.find((b) => b.node.id === state.selectedId);
    if (!centerPending.current || !box || !heights.has(box.node.id) || !zoomBehavior.current) return;
    centerPending.current = false;
    select(viewportEl.current!)
      .transition()
      .duration(250)
      .call(zoomBehavior.current.translateTo, box.x + box.width / 2, box.y + box.height / 2);
  }, [state.selectedId, collapsed, layout, heights]);

  // 结点高度随文本行数变化：渲染后测量，高度有变化再重新布局。
  useLayoutEffect(() => {
    const measured = new Map<string, number>();
    for (const [id, el] of nodeEls.current) measured.set(id, el.offsetHeight);
    const changed =
      measured.size !== heights.size ||
      [...measured].some(([id, h]) => heights.get(id) !== h);
    if (changed) setHeights(measured);
  }, [layout, heights]);

  return (
    <div className="canvas">
      <h1 className="note-title">{note.title}</h1>
      <div className="viewport" ref={viewportEl}>
        <div className="tree" ref={treeEl}>
          <svg className="links">
            {layout.links.map(({ parent, child }) => (
              <path key={child.node.id} d={linkPath(parent, child)} />
            ))}
          </svg>
          {layout.boxes.map((box) => {
            const isCollapsed = collapsed.has(box.node.id);
            return (
              <div
                key={box.node.id}
                ref={(el) => {
                  if (el) nodeEls.current.set(box.node.id, el);
                  else nodeEls.current.delete(box.node.id);
                }}
                className={`node node-${box.node.kind}${box.node.id === state.selectedId ? " selected" : ""}${isCollapsed ? " collapsed" : ""}${box.node.id === state.cutId ? " cut" : ""}`}
                aria-current={box.node.id === state.selectedId || undefined}
                aria-expanded={box.node.children.length > 0 ? !isCollapsed : undefined}
                style={{ left: box.x, top: box.y, width: box.width }}
                onDoubleClick={() => dispatch({ type: "startEdit", nodeId: box.node.id })}
              >
                <div className="node-meta">
                  {box.node.kind === "idea" && <span className="node-icon" aria-label="想法">💡</span>}
                  <time dateTime={box.node.time.replace(" ", "T")} title={box.node.time}>
                    {box.node.time.slice(11)}
                  </time>
                  {box.node.id === state.cutId && (
                    <span className="node-cut-badge" title="已剪切，到目标结点按 v 粘贴">
                      ✂ 已剪切
                    </span>
                  )}
                  {isCollapsed && (
                    <span className="node-hidden-count" title="已折叠，按空格展开">
                      +{hiddenCount(box.node)}
                    </span>
                  )}
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
            );
          })}
        </div>
      </div>
      {hint && (
        <div className="hint" role="status">
          {hint.text}
        </div>
      )}
      {confirmingDelete && selected && (
        <ConfirmDelete
          node={selected}
          onConfirm={() => {
            setConfirmingDelete(false);
            dispatch({ type: "deleteSubtree" });
          }}
          onCancel={() => setConfirmingDelete(false)}
        />
      )}
    </div>
  );
}

function ConfirmDelete({ node, onConfirm, onCancel }: { node: TreeNode; onConfirm: () => void; onCancel: () => void }) {
  const descendants = hiddenCount(node);
  const name = node.text.split("\n")[0] || "（空结点）";
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div
        className="dialog"
        role="alertdialog"
        aria-labelledby="confirm-delete-message"
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
      >
        <p id="confirm-delete-message">
          删除“{name}”{descendants > 0 && `及其下面的 ${descendants} 个结点`}？可以用 Ctrl+Z 撤销。
        </p>
        <div className="dialog-actions">
          <button onClick={onCancel}>取消</button>
          <button className="danger" autoFocus onClick={onConfirm}>
            删除
          </button>
        </div>
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

function linkPath(parent: NodeBox, child: NodeBox): string {
  const x1 = parent.x + parent.width / 2;
  const y1 = parent.y + parent.height;
  const x2 = child.x + child.width / 2;
  const y2 = child.y;
  const midY = (y1 + y2) / 2;
  return `M${x1},${y1} C${x1},${midY} ${x2},${midY} ${x2},${y2}`;
}

/** d3-zoom 的默认过滤：忽略右键；Ctrl+滚轮是触控板的双指缩放。 */
function defaultZoomFilter(e: Event): boolean {
  const { ctrlKey, button } = e as MouseEvent;
  return (!ctrlKey || e.type === "wheel") && !button;
}

function isTextInput(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || target.tagName === "INPUT" || target.tagName === "TEXTAREA")
  );
}
