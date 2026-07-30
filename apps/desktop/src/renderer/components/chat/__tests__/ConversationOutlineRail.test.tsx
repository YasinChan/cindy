// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { createRef, useRef, type KeyboardEventHandler, type ReactNode, type Ref } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ConversationOutlineEntry } from '../../../../shared/conversationOutline';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    // 把插值一并透出，才能断言 aria-label 实际带了什么、有多长。
    t: (key: string, options?: Record<string, unknown>) =>
      options?.index ? `${key}:${String(options.index)}:${String(options.preview ?? '')}` : key,
  }),
}));

// 真实 Tooltip 只在 hover 后 portal 出内容；这里把 Content 直接渲染进 DOM，
// 以便断言 tooltip 的两段式内容（提问 + 回复预览）。
vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: {
    Provider: ({ children }: { children: ReactNode }) => <>{children}</>,
    Root: ({ children }: { children: ReactNode }) => <>{children}</>,
    Trigger: ({ children }: { children: ReactNode }) => <>{children}</>,
    Content: ({ children }: { children: ReactNode }) => (
      <span data-testid="tip-content">{children}</span>
    ),
  },
}));

import {
  ConversationOutlineRail,
  type ConversationOutlineRailHandle,
} from '../ConversationOutlineRail';

function makeEntries(count: number): ConversationOutlineEntry[] {
  return Array.from({ length: count }, (_, index) => ({
    messageId: `message-${index + 1}`,
    createdAt: index + 1,
    preview: `Turn ${index + 1}`,
  }));
}

function makeLocatableEntries(count: number): ConversationOutlineEntry[] {
  return makeEntries(count).map((entry, index) => ({
    ...entry,
    clientId: `client-${index + 1}`,
  }));
}

interface RailHarnessProps {
  entries: readonly ConversationOutlineEntry[];
  onSelect?: (entry: ConversationOutlineEntry) => void | Promise<void>;
  onKeyDown?: KeyboardEventHandler<HTMLDivElement>;
  show?: boolean;
  railRef?: Ref<ConversationOutlineRailHandle>;
}

function RailHarness({
  entries,
  onSelect = () => undefined,
  onKeyDown,
  show = true,
  railRef,
}: RailHarnessProps) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  return (
    <div onKeyDown={onKeyDown}>
      <div ref={scrollContainerRef}>
        <div />
      </div>
      <ConversationOutlineRail
        ref={railRef}
        entries={entries}
        scrollContainerRef={scrollContainerRef}
        onSelect={onSelect}
        show={show}
      />
    </div>
  );
}

function stubRect(element: HTMLElement, top: number, height = 10): void {
  element.getBoundingClientRect = () =>
    ({
      top,
      bottom: top + height,
      height,
      left: 0,
      right: 0,
      width: 0,
      x: 0,
      y: top,
      toJSON: () => ({}),
    }) as DOMRect;
}

/**
 * 带真实几何的 harness：正文里放若干 `data-user-msg-id` 节点并 stub 它们的位置，
 * 这样才能验证「视口内所有 turn 都 active」的区间相交判定。
 */
function GeometryHarness({
  entries,
  renderedEntryIndexes,
  onSelect = () => undefined,
  containerRef,
}: {
  entries: readonly ConversationOutlineEntry[];
  renderedEntryIndexes?: readonly number[];
  onSelect?: (entry: ConversationOutlineEntry) => void | Promise<void>;
  containerRef: { current: HTMLDivElement | null };
}) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const renderedEntries = renderedEntryIndexes
    ? renderedEntryIndexes.map((index) => entries[index])
    : entries;
  return (
    <div>
      <div
        ref={(node) => {
          scrollContainerRef.current = node;
          containerRef.current = node;
        }}
      >
        <div>
          {renderedEntries.map((entry) => (
            <div key={entry.messageId} data-user-msg-id={entry.clientId} />
          ))}
        </div>
      </div>
      <ConversationOutlineRail
        entries={entries}
        scrollContainerRef={scrollContainerRef}
        onSelect={onSelect}
      />
    </div>
  );
}

function renderWithGeometry(
  entries: readonly ConversationOutlineEntry[],
  tops: readonly number[],
  onSelect?: (entry: ConversationOutlineEntry) => void | Promise<void>,
  renderedEntryIndexes?: readonly number[],
): { container: { current: HTMLDivElement | null } } {
  // 不要把 rAF mock 成同步执行:组件的去重守卫是「frameRef 非 null 就跳过」,
  // 而回调里先把它清空、外层再把返回的 id 赋回去,同步执行会让守卫永久为真、
  // 后续 measure 全部被跳过。这里改走组件自带的 setTimeout 兜底路径,配假定时器。
  vi.useFakeTimers();
  vi.stubGlobal('requestAnimationFrame', undefined);
  const containerRef: { current: HTMLDivElement | null } = { current: null };
  render(
    <GeometryHarness
      entries={entries}
      renderedEntryIndexes={renderedEntryIndexes}
      onSelect={onSelect}
      containerRef={containerRef}
    />,
  );
  const root = containerRef.current;
  if (!root) throw new Error('scroll container missing');
  stubRect(root, 0);
  Object.defineProperty(root, 'clientHeight', { value: 100, configurable: true });
  const nodes = root.querySelectorAll<HTMLElement>('[data-user-msg-id]');
  nodes.forEach((node, index) => stubRect(node, tops[index] ?? 10_000));
  // 位置就绪后重新触发一次 measure。
  act(() => {
    fireEvent.scroll(root);
    vi.advanceTimersByTime(1);
  });
  return { container: containerRef };
}

function activeMessageIds(): string[] {
  return screen
    .getAllByRole('button')
    .filter((button) => button.getAttribute('data-active') === 'true')
    .map((button) => button.getAttribute('data-conversation-outline-id') ?? '');
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('ConversationOutlineRail', () => {
  it('does not render before the four-turn threshold', () => {
    render(<RailHarness entries={makeEntries(3)} />);

    expect(screen.queryByTestId('conversation-outline-rail')).toBeNull();
  });

  it('renders one marker per turn at the threshold', () => {
    render(<RailHarness entries={makeEntries(4)} />);

    const rail = screen.getByTestId('conversation-outline-rail');
    const buttons = within(rail).getAllByRole('button');
    expect(buttons).toHaveLength(4);
    expect(buttons.at(-1)?.getAttribute('aria-current')).toBe('location');
  });

  it('does not render when the parent layout disables it', () => {
    render(<RailHarness entries={makeEntries(8)} show={false} />);

    expect(screen.queryByTestId('conversation-outline-rail')).toBeNull();
  });

  it('selects the clicked turn', () => {
    const entries = makeEntries(8);
    const onSelect = vi.fn();
    render(<RailHarness entries={entries} onSelect={onSelect} />);

    const buttons = screen.getAllByRole('button');
    fireEvent.click(buttons[2]);

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(entries[2]);
    expect(buttons[2].getAttribute('aria-current')).toBe('location');
  });

  it('有回复预览时 tooltip 显示两段，没有时只显示提问', () => {
    const entries = makeEntries(8);
    entries[0] = { ...entries[0], replyPreview: '连线绝对定位在滚动容器上' };
    render(<RailHarness entries={entries} />);

    const tips = screen.getAllByTestId('tip-content');
    expect(tips[0].textContent).toBe('Turn 1连线绝对定位在滚动容器上');
    expect(tips[1].textContent).toBe('Turn 2');
  });

  it('aria-label 只带一小段提问，不复述回复预览', () => {
    const entries = makeEntries(8);
    entries[0] = {
      ...entries[0],
      preview: `提问${'很长'.repeat(60)}`,
      replyPreview: '这是回复预览不应进入可访问名',
    };
    render(<RailHarness entries={entries} />);

    const label = screen.getAllByRole('button')[0].getAttribute('aria-label') ?? '';
    // 可访问名的职责是标识跳转目标；回复留给视觉 tooltip，读屏不必听两段。
    expect(label).not.toContain('这是回复预览不应进入可访问名');
    // 插值出来的提问段被截断到 48 字（含省略号），不是原始的 120+ 字。
    const interpolated = label.split(':').at(-1) ?? '';
    expect(interpolated).toHaveLength(48);
    expect(interpolated.endsWith('…')).toBe(true);
  });

  it('把视口内出现的每个 turn 都标为 active，而不是只亮一个', () => {
    const entries = makeLocatableEntries(8);
    // 视口是 [0, 100]。turn1 占 [10,60)、turn2 占 [60,400)，两者都露在这一屏里；
    // turn3 起始于 400，整段在视口之下。
    renderWithGeometry(entries, [10, 60, 400, 460, 520, 580, 640, 700]);

    expect(activeMessageIds()).toEqual(['message-1', 'message-2']);
    // aria-current 只给最靠上的一项，避免一组里出现多个 current。
    const currents = screen
      .getAllByRole('button')
      .filter((button) => button.getAttribute('aria-current') === 'location');
    expect(currents).toHaveLength(1);
    expect(currents[0].getAttribute('data-conversation-outline-id')).toBe('message-1');
  });

  it('渲染窗口中间有缺口时，不把较早的 turn 区间延伸到当前视口', () => {
    const entries = makeLocatableEntries(8);
    // DOM 只有会话头尾两段，中间四轮尚未渲染。视口是 [0, 100]，只有尾部两轮
    // 在屏内；message-2 不能借 message-7 的顶边跨过缺口继续保持 active。
    renderWithGeometry(entries, [-500, -450, 10, 60], undefined, [0, 1, 6, 7]);

    expect(activeMessageIds()).toEqual(['message-7', 'message-8']);
  });

  it('点击跳转期间只亮被点那一项，滚动落定后才交还几何判定', () => {
    const entries = makeLocatableEntries(8);
    const { container } = renderWithGeometry(entries, [10, 60, 400, 460, 520, 580, 640, 700]);
    expect(activeMessageIds()).toEqual(['message-1', 'message-2']);

    act(() => {
      fireEvent.click(screen.getAllByRole('button')[5]);
    });
    // 跳转中：中间掠过的 turn 不参与，只有目标是 active。
    expect(activeMessageIds()).toEqual(['message-6']);

    const root = container.current;
    if (!root) throw new Error('scroll container missing');
    act(() => {
      fireEvent.scroll(root);
      vi.advanceTimersByTime(100);
    });
    // 平滑滚动仍在进行（距上一次 scroll 不足 180ms）时保持钉住。
    expect(activeMessageIds()).toEqual(['message-6']);

    act(() => {
      vi.advanceTimersByTime(200);
    });
    // 连续 180ms 无 scroll = 落定，恢复成视口内全部 turn。
    expect(activeMessageIds()).toEqual(['message-1', 'message-2']);
  });

  it('远程定位超过两秒时继续钉住，定位完成后才启动绝对超时', async () => {
    const entries = makeLocatableEntries(8);
    let resolveSelection: (() => void) | undefined;
    const selection = new Promise<void>((resolve) => {
      resolveSelection = resolve;
    });
    const onSelect = vi.fn(() => selection);
    const { container } = renderWithGeometry(
      entries,
      [10, 60, 400, 460, 520, 580, 640, 700],
      onSelect,
    );

    act(() => {
      fireEvent.click(screen.getAllByRole('button')[5]);
      const root = container.current;
      if (!root) throw new Error('scroll container missing');
      // 补齐历史可能触发窗口重建或锚点补偿；请求未完成时这不代表跳转已落定。
      fireEvent.scroll(root);
      vi.advanceTimersByTime(2_500);
    });
    // 请求仍在补历史，旧的 2 秒兜底不能提前把 active 交还给当前视口。
    expect(activeMessageIds()).toEqual(['message-6']);

    await act(async () => {
      resolveSelection?.();
      await selection;
    });
    act(() => {
      vi.advanceTimersByTime(1_999);
    });
    expect(activeMessageIds()).toEqual(['message-6']);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(activeMessageIds()).toEqual(['message-1', 'message-2']);
  });

  it('异步定位失败后立即解除钉住', async () => {
    const entries = makeLocatableEntries(8);
    let rejectSelection: ((reason?: unknown) => void) | undefined;
    const selection = new Promise<void>((_resolve, reject) => {
      rejectSelection = reject;
    });
    renderWithGeometry(entries, [10, 60, 400, 460, 520, 580, 640, 700], () => selection);

    act(() => {
      fireEvent.click(screen.getAllByRole('button')[5]);
    });
    expect(activeMessageIds()).toEqual(['message-6']);

    await act(async () => {
      rejectSelection?.(new Error('load failed'));
      await selection.catch(() => undefined);
    });
    expect(activeMessageIds()).toEqual(['message-1', 'message-2']);
  });

  it('键盘 Enter 触发的跳转同样保持钉住，不被 window 级 keydown 释放', () => {
    const entries = makeLocatableEntries(8);
    renderWithGeometry(entries, [10, 60, 400, 460, 520, 580, 640, 700]);
    expect(activeMessageIds()).toEqual(['message-1', 'message-2']);

    const button = screen.getAllByRole('button')[5];
    act(() => {
      button.focus();
      fireEvent.keyDown(button, { key: 'Enter' });
    });

    // 钉住释放条件里有 window keydown（"用户接管浏览"）。导轨自身的按键必须
    // 不算接管，否则键盘跳转会在钉住的同一瞬间被解除、active 一路闪过去。
    expect(activeMessageIds()).toEqual(['message-6']);
  });

  it('用户自己滚动时立刻放弃钉住，不等落定超时', () => {
    const entries = makeLocatableEntries(8);
    const { container } = renderWithGeometry(entries, [10, 60, 400, 460, 520, 580, 640, 700]);

    act(() => {
      fireEvent.click(screen.getAllByRole('button')[5]);
    });
    expect(activeMessageIds()).toEqual(['message-6']);

    const root = container.current;
    if (!root) throw new Error('scroll container missing');
    act(() => {
      fireEvent.wheel(root);
    });
    expect(activeMessageIds()).toEqual(['message-1', 'message-2']);
  });

  it('外部导航接管时立即释放仍在等待异步定位的 active', () => {
    const entries = makeEntries(8);
    const railRef = createRef<ConversationOutlineRailHandle>();
    const pendingSelection = new Promise<void>(() => undefined);
    render(<RailHarness entries={entries} onSelect={() => pendingSelection} railRef={railRef} />);

    act(() => {
      fireEvent.click(screen.getAllByRole('button')[2]);
    });
    expect(activeMessageIds()).toEqual(['message-3']);

    act(() => {
      railRef.current?.cancelSelection();
    });
    expect(activeMessageIds()).toEqual(['message-8']);
  });

  it('moves focus with ArrowUp and Home without bubbling into message history shortcuts', () => {
    const onParentKeyDown = vi.fn();
    render(<RailHarness entries={makeEntries(8)} onKeyDown={onParentKeyDown} />);

    const buttons = screen.getAllByRole('button');
    act(() => buttons[4].focus());

    fireEvent.keyDown(buttons[4], { key: 'ArrowUp' });
    expect(document.activeElement).toBe(buttons[3]);
    expect(onParentKeyDown).not.toHaveBeenCalled();

    fireEvent.keyDown(buttons[3], { key: 'Home' });
    expect(document.activeElement).toBe(buttons[0]);
    expect(onParentKeyDown).not.toHaveBeenCalled();
  });
});
