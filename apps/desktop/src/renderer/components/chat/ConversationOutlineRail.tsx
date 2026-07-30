import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MutableRefObject,
  type RefObject,
} from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { Tooltip } from '@/components/ui/tooltip';
import {
  CONVERSATION_OUTLINE_MIN_TURNS,
  normalizeConversationOutlinePreview,
  shouldShowConversationOutline,
  type ConversationOutlineEntry,
} from '../../../shared/conversationOutline';

/**
 * 无障碍名称的长度上限。可访问名的职责是「标识跳转目标」，不是复述内容：
 * 提问 140 字 + 回复 160 字全塞进 aria-label，读屏用户光过一根刻度就要听
 * 300 字，还无法跳过。所以这里只留一小段提问，回复预览留给视觉 tooltip。
 */
const OUTLINE_ARIA_PREVIEW_LIMIT = 48;

/** 滚动停止判定：连续这么久没有 scroll 事件就认为跳转落定。 */
const SCROLL_SETTLE_MS = 180;
/**
 * 钉住选中项的绝对上限。目标不在 render window 时要先异步补齐历史再滚动，
 * 因此上限必须覆盖「取数 + 平滑滚动」；同时兜住「目标已在视口内、滚动距离为 0
 * 所以一个 scroll 事件都不会来」的情况。
 */
const SELECTION_PIN_MAX_MS = 2_000;

export interface ConversationOutlineRailProps {
  entries: readonly ConversationOutlineEntry[];
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  onSelect: (entry: ConversationOutlineEntry) => void | Promise<void>;
  /** Parent already gates route ownership and compact/embedded layouts. */
  show?: boolean;
  /** Absolute position is calculated by MessageStream from its content width. */
  style?: CSSProperties;
}

export interface ConversationOutlineRailHandle {
  /** 用户改走其他导航路径时，立即释放仍在等待异步定位的 active。 */
  cancelSelection: () => void;
}

const EMPTY_ACTIVE_IDS: ReadonlySet<string> = new Set();

function sameIdSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) return false;
  for (const id of left) {
    if (!right.has(id)) return false;
  }
  return true;
}

/**
 * 视口内出现的所有 turn。
 *
 * 一个 turn 在正文里占据的是「它的 user 消息到下一条 user 消息之间」的整段区间，
 * 所以判据是区间与视口相交，而不是某条消息越过一根激活线——后者在一屏能装下多个
 * 短 turn 时会让 active 随滚动来回跳。最后一个 turn 的区间延伸到正文末尾；若渲染
 * 窗口中间有未加载的目录项，则只用当前 user 节点自身作为该段的保守边界。
 */
function useVisibleOutlineMessageIds(
  entries: readonly ConversationOutlineEntry[],
  scrollContainerRef: RefObject<HTMLDivElement | null>,
): ReadonlySet<string> {
  const fallbackIds = useMemo(() => {
    const last = entries.at(-1)?.messageId;
    return last ? new Set([last]) : EMPTY_ACTIVE_IDS;
  }, [entries]);
  const [visibleIds, setVisibleIds] = useState<ReadonlySet<string>>(fallbackIds);
  /**
   * clientId → 目录项 的映射，只在 entries 变化时重建。
   *
   * measure() 每个 scroll / resize tick 都会跑（rAF 调度），而 entries 是**整份会话**的
   * 索引（长会话上千轮）。在 measure() 里现建这张表等于每帧一次 O(总轮数) 的遍历与分配，
   * 长会话滚动会卡；而 DOM 查询实际只需要当前渲染出来的那几十个节点。
   *
   * 用 useMemo 而不是 useRef + useEffect 填表：effect 在 paint 之后才跑，而下面订阅
   * scroll 的 effect 挂上就立刻 schedule() 一次，用 effect 填表会让第一次 measure()
   * 读到空表、在 size === 0 处直接返回，active 刻度要等下一次滚动才亮。
   */
  const outlineIndex = useMemo(() => {
    // 直接 set 而不是 flatMap 出一个中间数组再喂 Map：少一次全量分配，也更好读。
    const byClientId = new Map<string, { messageId: string; entryIndex: number }>();
    entries.forEach((entry, entryIndex) => {
      if (entry.clientId) byClientId.set(entry.clientId, { messageId: entry.messageId, entryIndex });
    });
    return { byClientId, total: entries.length };
  }, [entries]);
  const frameRef = useRef<number | null>(null);
  const frameUsesRafRef = useRef(false);

  const measure = useCallback(() => {
    const root = scrollContainerRef.current;
    if (!root) return;
    const { byClientId, total } = outlineIndex;
    if (byClientId.size === 0) return;

    const rootRect = root.getBoundingClientRect();
    const viewTop = rootRect.top;
    const viewBottom = viewTop + root.clientHeight;
    const turns: Array<{ messageId: string; entryIndex: number; top: number; bottom: number }> = [];
    for (const node of root.querySelectorAll<HTMLElement>('[data-user-msg-id]')) {
      const clientId = node.getAttribute('data-user-msg-id');
      const entry = clientId ? byClientId.get(clientId) : undefined;
      if (!entry) continue;
      const rect = node.getBoundingClientRect();
      turns.push({ ...entry, top: rect.top, bottom: rect.bottom });
    }
    if (turns.length === 0) return;

    const next = new Set<string>();
    for (let index = 0; index < turns.length; index += 1) {
      const turn = turns[index];
      const followingTurn = turns[index + 1];
      const isFollowingEntry = followingTurn?.entryIndex === turn.entryIndex + 1;
      const isLastEntry = turn.entryIndex === total - 1;
      // 长会话可能同时渲染“目标附近”和“会话尾部”两段，中间目录项并不在 DOM。
      // 只有目录里真正相邻的下一轮才能充当区间边界，避免前一段跨过缺口误亮到尾部。
      const rangeBottom = isFollowingEntry
        ? followingTurn.top
        : isLastEntry
          ? Number.POSITIVE_INFINITY
          : turn.bottom;
      if (turn.top < viewBottom && rangeBottom > viewTop) next.add(turn.messageId);
    }
    if (next.size === 0) {
      // 当前屏可能正落在两个渲染岛之间，选离视口最近的节点，避免无条件保留
      // 最早一轮（尤其是回到底部时）。所有节点都在屏上方时自然取最后一个，
      // 都在屏下方时取第一个，仍然不会让导轨出现全灭空档。
      const nearestTurn = turns.reduce<{ turn: (typeof turns)[number]; distance: number } | null>(
        (nearest, turn) => {
          const distance =
            turn.bottom <= viewTop
              ? viewTop - turn.bottom
              : turn.top >= viewBottom
                ? turn.top - viewBottom
                : 0;
          return !nearest || distance < nearest.distance ? { turn, distance } : nearest;
        },
        null,
      );
      next.add((nearestTurn?.turn ?? turns[0]).messageId);
    }
    setVisibleIds((current) => (sameIdSet(current, next) ? current : next));
  }, [outlineIndex, scrollContainerRef]);

  useEffect(() => {
    const root = scrollContainerRef.current;
    if (!root) return;
    const schedule = () => {
      if (frameRef.current !== null) return;
      if (typeof window.requestAnimationFrame === 'function') {
        frameUsesRafRef.current = true;
        frameRef.current = window.requestAnimationFrame(() => {
          frameRef.current = null;
          measure();
        });
      } else {
        frameUsesRafRef.current = false;
        frameRef.current = window.setTimeout(() => {
          frameRef.current = null;
          measure();
        }, 0);
      }
    };
    root.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    const resizeObserver =
      typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null;
    resizeObserver?.observe(root);
    const content = root.firstElementChild;
    if (content instanceof HTMLElement) resizeObserver?.observe(content);
    schedule();
    return () => {
      root.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      resizeObserver?.disconnect();
      if (frameRef.current !== null) {
        if (frameUsesRafRef.current && typeof window.cancelAnimationFrame === 'function') {
          window.cancelAnimationFrame(frameRef.current);
        } else window.clearTimeout(frameRef.current);
        frameRef.current = null;
      }
    };
  }, [measure, entries]);

  useEffect(() => {
    setVisibleIds((current) => {
      const kept = new Set(
        [...current].filter((id) => entries.some((entry) => entry.messageId === id)),
      );
      if (kept.size === 0) return fallbackIds;
      return sameIdSet(current, kept) ? current : kept;
    });
  }, [entries, fallbackIds]);

  return visibleIds;
}

/**
 * 点击跳转期间钉住被点的那一项。
 *
 * 平滑滚动会连续掠过中间的 turn，若此时交还给几何判定，active 会一路闪过去。
 * 等异步定位完成后才进入滚动阶段并启动绝对超时；否则远程取数超过 2 秒时会提前
 * 解除 active。滚动阶段的释放条件取三者最早：滚动停止（连续 SCROLL_SETTLE_MS
 * 无 scroll 事件）、用户自己动手（wheel / touch / 键盘）、绝对超时兜底。
 */
function usePinnedSelection(
  entries: readonly ConversationOutlineEntry[],
  scrollContainerRef: RefObject<HTMLDivElement | null>,
): {
  pinnedMessageId: string | null;
  pinSelection: (messageId: string) => number;
  markSelectionReady: (selectionRevision: number) => void;
  releaseSelection: (selectionRevision: number) => void;
  cancelSelection: () => void;
} {
  const [pinnedMessageId, setPinnedMessageId] = useState<string | null>(null);
  const pinnedMessageIdRef = useRef<string | null>(null);
  const selectionRevisionRef = useRef(0);
  const selectionPendingRef = useRef(false);
  const settleTimerRef = useRef<number | null>(null);
  const maxTimerRef = useRef<number | null>(null);

  const clearTimers = useCallback(() => {
    if (settleTimerRef.current !== null) {
      window.clearTimeout(settleTimerRef.current);
      settleTimerRef.current = null;
    }
    if (maxTimerRef.current !== null) {
      window.clearTimeout(maxTimerRef.current);
      maxTimerRef.current = null;
    }
  }, []);

  const release = useCallback(() => {
    clearTimers();
    pinnedMessageIdRef.current = null;
    selectionPendingRef.current = false;
    setPinnedMessageId((current) => (current === null ? current : null));
  }, [clearTimers]);

  const pinSelection = useCallback(
    (messageId: string) => {
      clearTimers();
      selectionRevisionRef.current += 1;
      pinnedMessageIdRef.current = messageId;
      selectionPendingRef.current = true;
      setPinnedMessageId(messageId);
      return selectionRevisionRef.current;
    },
    [clearTimers],
  );

  const markSelectionReady = useCallback(
    (selectionRevision: number) => {
      // 用户可能在前一次远程请求完成前又点了别处，旧请求不得改动新选择的计时器。
      if (
        selectionRevisionRef.current !== selectionRevision ||
        pinnedMessageIdRef.current === null
      ) {
        return;
      }
      selectionPendingRef.current = false;
      maxTimerRef.current = window.setTimeout(release, SELECTION_PIN_MAX_MS);
    },
    [release],
  );

  const releaseSelection = useCallback(
    (selectionRevision: number) => {
      if (selectionRevisionRef.current === selectionRevision) release();
    },
    [release],
  );

  useEffect(
    () => () => {
      clearTimers();
      // 使卸载后才完成的远程 Promise 失效，避免它重新启动兜底定时器。
      selectionRevisionRef.current += 1;
      pinnedMessageIdRef.current = null;
      selectionPendingRef.current = false;
    },
    [clearTimers],
  );

  useEffect(() => {
    if (pinnedMessageId === null) return;
    const root = scrollContainerRef.current;
    const onScroll = () => {
      // 请求仍在补齐目标附近历史时，scroll 可能来自窗口重建或锚点补偿，不能把它
      // 当作跳转已经落定；用户主动接管仍由 wheel/touch/keydown 立即释放。
      if (selectionPendingRef.current) return;
      if (settleTimerRef.current !== null) window.clearTimeout(settleTimerRef.current);
      settleTimerRef.current = window.setTimeout(release, SCROLL_SETTLE_MS);
    };
    root?.addEventListener('scroll', onScroll, { passive: true });
    root?.addEventListener('wheel', release, { passive: true });
    root?.addEventListener('touchstart', release, { passive: true });
    window.addEventListener('keydown', release);
    return () => {
      root?.removeEventListener('scroll', onScroll);
      root?.removeEventListener('wheel', release);
      root?.removeEventListener('touchstart', release);
      window.removeEventListener('keydown', release);
    };
  }, [pinnedMessageId, release, scrollContainerRef]);

  useEffect(() => {
    if (pinnedMessageId === null) return;
    if (!entries.some((entry) => entry.messageId === pinnedMessageId)) release();
  }, [entries, pinnedMessageId, release]);

  return {
    pinnedMessageId,
    pinSelection,
    markSelectionReady,
    releaseSelection,
    cancelSelection: release,
  };
}

function moveFocus(refs: MutableRefObject<Array<HTMLButtonElement | null>>, index: number): void {
  refs.current[index]?.focus();
}

/**
 * 一列细刻度，左边缘对齐、hover / active 时向右生长。它活在消息滚动容器之外，
 * 所以既不改变消息高度，也不干扰向上翻页的锚定补偿。
 */
export const ConversationOutlineRail = forwardRef<
  ConversationOutlineRailHandle,
  ConversationOutlineRailProps
>(function ConversationOutlineRail(
  { entries, scrollContainerRef, onSelect, show = true, style },
  ref,
) {
  const { t } = useTranslation();
  const [focusedIndex, setFocusedIndex] = useState(0);
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const railScrollerRef = useRef<HTMLDivElement>(null);
  const geometryActiveIds = useVisibleOutlineMessageIds(entries, scrollContainerRef);
  const { pinnedMessageId, pinSelection, markSelectionReady, releaseSelection, cancelSelection } =
    usePinnedSelection(entries, scrollContainerRef);
  useImperativeHandle(ref, () => ({ cancelSelection }), [cancelSelection]);
  // 跳转进行中只亮被点那一项；落定后交还给「视口内全部 turn」的判定。
  const activeIds = useMemo(
    () => (pinnedMessageId ? new Set([pinnedMessageId]) : geometryActiveIds),
    [geometryActiveIds, pinnedMessageId],
  );
  // aria-current 规范上每组只应有一个，取最靠上的那一项；视觉高亮不受此限。
  const primaryActiveId = useMemo(
    () => entries.find((entry) => activeIds.has(entry.messageId))?.messageId ?? null,
    [activeIds, entries],
  );
  const isVisible = show && shouldShowConversationOutline(entries, CONVERSATION_OUTLINE_MIN_TURNS);

  useEffect(() => {
    setFocusedIndex((current) => Math.max(0, Math.min(current, entries.length - 1)));
  }, [entries]);

  useEffect(() => {
    if (!primaryActiveId) return;
    const index = entries.findIndex((entry) => entry.messageId === primaryActiveId);
    const button = index >= 0 ? buttonRefs.current[index] : null;
    const scroller = railScrollerRef.current;
    if (!button || !scroller) return;
    const buttonRect = button.getBoundingClientRect();
    const scrollerRect = scroller.getBoundingClientRect();
    if (buttonRect.top < scrollerRect.top) {
      scroller.scrollTop -= scrollerRect.top - buttonRect.top;
    } else if (buttonRect.bottom > scrollerRect.bottom) {
      scroller.scrollTop += buttonRect.bottom - scrollerRect.bottom;
    }
  }, [primaryActiveId, entries]);

  const selectEntry = useCallback(
    (entry: ConversationOutlineEntry) => {
      const selectionRevision = pinSelection(entry.messageId);
      try {
        const result = onSelect(entry);
        if (result) {
          void result.then(
            () => markSelectionReady(selectionRevision),
            () => {
              // 跳转失败时不保留一个永远无法落定的 active；业务错误由调用方负责提示。
              releaseSelection(selectionRevision);
            },
          );
        } else {
          markSelectionReady(selectionRevision);
        }
      } catch {
        releaseSelection(selectionRevision);
      }
    },
    [markSelectionReady, onSelect, pinSelection, releaseSelection],
  );

  const entryButtons = useMemo(
    () =>
      entries.map((entry, index) => {
        const isActive = activeIds.has(entry.messageId);
        const label = t('chat.conversationOutline.itemAria', {
          index: index + 1,
          preview: normalizeConversationOutlinePreview(entry.preview, OUTLINE_ARIA_PREVIEW_LIMIT),
        });
        // 提问与回复靠层级区分，不加角色标签（省掉 4 语言文案，也不占宽度）。
        // 颜色不能用 --text-* 系列：tooltip 是 Light/Dark 都深底的反色浮层，
        // 二级文本只能在 --tooltip-text 上降透明度，否则 Light 模式会糊掉。
        const tipContent = entry.replyPreview ? (
          <span className="flex flex-col gap-1">
            <span className="line-clamp-2">{entry.preview}</span>
            <span className="line-clamp-2 text-12 leading-[1.33] opacity-70">
              {entry.replyPreview}
            </span>
          </span>
        ) : (
          entry.preview
        );
        return (
          // 行高 = 刻度间距，且 ol 上不留 gap:相邻热区彼此相接，鼠标竖向移动
          // 全程都落在某个 trigger 上，tooltip 不会因为掉进行间空隙而中断。
          <li key={entry.messageId} className="flex h-4 shrink-0 items-center">
            <Tooltip.Root>
              <Tooltip.Trigger asChild>
                <button
                  ref={(node) => {
                    buttonRefs.current[index] = node;
                  }}
                  type="button"
                  tabIndex={index === focusedIndex ? 0 : -1}
                  aria-label={label}
                  aria-current={entry.messageId === primaryActiveId ? 'location' : undefined}
                  data-conversation-outline-id={entry.messageId}
                  data-active={isActive ? 'true' : undefined}
                  className={cn(
                    // 热区铺满整行、比刻度宽得多：竖向移动不掉出，横向也有容错。
                    // 24px 是 §5 间距刻度上的值（原先 28px 不在刻度上），仍比最长
                    // 刻度 16px 宽出 8px 容错，同时少压 4px 到正文左缘上。
                    'group flex h-4 w-6 shrink-0 items-center justify-start',
                    'pointer-events-auto bg-transparent p-0',
                    'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--focus-ring-soft)]',
                  )}
                  onFocus={() => setFocusedIndex(index)}
                  onClick={() => selectEntry(entry)}
                  onKeyDown={(event) => {
                    const isNavigationKey =
                      event.key === 'ArrowUp' ||
                      event.key === 'ArrowDown' ||
                      event.key === 'ArrowLeft' ||
                      event.key === 'ArrowRight' ||
                      event.key === 'Home' ||
                      event.key === 'End';
                    if (isNavigationKey) {
                      // MessageStream has a window-level history-key listener.
                      // Keep rail navigation from accidentally triggering paging.
                      event.preventDefault();
                      event.stopPropagation();
                      const nextIndex =
                        event.key === 'Home'
                          ? 0
                          : event.key === 'End'
                            ? entries.length - 1
                            : event.key === 'ArrowUp' || event.key === 'ArrowLeft'
                              ? Math.max(0, index - 1)
                              : Math.min(entries.length - 1, index + 1);
                      setFocusedIndex(nextIndex);
                      moveFocus(buttonRefs, nextIndex);
                      return;
                    }
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      event.stopPropagation();
                      selectEntry(entry);
                    }
                  }}
                >
                  {/* 刻度左边缘固定，hover / active 向右生长（朝正文方向）。 */}
                  <span
                    aria-hidden="true"
                    className={cn(
                      // 时长必须引用 motion token（§14.4 禁止硬编码 duration）。
                      // 走 fast 档：hover 时长 8px 是状态反馈，不是 base 档所指的
                      // 展开折叠 / 面板收展。曲线显式取 ease-move（宽度是尺寸插值），
                      // 不靠 Tailwind 默认值恰好等于该 token。
                      'block h-0.5 rounded-full',
                      'transition-[width,background-color] duration-[var(--motion-fast)]',
                      'ease-[var(--motion-ease-move)]',
                      isActive
                        ? 'w-4 bg-[var(--text-secondary)]'
                        : 'w-2 bg-[var(--border-default)] group-hover:w-4 group-hover:bg-[var(--text-tertiary)]',
                    )}
                  />
                </button>
              </Tooltip.Trigger>
              {/* 固定宽度让不同长度的目录提示保持同一视觉边界；长文本仍按单词换行。 */}
              <Tooltip.Content side="right" className="w-[300px] max-w-[300px] break-words">
                {tipContent}
              </Tooltip.Content>
            </Tooltip.Root>
          </li>
        );
      }),
    [activeIds, entries, focusedIndex, primaryActiveId, selectEntry, t],
  );

  if (!isVisible) return null;

  return (
    <nav
      aria-label={t('chat.conversationOutline.navAria')}
      data-testid="conversation-outline-rail"
      // justify-center:刻度列在 top/bottom 划出的竖带里垂直居中；配合下面的
      // max-h-full，列高超过竖带时自动填满(居中退化为无操作)并自己滚动。
      className="pointer-events-none absolute z-10 flex w-6 flex-col items-start justify-center"
      style={style}
    >
      <div
        ref={railScrollerRef}
        className="pointer-events-auto max-h-full overflow-y-auto overflow-x-visible py-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {/*
         * 整列共用一个 Provider。Tip 组件是每个实例自带一个 TooltipProvider 的，
         * 而 skipDelayDuration 是 Provider 级状态——那样每根刻度都要重新等满
         * delay，鼠标竖向划过去会看到 tooltip 反复消失再冒出。这里直接用
         * primitives：首次 hover 等 200ms，之后 700ms 内切到相邻刻度立即显示，
         * 于是竖向移动过程中 tooltip 只是跟着换内容，不再中断。
         */}
        <Tooltip.Provider delayDuration={200} skipDelayDuration={700}>
          <ol className="flex flex-col items-start">{entryButtons}</ol>
        </Tooltip.Provider>
      </div>
    </nav>
  );
});
