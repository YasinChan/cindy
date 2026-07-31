// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChatMessage } from '@/lib/makerChatStore';
import type { ConversationOutlineEntry } from '../../../../shared/conversationOutline';

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ debug: vi.fn() }),
}));

vi.mock('@/lib/makerTransport', () => ({
  listConversationOutlineFor: vi.fn(),
  listConversationOutlinePageFor: vi.fn(),
}));

import {
  mergeConversationOutlineEntries,
  optimisticConversationOutlineFromMessages,
  classifyOutlineStructureChange,
  useConversationOutline,
} from '../useConversationOutline';
import { listConversationOutlinePageFor } from '@/lib/makerTransport';

const loadOutlinePage = vi.mocked(listConversationOutlinePageFor);

beforeEach(() => {
  loadOutlinePage.mockReset();
});

function makeMessage(clientId: string, overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    clientId,
    role: 'user',
    content: `Message ${clientId}`,
    createdAt: '2026-07-27T08:00:00.000Z',
    ...overrides,
  };
}

describe('optimisticConversationOutlineFromMessages', () => {
  it('keeps only real user turns', () => {
    const entries = optimisticConversationOutlineFromMessages([
      makeMessage('visible'),
      makeMessage('synthetic', { isSyntheticTrigger: true }),
      makeMessage('steer', { delivery: 'steer' }),
      makeMessage('system-card', { systemCardType: 'help' }),
      makeMessage('blocked', {
        blockedByGhost: {
          ghostId: 'ghost-1',
          ghostName: 'Reviewer',
          reason: 'blocked',
        },
      }),
      makeMessage('assistant', { role: 'assistant' }),
    ]);

    expect(entries).toEqual([
      {
        messageId: 'client:visible',
        clientId: 'visible',
        createdAt: Date.parse('2026-07-27T08:00:00.000Z'),
        preview: 'Message visible',
      },
    ]);
  });

  it('只在 turn 收尾后给出回复预览，流式期间不挂半截回复', () => {
    const streaming = optimisticConversationOutlineFromMessages([
      makeMessage('turn-1'),
      makeMessage('reply-1', { role: 'assistant', content: '我先看一下这段代码' }),
    ]);
    expect(streaming[0]?.replyPreview).toBeUndefined();

    const sealed = optimisticConversationOutlineFromMessages([
      makeMessage('turn-1'),
      makeMessage('reply-1', {
        role: 'assistant',
        content: '## 根因\n连线是绝对定位在滚动容器上的',
      }),
      makeMessage('tool', { role: 'tool_use', content: '不应进入预览' }),
      makeMessage('reply-2', { role: 'assistant', content: '收尾', turnCompleted: true }),
    ]);
    // 取该 turn 的第一条 assistant 正文并剥掉 markdown 标记；seal 可以由后续
    // 任意一条 assistant 携带。
    expect(sealed[0]?.replyPreview).toBe('根因 连线是绝对定位在滚动容器上的');
  });

  it('回复预览不越过下一条 user turn', () => {
    const entries = optimisticConversationOutlineFromMessages([
      makeMessage('turn-1'),
      makeMessage('turn-2'),
      makeMessage('reply', {
        role: 'assistant',
        content: '第二个 turn 的回复',
        turnCompleted: true,
      }),
    ]);

    expect(entries.map((entry) => entry.replyPreview)).toEqual([undefined, '第二个 turn 的回复']);
  });

  it('保留恰好是 JSON 标量的纯文本 user turn', () => {
    const entries = optimisticConversationOutlineFromMessages([
      makeMessage('number', { content: '1' }),
      makeMessage('boolean', { content: 'true' }),
      makeMessage('null', { content: 'null' }),
    ]);

    expect(entries.map((entry) => entry.preview)).toEqual(['1', 'true', 'null']);
  });
});

describe('mergeConversationOutlineEntries', () => {
  it('deduplicates authoritative and optimistic entries by clientId', () => {
    const authoritative: ConversationOutlineEntry[] = [
      {
        messageId: 'db-message-1',
        clientId: 'client-1',
        rowid: 42,
        createdAt: 100,
        preview: 'Stored preview',
      },
    ];
    const optimistic: ConversationOutlineEntry[] = [
      {
        messageId: 'client:client-1',
        clientId: 'client-1',
        createdAt: 101,
        preview: 'Latest preview',
      },
    ];

    expect(mergeConversationOutlineEntries(authoritative, optimistic)).toEqual([
      {
        messageId: 'db-message-1',
        clientId: 'client-1',
        rowid: 42,
        createdAt: 100,
        preview: 'Latest preview',
      },
    ]);
  });

  it('deduplicates an old-host entry without clientId by timestamp and preview', () => {
    const authoritative: ConversationOutlineEntry[] = [
      {
        messageId: 'legacy-db-message',
        createdAt: 200,
        preview: 'Same user turn',
      },
    ];
    const optimistic: ConversationOutlineEntry[] = [
      {
        messageId: 'client:client-2',
        clientId: 'client-2',
        createdAt: 200,
        preview: 'Same user turn',
      },
    ];

    // 旧被控端没有 clientId，用时间和预览去重后回填已加载消息的
    // clientId，否则导轨无法把正文节点映射到 active 目录项。
    expect(mergeConversationOutlineEntries(authoritative, optimistic)).toEqual([
      {
        messageId: 'legacy-db-message',
        clientId: 'client-2',
        createdAt: 200,
        preview: 'Same user turn',
      },
    ]);
  });

  it('乐观项未收尾时不擦掉数据库已投影的回复预览', () => {
    const authoritative: ConversationOutlineEntry[] = [
      {
        messageId: 'db-message-1',
        clientId: 'client-1',
        createdAt: 100,
        preview: 'Stored preview',
        replyPreview: 'Stored reply',
      },
    ];
    const optimistic: ConversationOutlineEntry[] = [
      {
        messageId: 'client:client-1',
        clientId: 'client-1',
        createdAt: 100,
        preview: 'Live preview',
      },
    ];

    expect(mergeConversationOutlineEntries(authoritative, optimistic)[0]).toEqual({
      messageId: 'db-message-1',
      clientId: 'client-1',
      createdAt: 100,
      preview: 'Live preview',
      replyPreview: 'Stored reply',
    });
  });

  it('旧主机保尾裁剪的长 user 消息按时间配对，不产生重复刻度', () => {
    // 旧主机 regular history 超过 contentCharLimit 时保留尾部并打
    // remoteContentTruncated；本地乐观项取头部，两者文本永不相等。
    const authoritative: ConversationOutlineEntry[] = [
      {
        messageId: 'legacy-long',
        createdAt: 300,
        preview: '…这是被保尾裁剪后的结尾部分',
        previewTruncated: true,
      },
    ];
    const optimistic: ConversationOutlineEntry[] = [
      {
        messageId: 'client:client-long',
        clientId: 'client-long',
        createdAt: 300,
        preview: '这是一条很长的用户消息的开头',
      },
    ];

    const merged = mergeConversationOutlineEntries(authoritative, optimistic);

    expect(merged).toHaveLength(1);
    expect(merged[0]).toEqual({
      messageId: 'legacy-long',
      clientId: 'client-long',
      createdAt: 300,
      preview: '这是一条很长的用户消息的开头',
      previewTruncated: true,
    });
  });

  it('同毫秒的多条截断 legacy 行按顺序一对一配对', () => {
    const authoritative: ConversationOutlineEntry[] = [
      { messageId: 'legacy-a', createdAt: 400, preview: '…尾部 A', previewTruncated: true },
      { messageId: 'legacy-b', createdAt: 400, preview: '…尾部 B', previewTruncated: true },
    ];
    const optimistic: ConversationOutlineEntry[] = [
      { messageId: 'client:a', clientId: 'a', createdAt: 400, preview: '头部 A' },
      { messageId: 'client:b', clientId: 'b', createdAt: 400, preview: '头部 B' },
    ];

    const merged = mergeConversationOutlineEntries(authoritative, optimistic);

    expect(merged).toHaveLength(2);
    expect(merged.map((entry) => [entry.messageId, entry.clientId, entry.preview])).toEqual([
      ['legacy-a', 'a', '头部 A'],
      ['legacy-b', 'b', '头部 B'],
    ]);
  });

  /**
   * 钉住「同 createdAt 同预览」时的一对一配对。
   *
   * 这条**不是**新行为：旧写法用 merged.findIndex 扫正在被修改的数组，配对成功的权威项
   * 会被回填 clientId 从而被 `!candidate.clientId` 自动排除，一对一本来就成立。把逐次
   * 扫描换成预建索引队列（O(权威×乐观) → O(权威+乐观)）时，这条守住等价性——用队列很
   * 容易写成「每次都取同一个下标」，那样后者会覆盖前者、前者被静默丢掉。
   */
  it('同 createdAt 同预览的两条 legacy 项与两个乐观项一对一配对', () => {
    const authoritative: ConversationOutlineEntry[] = [
      { messageId: 'legacy-a', createdAt: 300, preview: 'Same' },
      { messageId: 'legacy-b', createdAt: 300, preview: 'Same' },
    ];
    const optimistic: ConversationOutlineEntry[] = [
      { messageId: 'client:c1', clientId: 'c1', createdAt: 300, preview: 'Same' },
      { messageId: 'client:c2', clientId: 'c2', createdAt: 300, preview: 'Same' },
    ];

    const merged = mergeConversationOutlineEntries(authoritative, optimistic);
    // 不新增刻度：两个乐观项都配到了权威项。
    expect(merged).toHaveLength(2);
    expect(merged.map((entry) => entry.messageId).sort()).toEqual(['legacy-a', 'legacy-b']);
    // 两个 clientId 都被回填，没有哪一个被静默丢掉。
    expect(merged.map((entry) => entry.clientId).sort()).toEqual(['c1', 'c2']);
  });

  it('does not collapse distinct old-host turns with the same preview', () => {
    const authoritative: ConversationOutlineEntry[] = [
      {
        messageId: 'legacy-db-message',
        createdAt: 200,
        preview: 'Repeated text',
      },
    ];
    const optimistic: ConversationOutlineEntry[] = [
      {
        messageId: 'client:client-3',
        clientId: 'client-3',
        createdAt: 201,
        preview: 'Repeated text',
      },
    ];

    expect(mergeConversationOutlineEntries(authoritative, optimistic)).toHaveLength(2);
  });
});

describe('useConversationOutline 增量读取', () => {
  it('新 user turn 落库后从已缓存的尾游标继续读取', async () => {
    const firstCursor = {
      createdAt: Date.parse('2026-07-27T08:00:00.000Z'),
      id: 'db-message-1',
      rowid: 1,
    };
    loadOutlinePage
      .mockResolvedValueOnce({
        entries: [
          {
            messageId: 'db-message-1',
            clientId: 'turn-1',
            rowid: 1,
            createdAt: firstCursor.createdAt,
            preview: 'Message turn-1',
          },
        ],
        cursor: firstCursor,
      })
      .mockResolvedValueOnce({
        entries: [
          {
            messageId: 'db-message-2',
            clientId: 'turn-2',
            rowid: 2,
            createdAt: firstCursor.createdAt + 1,
            preview: 'Message turn-2',
          },
        ],
        cursor: {
          createdAt: firstCursor.createdAt + 1,
          id: 'db-message-2',
          rowid: 2,
        },
      });

    const view = renderHook(
      ({ messages }: { messages: readonly ChatMessage[] }) =>
        useConversationOutline({
          sessionId: 'session-incremental',
          enabled: true,
          messages,
        }),
      { initialProps: { messages: [makeMessage('turn-1', { isPendingPersist: false })] } },
    );
    await waitFor(() => expect(loadOutlinePage).toHaveBeenCalledTimes(1));

    view.rerender({
      messages: [
        makeMessage('turn-1', { isPendingPersist: false }),
        makeMessage('turn-2', {
          createdAt: new Date(firstCursor.createdAt + 1).toISOString(),
          isPendingPersist: false,
        }),
      ],
    });
    await waitFor(() => expect(loadOutlinePage).toHaveBeenCalledTimes(2));

    expect(loadOutlinePage).toHaveBeenNthCalledWith(
      2,
      'session-incremental',
      undefined,
      expect.objectContaining({ cursor: firstCursor }),
    );
    await waitFor(() => expect(view.result.current.entries).toHaveLength(2));
    view.unmount();
  });

  /**
   * invalidate() 丢掉缓存、从会话头重读。
   *
   * 用途是「已证实缓存陈旧」——窗口外被删掉的 turn 无法靠比对乐观切片发现：
   * removeMessagesByClientIds 的 setState 在目标不在切片时走 unchanged-state 早退，
   * 既不换 messages 引用也不通知订阅者，渲染层看不到任何变化（Codex review）。
   * 所以点击跳转失败、陈旧被证实的那一刻由调用方显式失效。
   */
  it('invalidate() 丢掉缓存并从会话头重读', async () => {
    const cursor = {
      createdAt: Date.parse('2026-07-27T08:00:00.000Z'),
      id: 'db-message-1',
      rowid: 1,
    };
    const stale = {
      messageId: 'db-message-1',
      clientId: 'turn-1',
      rowid: 1,
      createdAt: cursor.createdAt,
      preview: 'Message turn-1',
    };
    loadOutlinePage
      .mockResolvedValueOnce({ entries: [stale], cursor })
      // 重读时那条已被别处删掉的 turn 不再返回。
      .mockResolvedValueOnce({ entries: [], cursor: null });

    const view = renderHook(() =>
      useConversationOutline({
        sessionId: 'session-invalidate',
        enabled: true,
        messages: [],
      }),
    );

    await waitFor(() => expect(loadOutlinePage).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(view.result.current.entries).toHaveLength(1));
    expect(loadOutlinePage).toHaveBeenNthCalledWith(
      1,
      'session-invalidate',
      undefined,
      expect.objectContaining({ cursor: null }),
    );

    act(() => view.result.current.invalidate());

    await waitFor(() => expect(loadOutlinePage).toHaveBeenCalledTimes(2));
    // 关键:第二次必须从会话头（cursor: null）重读，而不是接着尾游标增量。
    expect(loadOutlinePage).toHaveBeenNthCalledWith(
      2,
      'session-invalidate',
      undefined,
      expect.objectContaining({ cursor: null }),
    );
    await waitFor(() => expect(view.result.current.entries).toHaveLength(0));
  });

  it('删除中间 user turn 时放弃尾游标并重建权威目录', async () => {
    const createdAt = Date.parse('2026-07-27T08:00:00.000Z');
    const firstEntries: ConversationOutlineEntry[] = [
      {
        messageId: 'db-message-1',
        clientId: 'turn-1',
        rowid: 1,
        createdAt,
        preview: 'Message turn-1',
      },
      {
        messageId: 'db-message-2',
        clientId: 'turn-2',
        rowid: 2,
        createdAt: createdAt + 1,
        preview: 'Message turn-2',
      },
      {
        messageId: 'db-message-3',
        clientId: 'turn-3',
        rowid: 3,
        createdAt: createdAt + 2,
        preview: 'Message turn-3',
      },
    ];
    loadOutlinePage
      .mockResolvedValueOnce({
        entries: firstEntries,
        cursor: { createdAt: createdAt + 2, id: 'db-message-3', rowid: 3 },
      })
      .mockResolvedValueOnce({
        entries: [firstEntries[0], firstEntries[2]],
        cursor: { createdAt: createdAt + 2, id: 'db-message-3', rowid: 3 },
      });

    const messages = ['turn-1', 'turn-2', 'turn-3'].map((clientId, index) =>
      makeMessage(clientId, {
        createdAt: new Date(createdAt + index).toISOString(),
        isPendingPersist: false,
      }),
    );
    const view = renderHook(
      ({ currentMessages }: { currentMessages: readonly ChatMessage[] }) =>
        useConversationOutline({
          sessionId: 'session-delete',
          enabled: true,
          messages: currentMessages,
        }),
      { initialProps: { currentMessages: messages } },
    );
    await waitFor(() => expect(view.result.current.entries).toHaveLength(3));

    view.rerender({ currentMessages: [messages[0], messages[2]] });
    await waitFor(() => expect(loadOutlinePage).toHaveBeenCalledTimes(2));

    expect(loadOutlinePage).toHaveBeenNthCalledWith(
      2,
      'session-delete',
      undefined,
      expect.objectContaining({ cursor: null }),
    );
    await waitFor(() => expect(view.result.current.entries).toHaveLength(2));
    view.unmount();
  });

  it('assistant 收尾只更新本地回复预览，不重新读取历史目录', async () => {
    loadOutlinePage.mockResolvedValue({
      entries: [
        {
          messageId: 'db-message-1',
          clientId: 'turn-1',
          rowid: 1,
          createdAt: Date.parse('2026-07-27T08:00:00.000Z'),
          preview: 'Message turn-1',
        },
      ],
      cursor: {
        createdAt: Date.parse('2026-07-27T08:00:00.000Z'),
        id: 'db-message-1',
        rowid: 1,
      },
    });

    const initialMessages = [
      makeMessage('turn-1', { isPendingPersist: false }),
      makeMessage('reply-1', { role: 'assistant', content: '回复还在生成' }),
    ];
    const view = renderHook(
      ({ messages }: { messages: readonly ChatMessage[] }) =>
        useConversationOutline({
          sessionId: 'session-1',
          enabled: true,
          messages,
        }),
      { initialProps: { messages: initialMessages } },
    );

    await waitFor(() => expect(loadOutlinePage).toHaveBeenCalledTimes(1));

    view.rerender({
      messages: [
        ...initialMessages,
        makeMessage('reply-2', {
          role: 'assistant',
          content: '回复已收尾',
          turnCompleted: true,
        }),
      ],
    });
    await waitFor(() => expect(view.result.current.entries[0]?.replyPreview).toBe('回复还在生成'));

    expect(loadOutlinePage).toHaveBeenCalledTimes(1);
    expect(view.result.current.entries[0]?.replyPreview).toBe('回复还在生成');
    view.unmount();
  });
});

function entriesFrom(clientIds: readonly string[]): ConversationOutlineEntry[] {
  return clientIds.map((clientId, index) => ({
    messageId: `client:${clientId}`,
    clientId,
    createdAt: index + 1,
    preview: clientId,
  }));
}

describe('classifyOutlineStructureChange', () => {
  it('往两个消息岛之间补历史算 history-filled，不是破坏性变更', () => {
    // store 明确允许多个稀疏消息岛共存；深跳到中间会在两岛之间插入。
    expect(
      classifyOutlineStructureChange(entriesFrom(['c1', 'c4']), entriesFrom(['c1', 'c2', 'c4'])),
    ).toBe('history-filled');
    expect(
      classifyOutlineStructureChange(
        entriesFrom(['c100', 'c3000']),
        entriesFrom(['c100', 'c1500', 'c3000']),
      ),
    ).toBe('history-filled');
  });

  it('纯前插也是 history-filled', () => {
    expect(
      classifyOutlineStructureChange(
        entriesFrom(['c3', 'c4']),
        entriesFrom(['c1', 'c2', 'c3', 'c4']),
      ),
    ).toBe('history-filled');
  });

  it('最后一个旧项之后出现新项才算 tail-appended', () => {
    expect(
      classifyOutlineStructureChange(entriesFrom(['c1', 'c2']), entriesFrom(['c1', 'c2', 'c3'])),
    ).toBe('tail-appended');
    // 同时补历史 + 尾部追加：仍要读一次尾部。
    expect(
      classifyOutlineStructureChange(
        entriesFrom(['c1', 'c4']),
        entriesFrom(['c1', 'c2', 'c4', 'c5']),
      ),
    ).toBe('tail-appended');
  });

  it('缺项、换序、尾部被 rewind 都算 diverged', () => {
    expect(
      classifyOutlineStructureChange(entriesFrom(['c1', 'c2', 'c3']), entriesFrom(['c1', 'c3'])),
    ).toBe('diverged');
    expect(
      classifyOutlineStructureChange(entriesFrom(['c1', 'c2']), entriesFrom(['c2', 'c1'])),
    ).toBe('diverged');
    expect(classifyOutlineStructureChange(entriesFrom(['c1', 'c2']), entriesFrom(['c1']))).toBe(
      'diverged',
    );
  });
});

describe('useConversationOutline 消息岛', () => {
  it('往两个消息岛之间补历史同样不触发重新读取', async () => {
    const base = Date.parse('2026-07-27T08:00:00.000Z');
    loadOutlinePage.mockResolvedValue({
      entries: [
        { messageId: 'db-1', clientId: 'turn-1', rowid: 1, createdAt: base, preview: 'a' },
        { messageId: 'db-4', clientId: 'turn-4', rowid: 4, createdAt: base + 3_000, preview: 'd' },
      ],
      cursor: { createdAt: base + 3_000, id: 'db-4', rowid: 4 },
    });

    const island = [
      makeMessage('turn-1', { isPendingPersist: false }),
      makeMessage('turn-4', {
        createdAt: new Date(base + 3_000).toISOString(),
        isPendingPersist: false,
      }),
    ];
    const view = renderHook(
      ({ messages }: { messages: readonly ChatMessage[] }) =>
        useConversationOutline({ sessionId: 'session-island', enabled: true, messages }),
      { initialProps: { messages: island } },
    );
    await waitFor(() => expect(loadOutlinePage).toHaveBeenCalledTimes(1));

    // 深跳到中间：turn-2 落在两岛之间，旧序列不再连续但仍是有序子序列。
    view.rerender({
      messages: [
        island[0],
        makeMessage('turn-2', {
          createdAt: new Date(base + 1_000).toISOString(),
          isPendingPersist: false,
        }),
        island[1],
      ],
    });
    await waitFor(() => expect(view.result.current.entries).toHaveLength(3));

    expect(loadOutlinePage).toHaveBeenCalledTimes(1);
    view.unmount();
  });
});
