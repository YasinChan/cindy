import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DL_HISTORY_MESSAGES_CHANNEL } from '@cindy/device-link';

const handlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    }),
  },
}));

// 真实断言会读构建期注入的 renderer 地址全局，单测里不可用；这里只关心
// handler 有没有按来源调用它（专项覆盖见 conversationOutlineHistory.test.ts）。
const assertTrustedAppRendererEvent = vi.fn();
vi.mock('../../../security/trustedAppRenderer', () => ({
  assertTrustedAppRendererEvent: (event: unknown) => assertTrustedAppRendererEvent(event),
}));

import { registerRemoteHistoryIpc, type RemoteHistoryIpcDeps } from '../history';

/** Tests default to "no terminal tail"; individual cases override readTerminal. */
function register(
  deps: Omit<RemoteHistoryIpcDeps, 'readTerminal'> & Partial<Pick<RemoteHistoryIpcDeps, 'readTerminal'>>,
): void {
  registerRemoteHistoryIpc({ readTerminal: async () => undefined, ...deps });
}

const request = {
  sessionId: 'session-1',
  workdir: 'D:\\repo',
  fromMs: 100,
  toMs: 900,
  agentKind: 'codex' as const,
  roles: ['user', 'assistant'] as const,
  includeRewound: true,
  limit: 25,
  cursor: { createdAt: 700, id: 'message-7' },
  order: 'asc' as const,
};

/**
 * turn-index 专用请求：把 request fixture 里那几个**本投影不消费**的筛选参数
 * 归零（agentKind / workdir / includeRewound / roles）。handler 现在会拒掉它们，
 * 而不是像以前那样静默忽略——这也正是这些字段必须显式写出来的原因。
 */
const turnIndexRequest = {
  ...request,
  projection: 'turn-index' as const,
  order: 'asc' as const,
  agentKind: null,
  workdir: null,
  includeRewound: false,
  roles: ['user'] as const,
};

describe('local-db:history:messages', () => {
  beforeEach(() => {
    handlers.clear();
    vi.clearAllMocks();
  });

  it('validates and forwards the complete single-session history contract', async () => {
    const getMessages = vi.fn(async () => ({
      items: [],
      nextCursor: { createdAt: 800, id: 'message-8' },
      hasMore: true,
    }));
    register({
      sessionExists: vi.fn(async () => true),
      getMessages,
    });

    const handler = handlers.get(DL_HISTORY_MESSAGES_CHANNEL);
    const page = await handler?.({}, request);

    expect(page).toMatchObject({ hasMore: true });
    expect(getMessages).toHaveBeenCalledWith({
      sessionIds: ['session-1'],
      workdir: 'D:\\repo',
      fromMs: 100,
      toMs: 900,
      agentKind: 'codex',
      roles: ['user', 'assistant'],
      includeRewound: true,
      limit: 25,
      cursor: { createdAt: 700, id: 'message-7' },
      order: 'asc',
    });
  });

  it('distinguishes an existing empty session from a missing session', async () => {
    const getMessages = vi.fn();
    register({
      sessionExists: vi.fn(async () => false),
      getMessages,
    });

    const handler = handlers.get(DL_HISTORY_MESSAGES_CHANNEL);
    await expect(handler?.({}, request)).rejects.toThrow('[NOT_FOUND]');
    expect(getMessages).not.toHaveBeenCalled();
  });

  it('rejects malformed cursors and out-of-range limits before reading', async () => {
    const getMessages = vi.fn();
    register({
      sessionExists: vi.fn(async () => true),
      getMessages,
    });

    const handler = handlers.get(DL_HISTORY_MESSAGES_CHANNEL);
    await expect(handler?.({}, { ...request, limit: 1001 })).rejects.toThrow('[INVALID_PARAMS]');
    await expect(handler?.({}, {
      ...request,
      cursor: { createdAt: 'bad', id: 'message-7' },
    })).rejects.toThrow('[INVALID_PARAMS]');
    await expect(handler?.({}, {
      ...request,
      cursor: { createdAt: 700, id: 'message-7', rowid: 0 },
    })).rejects.toThrow('[INVALID_PARAMS]');
    expect(getMessages).not.toHaveBeenCalled();
  });

  it('caps source content only when a session-reference caller requests it', async () => {
    register({
      sessionExists: vi.fn(async () => true),
      getMessages: vi.fn(async () => ({
        items: [{
          id: 'm-1',
          sessionId: 'session-1',
          sessionWorkingDir: null,
          sessionAgentKind: 'cc',
          sessionTitle: 'Session',
          role: 'assistant',
          content: '0123456789',
          toolUseId: null,
          agentMeta: null,
          createdAt: 500,
          rewindAt: null,
        }],
        nextCursor: null,
        hasMore: false,
      })),
    });
    const handler = handlers.get(DL_HISTORY_MESSAGES_CHANNEL);
    const page = await handler?.({}, { ...request, contentCharLimit: 5 }) as {
      items: Array<{ content: string; agentMeta: Record<string, unknown> }>;
    };
    expect(page.items[0]).toMatchObject({
      content: '…6789',
      agentMeta: { remoteContentTruncated: true },
    });
  });

  it('strips structured content envelopes before relaying capped rows', async () => {
    register({
      sessionExists: vi.fn(async () => true),
      getMessages: vi.fn(async () => ({
        items: [{
          id: 'm-structured',
          sessionId: 'session-1',
          sessionWorkingDir: null,
          sessionAgentKind: 'cc',
          sessionTitle: 'Session',
          role: 'user',
          content: { text: 'short text', images: [{ base64: 'secret attachment' }] },
          toolUseId: null,
          agentMeta: { existing: true },
          createdAt: 500,
          rewindAt: null,
        }],
        nextCursor: null,
        hasMore: false,
      })),
    });
    const handler = handlers.get(DL_HISTORY_MESSAGES_CHANNEL);
    const page = await handler?.({}, { ...request, contentCharLimit: 100 }) as {
      items: Array<{ content: unknown; agentMeta: Record<string, unknown> }>;
    };
    expect(page.items[0]).toMatchObject({
      content: 'short text',
      agentMeta: { existing: true, remoteContentTruncated: true },
    });
  });

  it('does not mark plain persisted text envelopes as truncated', async () => {
    register({
      sessionExists: vi.fn(async () => true),
      getMessages: vi.fn(async () => ({
        items: [{
          id: 'm-plain-envelope',
          sessionId: 'session-1',
          sessionWorkingDir: null,
          sessionAgentKind: 'cc',
          sessionTitle: 'Session',
          role: 'user',
          content: { text: 'short text', images: [], files: [] },
          toolUseId: null,
          agentMeta: { existing: true },
          createdAt: 500,
          rewindAt: null,
        }],
        nextCursor: null,
        hasMore: false,
      })),
    });
    const handler = handlers.get(DL_HISTORY_MESSAGES_CHANNEL);
    const page = await handler?.({}, { ...request, contentCharLimit: 100 }) as {
      items: Array<{ content: unknown; agentMeta: Record<string, unknown> }>;
    };
    expect(page.items[0]).toMatchObject({
      content: 'short text',
      agentMeta: { existing: true },
    });
    expect(page.items[0].agentMeta.remoteContentTruncated).toBeUndefined();
  });

  it('caps plain rows while preserving structured rows in mixed-role reads', async () => {
    register({
      sessionExists: vi.fn(async () => true),
      getMessages: vi.fn(async () => ({
        items: [{
          id: 'm-plain',
          sessionId: 'session-1',
          sessionWorkingDir: null,
          sessionAgentKind: 'cc',
          sessionTitle: 'Session',
          role: 'user',
          content: '0123456789',
          toolUseId: null,
          agentMeta: null,
          createdAt: 500,
          rewindAt: null,
        }, {
          id: 'm-structured',
          sessionId: 'session-1',
          sessionWorkingDir: null,
          sessionAgentKind: 'cc',
          sessionTitle: 'Session',
          role: 'ask_user',
          content: { type: 'ask_user', question: 'Choose one' },
          toolUseId: null,
          agentMeta: null,
          createdAt: 501,
          rewindAt: null,
        }],
        nextCursor: null,
        hasMore: false,
      })),
    });
    const handler = handlers.get(DL_HISTORY_MESSAGES_CHANNEL);
    const page = await handler?.({}, {
      ...request,
      roles: ['user', 'ask_user'],
      contentCharLimit: 5,
    }) as { items: Array<{ role: string; content: unknown; agentMeta?: Record<string, unknown> }> };

    expect(page.items[0]).toMatchObject({
      role: 'user',
      content: '…6789',
      agentMeta: { remoteContentTruncated: true },
    });
    expect(page.items[1]).toMatchObject({
      role: 'ask_user',
      content: { type: 'ask_user', question: 'Choose one' },
    });
    expect(page.items[1]?.agentMeta?.remoteContentTruncated).toBeUndefined();
  });

  it('marks omitted reference metadata as truncated after flattening an envelope', async () => {
    register({
      sessionExists: vi.fn(async () => true),
      getMessages: vi.fn(async () => ({
        items: [{
          id: 'm-reference-envelope',
          sessionId: 'session-1',
          sessionWorkingDir: null,
          sessionAgentKind: 'cc',
          sessionTitle: 'Session',
          role: 'user',
          content: {
            text: 'short text',
            images: [],
            files: [],
            sessionReferences: [{ sessionId: 'referenced-session' }],
            pastedTextRanges: [],
            slashCommandRanges: [],
          },
          toolUseId: null,
          agentMeta: null,
          createdAt: 500,
          rewindAt: null,
        }],
        nextCursor: null,
        hasMore: false,
      })),
    });
    const handler = handlers.get(DL_HISTORY_MESSAGES_CHANNEL);
    const page = await handler?.({}, { ...request, contentCharLimit: 100 }) as {
      items: Array<{ agentMeta: Record<string, unknown> }>;
    };

    expect(page.items[0]?.agentMeta).toMatchObject({ remoteContentTruncated: true });
  });

  it('drops non-text blocks when compacting structured history arrays', async () => {
    register({
      sessionExists: vi.fn(async () => true),
      getMessages: vi.fn(async () => ({
        items: [{
          id: 'm-array',
          sessionId: 'session-1',
          sessionWorkingDir: null,
          sessionAgentKind: 'cc',
          sessionTitle: 'Session',
          role: 'user',
          content: [
            { type: 'text', text: 'visible text' },
            { type: 'image', source: { data: 'secret attachment' } },
          ],
          toolUseId: null,
          agentMeta: null,
          createdAt: 500,
          rewindAt: null,
        }],
        nextCursor: null,
        hasMore: false,
      })),
    });
    const handler = handlers.get(DL_HISTORY_MESSAGES_CHANNEL);
    const page = await handler?.({}, { ...request, contentCharLimit: 100 }) as {
      items: Array<{ content: unknown; agentMeta: Record<string, unknown> }>;
    };
    expect(page.items[0]).toMatchObject({
      content: 'visible text',
      agentMeta: { remoteContentTruncated: true },
    });
    expect(JSON.stringify(page.items[0])).not.toContain('secret attachment');
  });

  it('forwards a stable rowid history cursor', async () => {
    const getMessages = vi.fn(async () => ({ items: [], nextCursor: null, hasMore: false }));
    register({
      sessionExists: vi.fn(async () => true),
      getMessages,
    });
    const handler = handlers.get(DL_HISTORY_MESSAGES_CHANNEL);
    await handler?.({}, {
      ...request,
      cursor: { createdAt: 700, id: 'message-7', rowid: 42 },
    });
    expect(getMessages).toHaveBeenCalledWith(expect.objectContaining({
      cursor: { createdAt: 700, id: 'message-7', rowid: 42 },
    }));
  });

  it('routes the additive turn-index projection without changing regular history reads', async () => {
    const getMessages = vi.fn();
    const getTurnIndex = vi.fn(async () => ({
      items: [{
        messageId: 'message-1',
        clientId: 'client-1',
        rowid: 7,
        createdAt: 500,
        preview: '用户问题',
      }],
      nextCursor: null,
      hasMore: false,
    }));
    register({
      sessionExists: vi.fn(async () => true),
      getMessages,
      getTurnIndex,
    });

    const handler = handlers.get(DL_HISTORY_MESSAGES_CHANNEL);
    const page = await handler?.({}, turnIndexRequest);

    expect(page).toMatchObject({
      items: [{ messageId: 'message-1', preview: '用户问题' }],
      hasMore: false,
    });
    expect(getTurnIndex).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-1',
      projection: 'turn-index',
    }));
    expect(getMessages).not.toHaveBeenCalled();
  });

  it('rejects a desc turn-index request instead of mis-grouping reply previews', async () => {
    const sessionExists = vi.fn(async () => true);
    const getTurnIndex = vi.fn();
    const getMessages = vi.fn(async () => ({ items: [], nextCursor: null, hasMore: false }));
    register({ sessionExists, getMessages, getTurnIndex });

    const handler = handlers.get(DL_HISTORY_MESSAGES_CHANNEL);
    // 回复预览的分组是升序双指针；desc 下范围起点会变成最新一轮，靠后的 turn
    // 会配到别的 turn 的回复。
    await expect(
      handler?.({}, { ...turnIndexRequest, order: 'desc' }),
    ).rejects.toThrow('[INVALID_PARAMS]');
    expect(sessionExists).not.toHaveBeenCalled();
    expect(getTurnIndex).not.toHaveBeenCalled();

    // 常规 history 投影不受影响,仍然支持 desc(MCP / session-reference 在用)。
    await expect(handler?.({}, { ...request, order: 'desc' })).resolves.toBeDefined();
    expect(getMessages).toHaveBeenCalledWith(expect.objectContaining({ order: 'desc' }));
  });

  /**
   * turn-index 把「只要未 rewind 的 user 行」写死在 SQL 里，不消费这几个从常规 history
   * 契约继承来的筛选参数。静默忽略会让调用方以为筛选生效了、拿到未筛选结果还不知道，
   * 所以传了就拒。contentCharLimit 不在此列——它对旧被控端的降级投影仍然有意义。
   */
  it('rejects turn-index filters it cannot honor instead of ignoring them', async () => {
    const sessionExists = vi.fn(async () => true);
    const getTurnIndex = vi.fn(async () => ({ items: [], nextCursor: null, hasMore: false }));
    register({ sessionExists, getMessages: vi.fn(), getTurnIndex });
    const handler = handlers.get(DL_HISTORY_MESSAGES_CHANNEL);
    const turnIndex = turnIndexRequest;

    for (const override of [
      { agentKind: 'codex' },
      { workdir: 'D:\\repo' },
      { includeRewound: true },
      { roles: ['assistant'] },
      { roles: ['user', 'assistant'] },
    ]) {
      await expect(handler?.({}, { ...turnIndex, ...override })).rejects.toThrow('[INVALID_PARAMS]');
    }
    expect(sessionExists).not.toHaveBeenCalled();
    expect(getTurnIndex).not.toHaveBeenCalled();

    // 合法组合：roles 允许 ['user'] 与 null(不筛选,与本投影语义等价)；
    // contentCharLimit 照常放行。
    for (const override of [{ roles: ['user'] }, { roles: null }, { contentCharLimit: 512 }]) {
      await expect(handler?.({}, { ...turnIndex, ...override })).resolves.toBeDefined();
    }
    expect(getTurnIndex).toHaveBeenCalledTimes(3);
  });

  it('rejects an unknown projection before touching the database', async () => {
    const sessionExists = vi.fn();
    const getMessages = vi.fn();
    register({ sessionExists, getMessages });

    const handler = handlers.get(DL_HISTORY_MESSAGES_CHANNEL);
    await expect(handler?.({}, {
      ...request,
      projection: 'full-dump',
    })).rejects.toThrow('[INVALID_PARAMS]');
    expect(sessionExists).not.toHaveBeenCalled();
    expect(getMessages).not.toHaveBeenCalled();
  });

  it('attaches the safe terminal marker computed in the same handler call', async () => {
    const readTerminal = vi.fn(async () => ({ status: 'error' as const, createdAt: 500 }));
    register({
      sessionExists: vi.fn(async () => true),
      getMessages: vi.fn(async () => ({ items: [], nextCursor: null, hasMore: false })),
      readTerminal,
    });

    const handler = handlers.get(DL_HISTORY_MESSAGES_CHANNEL);
    const page = await handler?.({}, { ...request, fromMs: 100 }) as { terminal: unknown };

    // 页面下界是 gte(fromMs),终态探针是 gt(clearedAt)——同一窗口需 fromMs-1。
    expect(readTerminal).toHaveBeenCalledWith('session-1', 99);
    expect(page.terminal).toEqual({ status: 'error', createdAt: 500 });
  });

  it('normalizes a missing terminal to null and a missing fromMs to a null bound', async () => {
    const readTerminal = vi.fn(async () => undefined);
    register({
      sessionExists: vi.fn(async () => true),
      getMessages: vi.fn(async () => ({ items: [], nextCursor: null, hasMore: false })),
      readTerminal,
    });

    const handler = handlers.get(DL_HISTORY_MESSAGES_CHANNEL);
    const page = await handler?.({}, { ...request, fromMs: null }) as { terminal: unknown };

    expect(readTerminal).toHaveBeenCalledWith('session-1', null);
    expect(page.terminal).toBeNull();
  });
});
