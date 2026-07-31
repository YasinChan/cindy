// @vitest-environment jsdom

import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChatMessage } from '@/lib/makerChatStore';

vi.mock('react-i18next', () => ({
  initReactI18next: {
    type: '3rdParty',
    init: () => undefined,
  },
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ debug: vi.fn() }),
}));

vi.mock('@/lib/mediaPlaybackBus', () => ({
  stopAllMedia: vi.fn(),
}));

vi.mock('@/lib/sessionScrollStore', () => ({
  readSessionScroll: () => undefined,
  saveSessionScroll: vi.fn(),
}));

vi.mock('@/lib/scrollbarAutoHide', () => ({
  suppressScrollbarActivation: vi.fn(),
}));

vi.mock('@/cindy-brain/ghostCardStore', () => {
  const snapshot = {
    version: 0,
    byCallId: new Map(),
    liveCards: [],
  };
  return {
    ensureCard: vi.fn(),
    ensureSessionCards: vi.fn(),
    getGhostCardSnapshot: () => snapshot,
    subscribeGhostCards: () => () => undefined,
  };
});

vi.mock('../ChatSessionFileContext', () => ({
  useChatSessionFileValue: (sessionId: string | undefined, workingDir: string) => ({
    sessionId,
    workingDir,
    origin: { kind: 'local' as const },
  }),
  ChatSessionFileProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock('../SelectionQuoteButton', () => ({
  SelectionQuoteButton: () => null,
}));

vi.mock('../UserMessage', () => ({
  UserMessage: ({ content, messageClientId }: { content: string; messageClientId: string }) => (
    <div data-testid={`user-${messageClientId}`}>{content}</div>
  ),
}));

vi.mock('../NewMessageIndicator', () => ({
  NewMessageIndicator: () => null,
}));

// 透出 visible 与点击入口，既能断言跳转后的显隐，也能覆盖“回到底部”取消旧导航。
vi.mock('../JumpToBottomChip', () => ({
  JumpToBottomChip: ({ visible, onClick }: { visible: boolean; onClick: () => void }) => (
    <button
      type="button"
      data-testid="jump-to-bottom-chip"
      data-visible={visible ? 'true' : 'false'}
      onClick={onClick}
    />
  ),
}));

vi.mock('../TopRightChipStack', () => ({
  useTopRightChipSlot: () => null,
}));

vi.mock('../usePrevUserMessageInView', () => ({
  usePrevUserMessageInView: () => ({
    displayId: null,
    suppressAfterClick: () => undefined,
  }),
}));

// 用真实实现:本文件有用例依赖「完整导航键集合都作废在飞的定位」这条行为，
// mock 成空实现会让那条断言永远通过（它测不到任何东西）。
// 只保留同一份 NAVIGATION_KEYS 作为单一信息源。
vi.mock('../useNavigationKeyListener', async () => {
  const actual =
    await vi.importActual<typeof import('../useNavigationKeyListener')>(
      '../useNavigationKeyListener',
    );
  return actual;
});

import { MessageStream } from '../MessageStream';

const originalClientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight');
const originalScrollHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight');
const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
let scrollIntoViewMock = vi.fn();
/** 收集 MessageStream 注册的 ResizeObserver 回调，供测试手动触发内容高度 settle。 */
let resizeObserverCallbacks: Array<() => void> = [];

function buildMessages(count: number): ChatMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    clientId: `user-${index}`,
    role: 'user',
    content: `Turn ${index}`,
  }));
}

beforeEach(() => {
  scrollIntoViewMock = vi.fn(function scrollIntoView(this: HTMLElement) {
    const root = this.closest<HTMLElement>('[data-scroll-container]');
    if (!root) return;
    root.scrollTop = 0;
    // 模拟长距离 smooth scroll 穿过顶部触发区。
    root.dispatchEvent(new Event('scroll'));
  });
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    writable: true,
    value: scrollIntoViewMock,
  });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get: () => 600,
  });
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
    configurable: true,
    get: () => 2_000,
  });
  vi.stubGlobal('CSS', { escape: (value: string) => value });
  resizeObserverCallbacks = [];
  vi.stubGlobal(
    'ResizeObserver',
    class ResizeObserverMock {
      constructor(callback: () => void) {
        resizeObserverCallbacks.push(callback);
      }
      observe() {}
      disconnect() {}
      unobserve() {}
    },
  );
  let nextFrameId = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(performance.now());
    nextFrameId += 1;
    return nextFrameId;
  });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  if (originalClientHeight) {
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', originalClientHeight);
  }
  if (originalScrollHeight) {
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', originalScrollHeight);
  }
  if (originalScrollIntoView) {
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      writable: true,
      value: originalScrollIntoView,
    });
  } else {
    delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
  }
});

describe('MessageStream outline focus', () => {
  it('expands to an off-window target without search highlight or loading older history', async () => {
    const onLoadMore = vi.fn();
    const onFocusNavigationCancel = vi.fn();
    const { container } = render(
      <MessageStream
        sessionId="session-outline-focus"
        workingDir="/tmp/project"
        messages={buildMessages(120)}
        focusMessageClientId="user-0"
        focusMessageRequestId={1}
        focusMessageSource="outline"
        hasMoreMessages
        isLoadingMore={false}
        onLoadMore={onLoadMore}
        onFocusNavigationCancel={onFocusNavigationCancel}
      />,
    );

    const target = await waitFor(() => {
      const element = container.querySelector<HTMLElement>('[data-message-client-id="user-0"]');
      expect(element).not.toBeNull();
      return element as HTMLElement;
    });

    // user-0 不在首屏 30-item render window；出现即证明目录请求已把窗口移到目标。
    //
    // 这里刻意不断言挂载量上限：锚定窗口的上界属于上游 MessageStream 里
    // TODO(render-window-bidirectional) 那条已认领的独立改动，目录不自带。当前
    // 挂载体量由 store 侧的跳转补齐预算（JUMP_BACKFILL_MAX_ITEMS）间接封住，
    // 窗口本身仍是「锚点 → 最新」的连续区间，所以最新一条必须在 DOM 里。
    expect(container.querySelector('[data-message-client-id="user-119"]')).not.toBeNull();
    expect(scrollIntoViewMock).toHaveBeenCalledWith({
      behavior: 'smooth',
      block: 'center',
    });
    expect(target.className).not.toContain('search-match-bg');

    const scrollRoot = container.querySelector<HTMLElement>('[data-scroll-container]');
    expect(scrollRoot).not.toBeNull();
    fireEvent(scrollRoot as HTMLElement, new Event('scrollend'));

    expect(target.className).not.toContain('search-match-bg');
    expect(onLoadMore).not.toHaveBeenCalled();
    // 目录自身的 programmatic scroll 不能反过来取消当前导航。
    expect(onFocusNavigationCancel).not.toHaveBeenCalled();
  });

  it('目录跳转后立刻给出回到底部的入口，不必先手动滚一次', async () => {
    const { container } = render(
      <MessageStream
        sessionId="session-outline-chip"
        workingDir="/tmp/project"
        messages={buildMessages(120)}
        focusMessageClientId="user-0"
        focusMessageRequestId={1}
        focusMessageSource="outline"
        hasMoreMessages
        isLoadingMore={false}
        onLoadMore={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(container.querySelector('[data-message-client-id="user-0"]')).not.toBeNull();
    });

    // 跳转全程是 programmatic 滚动，handleScroll 里更新 chip 的分支不会执行；
    // 若跳转路径自己不点亮，用户跳完就没有返回最新消息的入口。
    const chip = container.querySelector<HTMLElement>('[data-testid="jump-to-bottom-chip"]');
    expect(chip?.getAttribute('data-visible')).toBe('true');
  });

  it('点击回到底部时取消尚未完成的父级定位', async () => {
    const onFocusNavigationCancel = vi.fn();
    const { container } = render(
      <MessageStream
        sessionId="session-outline-cancel-on-bottom"
        workingDir="/tmp/project"
        messages={buildMessages(120)}
        focusMessageClientId="user-0"
        focusMessageRequestId={1}
        focusMessageSource="outline"
        hasMoreMessages
        isLoadingMore={false}
        onLoadMore={vi.fn()}
        onFocusNavigationCancel={onFocusNavigationCancel}
      />,
    );

    const chip = await waitFor(() => {
      const element = container.querySelector<HTMLButtonElement>(
        '[data-testid="jump-to-bottom-chip"]',
      );
      expect(element?.getAttribute('data-visible')).toBe('true');
      return element as HTMLButtonElement;
    });
    expect(onFocusNavigationCancel).not.toHaveBeenCalled();
    const scrollRoot = container.querySelector<HTMLElement>('[data-scroll-container]');
    expect(scrollRoot).not.toBeNull();
    (scrollRoot as HTMLElement).scrollTo = vi.fn();

    fireEvent.click(chip);

    expect(onFocusNavigationCancel).toHaveBeenCalledTimes(1);
  });

  /**
   * 取消定位只认**输入意图**，不认裸 scroll 事件。
   *
   * 裸 scroll 分不清「用户拖滚动条」和「布局变化引起的滚动」——跳转时的历史补齐会往
   * 顶部 prepend 几百行，浏览器 scroll anchoring 随即调整 scrollTop，于是定位会被它
   * 自己触发的加载取消掉，表现为「点了没反应，要再点一次」。代价是纯拖滚动条不再
   * 取消在飞的定位，远小于跳转静默失败。
   */
  it('输入意图取消父级定位，布局性 scroll 事件不取消', () => {
    const onFocusNavigationCancel = vi.fn();
    const { container } = render(
      <MessageStream
        sessionId="session-outline-cancel-on-scroll"
        workingDir="/tmp/project"
        messages={buildMessages(10)}
        onFocusNavigationCancel={onFocusNavigationCancel}
      />,
    );
    const scrollRoot = container.querySelector<HTMLElement>('[data-scroll-container]');
    expect(scrollRoot).not.toBeNull();

    // 已经停在顶部时继续 wheel 不会产生 scroll 事件，必须由输入意图监听直接取消。
    (scrollRoot as HTMLElement).scrollTop = 0;
    fireEvent.wheel(scrollRoot as HTMLElement, { deltaY: -20 });
    expect(onFocusNavigationCancel).toHaveBeenCalledTimes(1);

    // 触摸开始同样是输入意图。
    fireEvent.touchStart(scrollRoot as HTMLElement, { touches: [{ clientY: 10 }] });
    expect(onFocusNavigationCancel).toHaveBeenCalledTimes(2);

    // 裸 scroll 事件（补齐 prepend + scroll anchoring 会产生它）不得取消。
    (scrollRoot as HTMLElement).scrollTop = 400;
    fireEvent.scroll(scrollRoot as HTMLElement);
    expect(onFocusNavigationCancel).toHaveBeenCalledTimes(2);
  });

  /**
   * 回归：**完整**导航键集合都算接管，不只是向上的那三个。
   *
   * 原先只有 HISTORY_NAVIGATION_KEYS（PageUp / ArrowUp / Home）作废在飞的定位，
   * 而跳转抑制解除走的是 NAVIGATION_KEYS（多了 PageDown / ArrowDown / End）。
   * 同一个按键在两套机制里一个算接管一个不算，于是用户按向下键接管时代数没递增，
   * 慢速远程 around 返回后仍会把视口拽回旧目标（Codex review）。
   *
   * 另一半：焦点在输入框里时按方向键只是移动光标，不该作废跳转。
   */
  it('向下的导航键同样取消定位，输入框内的方向键不取消', () => {
    const onFocusNavigationCancel = vi.fn();
    const { container } = render(
      <MessageStream
        sessionId="session-outline-navkeys"
        workingDir="/tmp/project"
        messages={buildMessages(10)}
        onFocusNavigationCancel={onFocusNavigationCancel}
      />,
    );

    let expected = 0;
    for (const key of ['PageDown', 'ArrowDown', 'End', 'PageUp', 'ArrowUp', 'Home']) {
      fireEvent.keyDown(window, { key });
      expected += 1;
      expect(onFocusNavigationCancel).toHaveBeenCalledTimes(expected);
    }

    // 非导航键不算。
    fireEvent.keyDown(window, { key: 'a' });
    expect(onFocusNavigationCancel).toHaveBeenCalledTimes(expected);

    // 焦点在可编辑目标里：方向键只是移动光标，不作废跳转。
    const input = document.createElement('input');
    container.appendChild(input);
    input.focus();
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(onFocusNavigationCancel).toHaveBeenCalledTimes(expected);
  });
  /**
   * 回归：目录跳转期间 auto-follow 不得把视口钉回底部。
   *
   * 实机 bug（2026-07-29 日志实证）：点击很早的 turn → 补齐往顶部塞了 195 条 → 内容高度
   * 12608→40236 → `scrollIntoView({smooth})` 起步 35ms 后，ResizeObserver 因异步 settle
   * 调 `pinToBottom()`（`el.scrollTop = el.scrollHeight`，硬赋值）把视口一把拽到底，
   * 三次采样 scrollTop 全程没动过，表现为「第一次点没反应，要再点一次」。
   * 焦点 effect 此时已标记 lastAppliedFocusRef，不会再纠正回来。
   *
   * 闸门是 chipJumpInProgressRef（跳转时由 beginChipJumpSuppression 开启，
   * CHIP_JUMP_SAFETY_MS 兜底关闭，用户一动手立即解除）。
   */
  it('跳转期间 ResizeObserver 的高度 settle 不把视口钉回底部', async () => {
    const messages = buildMessages(120);
    const { container, rerender } = render(
      <MessageStream
        sessionId="session-outline-nopin"
        workingDir="/tmp/project"
        messages={messages}
        focusMessageClientId="user-0"
        focusMessageRequestId={1}
        focusMessageSource="outline"
        hasMoreMessages
        isLoadingMore={false}
        onLoadMore={vi.fn()}
      />,
    );
    // 等跳转真正落地（scrollIntoView 被调用即说明抑制窗口已开启）。
    await waitFor(() => expect(scrollIntoViewMock).toHaveBeenCalled());
    const scrollRoot = container.querySelector<HTMLElement>('[data-scroll-container]');
    expect(scrollRoot).not.toBeNull();
    expect(resizeObserverCallbacks.length).toBeGreaterThan(0);

    // 用户发了新消息 → isNewUserSend 分支刻意不受抑制（发送是明确要看底部的意图），
    // 它会把 auto-follow 重新武装成 true。这一步正是实机 bug 的前置条件。
    rerender(
      <MessageStream
        sessionId="session-outline-nopin"
        workingDir="/tmp/project"
        messages={[...messages, { clientId: 'user-new', role: 'user', content: 'new send' }]}
        focusMessageClientId="user-0"
        focusMessageRequestId={1}
        focusMessageSource="outline"
        hasMoreMessages
        isLoadingMore={false}
        onLoadMore={vi.fn()}
      />,
    );

    // 模拟平滑滚动进行中的中间位置，再触发一次异步高度 settle。
    (scrollRoot as HTMLElement).scrollTop = 500;
    for (const callback of resizeObserverCallbacks) callback();

    // 修复前这里会被 pinToBottom 改成 scrollHeight(2000)。
    expect((scrollRoot as HTMLElement).scrollTop).toBe(500);
  });
});
