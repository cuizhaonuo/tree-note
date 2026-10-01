// 画布：标题在顶部，下方自上而下渲染整棵树。连线用 SVG，结点用 HTML。
//
// 选择状态：方向键移动选中状态，Enter / Shift+Enter 新建子结点 / 兄弟结点，F2 或双击编辑。
// 编辑状态：Enter 或 Esc 确认，Shift+Enter 换行。
// 空格折叠或展开选中结点的子树，折叠状态只保存在内存里。
// i 在事件和想法之间切换，t 弹出时间编辑框；兄弟结点按时间排列，每天第一个结点显示日期，
// 早于父结点的结点标红。
// Delete 确认后删除子树；x 标记剪切，v 粘贴为选中结点的子结点；Ctrl+Z 撤销。被拒绝的操作给出提示。
// Ctrl+R 或点击标题修改标题（Enter 确认，Esc 取消）；文件随标题改名由保存负责。
// 画布用 d3-zoom 缩放（滚轮）和平移（拖动），选中的结点会移动到视野中央。
// 打开搜索结果时选中那个结点，展开沿途的折叠并居中。

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { select } from "d3-selection";
import "d3-transition";
import { zoom, zoomIdentity, type ZoomBehavior } from "d3-zoom";
import { dayMarkers, timeViolations } from "../core/chronology";
import { expand, hiddenCount, reveal, toggleCollapsed } from "../core/collapse";
import { applyCommand, commandError, type Command, type EditorState } from "../core/commands";
import { layoutTree, type LayoutOptions, type NodeBox } from "../core/layout";
import { navigate, selectNode, type Direction } from "../core/navigation";
import { locateHit, type NodeLocator } from "../core/search";
import { findNode, formatNodeTime, nodeClock, nodeDate, type Note, type TreeNode } from "../core/note";
import { ConfirmDialog } from "./ConfirmDialog";
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

/** 要求选中某个结点（打开搜索结果）。每次要求都是新对象，同一个结点也会再选中一次。 */
export interface FocusRequest {
  target: NodeLocator;
}

interface TreeCanvasProps {
  initialState: EditorState;
  focus?: FocusRequest;
  /** 笔记内容变化后调用（不包括打开时的初始内容）。 */
  onNoteChange: (note: Note) => void;
}

export function TreeCanvas({ initialState, focus, onNoteChange }: TreeCanvasProps) {
  const [heights, setHeights] = useState<ReadonlyMap<string, number>>(new Map());
  const nodeEls = useRef(new Map<string, HTMLDivElement>());

  const [state, setState] = useState(initialState);
  const { note } = state;
  const dispatch = useCallback((command: Command) => setState((s) => applyCommand(s, command)), []);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [editingTime, setEditingTime] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
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

  // 搜索结果指向的结点：先确认正在进行的编辑，再选中它；沿途的折叠由上面的 reveal 展开。
  // 搜索之后笔记又被改过、结点已经不在了（或那个位置上换成了别的结点），就只给出提示。
  // 只在收到新的要求时执行一次，所以依赖里只有 focus。
  useEffect(() => {
    if (!focus) return;
    const node = locateHit(state.note.root, focus.target);
    if (!node) {
      setHint({ text: "找不到这个结点，笔记在搜索之后被修改过，请重新搜索" });
      return;
    }
    setState((s) => {
      const committed = s.editingId === null ? s : applyCommand(s, { type: "commitEdit" });
      return { ...committed, ...selectNode(committed.note.root, committed, node.id) };
    });
  }, [focus]);

  const layout = useMemo(() => layoutTree(note.root, heights, LAYOUT, collapsed), [note, heights, collapsed]);
  const dayMarkerIds = useMemo(() => dayMarkers(note.root), [note]);
  const tooEarlyIds = useMemo(() => timeViolations(note.root), [note]);

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

  /** 被规则拒绝的命令只给出提示；允许时执行 `proceed`，默认直接执行命令。 */
  const attempt = useCallback(
    (command: Command, proceed = () => dispatch(command)) => {
      const error = commandError(state, command);
      if (error) setHint({ text: error });
      else proceed();
    },
    [state, dispatch],
  );

  // Ctrl+R 在编辑结点时也有效：先确认编辑，再改标题。浏览器默认的刷新页面被拦下。
  useEffect(() => {
    if (confirmingDelete || editingTime) return;
    function onKeyDown(e: KeyboardEvent) {
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== "r") return;
      e.preventDefault();
      if (e.repeat) return;
      dispatch({ type: "commitEdit" });
      setEditingTitle(true);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [confirmingDelete, editingTime, dispatch]);

  useEffect(() => {
    if (state.editingId !== null || confirmingDelete || editingTime || editingTitle) return;
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
      } else if (e.key === "i") {
        e.preventDefault();
        dispatch({ type: "toggleKind" });
      } else if (e.key === "t") {
        e.preventDefault();
        setEditingTime(true);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [state, selected, layout, collapsed, confirmingDelete, editingTime, editingTitle, dispatch, attempt]);

  // 只在选中结点变化、折叠/展开、或选中结点的时间被修改（兄弟顺序可能变了）时居中，
  // 其他重新布局不会把用户手动拖开的视野拉回来。
  // 新出现的结点要等测量出真实高度后再居中，否则多行结点会偏。
  // 当前缩放比例保持不变，translateTo 按这个比例把结点中心移到视野中央。
  // 刚打开时选中的是根结点，它已经在视野顶部了，不需要居中。打开指向根结点的搜索结果（匹配标题）
  // 也是这样，和从笔记列表打开时看起来一样。
  const selectedTime = selected?.time;
  const lastCenteredFor = useRef({ selectedId: state.selectedId, collapsed, selectedTime });
  const centerPending = useRef(false);
  useEffect(() => {
    const last = lastCenteredFor.current;
    if (last.selectedId !== state.selectedId || last.collapsed !== collapsed || last.selectedTime !== selectedTime) {
      lastCenteredFor.current = { selectedId: state.selectedId, collapsed, selectedTime };
      centerPending.current = true;
    }
    const box = layout.boxes.find((b) => b.node.id === state.selectedId);
    if (!centerPending.current || !box || !heights.has(box.node.id) || !zoomBehavior.current) return;
    centerPending.current = false;
    select(viewportEl.current!)
      .transition()
      .duration(250)
      .call(zoomBehavior.current.translateTo, box.x + box.width / 2, box.y + box.height / 2);
  }, [state.selectedId, collapsed, selectedTime, layout, heights]);

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
      {editingTitle ? (
        <TitleEditor
          title={note.title}
          onConfirm={(title) => {
            setEditingTitle(false);
            attempt({ type: "rename", title });
          }}
          onCancel={() => setEditingTitle(false)}
        />
      ) : (
        <h1 className="note-title" title="点击或按 Ctrl+R 修改标题" onClick={() => setEditingTitle(true)}>
          {note.title}
        </h1>
      )}
      <div className="viewport" ref={viewportEl}>
        <div className="tree" ref={treeEl}>
          <svg className="links">
            {layout.links.map(({ parent, child }) => (
              <path key={child.node.id} d={linkPath(parent, child)} />
            ))}
          </svg>
          {layout.boxes.map((box) => {
            const isCollapsed = collapsed.has(box.node.id);
            const isTooEarly = tooEarlyIds.has(box.node.id);
            return (
              <div
                key={box.node.id}
                ref={(el) => {
                  if (el) nodeEls.current.set(box.node.id, el);
                  else nodeEls.current.delete(box.node.id);
                }}
                className={`node node-${box.node.kind}${box.node.id === state.selectedId ? " selected" : ""}${isCollapsed ? " collapsed" : ""}${box.node.id === state.cutId ? " cut" : ""}${isTooEarly ? " too-early" : ""}`}
                aria-current={box.node.id === state.selectedId || undefined}
                aria-expanded={box.node.children.length > 0 ? !isCollapsed : undefined}
                style={{ left: box.x, top: box.y, width: box.width }}
                onDoubleClick={() => dispatch({ type: "startEdit", nodeId: box.node.id })}
              >
                <div className="node-meta">
                  {box.node.kind === "idea" && <span className="node-icon" aria-label="想法">💡</span>}
                  <time
                    dateTime={box.node.time.replace(" ", "T")}
                    title={isTooEarly ? `${box.node.time}：早于父结点` : box.node.time}
                  >
                    {dayMarkerIds.has(box.node.id) ? box.node.time : nodeClock(box.node.time)}
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
      {editingTime && selected && (
        <TimeDialog
          time={selected.time}
          onConfirm={(time) => {
            setEditingTime(false);
            attempt({ type: "setTime", time });
          }}
          onCancel={() => setEditingTime(false)}
        />
      )}
      {confirmingDelete && selected && (
        <ConfirmDialog
          message={deleteMessage(selected)}
          confirmLabel="删除"
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

/** 删除前确认的提示：结点第一行文字，以及会一起删除的结点数。 */
function deleteMessage(node: TreeNode): string {
  const descendants = hiddenCount(node);
  const name = node.text.split("\n")[0] || "（空结点）";
  return `删除“${name}”${descendants > 0 ? `及其下面的 ${descendants} 个结点` : ""}？可以用 Ctrl+Z 撤销。`;
}

/** 修改结点时间：日期和时间两个输入框，Enter 确认，Esc 取消。 */
function TimeDialog({
  time,
  onConfirm,
  onCancel,
}: {
  time: string;
  onConfirm: (time: string) => void;
  onCancel: () => void;
}) {
  const [date, setDate] = useState(nodeDate(time));
  const [clock, setClock] = useState(nodeClock(time));

  function submit(e: FormEvent) {
    e.preventDefault();
    onConfirm(`${date} ${clock}`);
  }

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <form
        className="dialog"
        onSubmit={submit}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
      >
        <label htmlFor="node-time-date">结点时间（Enter 确认，Esc 取消）</label>
        <div className="time-inputs">
          <input id="node-time-date" type="date" required autoFocus value={date} onChange={(e) => setDate(e.target.value)} />
          <input type="time" required aria-label="时刻" value={clock} onChange={(e) => setClock(e.target.value)} />
        </div>
      </form>
    </div>
  );
}

/** 修改标题：Enter 或点到别处确认，Esc 取消。 */
function TitleEditor({
  title,
  onConfirm,
  onCancel,
}: {
  title: string;
  onConfirm: (title: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(title);
  // 确认或取消后输入框被移除，这时的失焦不能再确认一次。
  const done = useRef(false);

  function finish(confirm: boolean) {
    if (done.current) return;
    done.current = true;
    if (confirm) onConfirm(value);
    else onCancel();
  }

  return (
    <input
      className="note-title-input"
      aria-label="笔记标题"
      autoFocus
      onFocus={(e) => e.currentTarget.select()}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing || e.keyCode === 229) return;
        if (e.key === "Enter" || e.key === "Escape") {
          e.preventDefault();
          finish(e.key === "Enter");
        }
      }}
      // 和结点编辑一样：切换窗口导致的失焦不算。
      onBlur={() => {
        if (document.hasFocus()) finish(true);
      }}
    />
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
