/**
 * 对话大纲共享纯函数测试：同时覆盖新主机轻量投影与旧主机 HistoryPage 降级形状。
 */
import { describe, expect, it } from 'vitest';

import {
  buildConversationOutline,
  conversationOutlineEntryFromRow,
  conversationOutlineAssistantSealsTurn,
  normalizeConversationOutlinePreview,
  normalizeConversationOutlineReplyPreview,
  shouldShowConversationOutline,
} from '../conversationOutline';
import { CONTINUE_AFTER_APP_EXIT_PROMPT, CONTINUE_AFTER_ERROR_PROMPT } from '../interruptedTurn';

describe('conversationOutline', () => {
  it('接受只有 preview 的原生投影行，并保留 clientId/rowid 锚点', () => {
    expect(
      conversationOutlineEntryFromRow({
        messageId: 'm1',
        clientId: 'c1',
        rowid: 7,
        createdAt: 1_000,
        preview: '第一条用户消息',
      }),
    ).toEqual({
      messageId: 'm1',
      clientId: 'c1',
      rowid: 7,
      createdAt: 1_000,
      preview: '第一条用户消息',
    });
  });

  it('从旧 HistoryPage content 提取首行前缀，而不是尾部', () => {
    const long = `${'前'.repeat(150)}\n第二行`;
    const entry = conversationOutlineEntryFromRow({
      id: 'legacy',
      role: 'user',
      createdAt: '2026-07-27T00:00:00.000Z',
      content: JSON.stringify({ text: long, images: [] }),
    });

    expect(entry?.preview).toHaveLength(140);
    expect(entry?.preview.startsWith('前前前')).toBe(true);
    expect(entry?.preview.endsWith('…')).toBe(true);
    expect(entry?.preview).not.toContain('第二行');
  });

  it('过滤非 user、autoResume、steer、UI trigger 与附件-only 行', () => {
    const rows = [
      { id: 'assistant', role: 'assistant', content: 'answer', createdAt: 1 },
      {
        id: 'auto',
        role: 'user',
        content: 'continue',
        agentMeta: JSON.stringify({ autoResume: true }),
        createdAt: 2,
      },
      {
        id: 'steer',
        role: 'user',
        content: 'in-flight steer',
        agentMeta: { delivery: 'steer' },
        createdAt: 3,
      },
      {
        id: 'trigger',
        role: 'user',
        content: { text: '[UI_ACTION_TRIGGER] continue' },
        createdAt: 4,
      },
      {
        id: 'attachment',
        role: 'user',
        content: { text: '', images: [{ src: 'hidden' }] },
        createdAt: 5,
      },
    ];

    expect(buildConversationOutline(rows)).toEqual([]);
  });

  it('过滤旧主机尾部裁剪后的隐藏续跑指令，不误过滤普通尾部文本', () => {
    const legacySuffixCap = (text: string, limit: number): string =>
      text.length > limit ? `…${text.slice(-(limit - 1))}` : text;
    const rows = [CONTINUE_AFTER_APP_EXIT_PROMPT, CONTINUE_AFTER_ERROR_PROMPT].map(
      (prompt, index) => ({
        id: `legacy-trigger-${index}`,
        role: 'user',
        content: legacySuffixCap(prompt, 256),
        createdAt: index + 10,
      }),
    );

    expect(buildConversationOutline(rows)).toEqual([]);
    expect(normalizeConversationOutlinePreview('…这是普通消息的尾部')).toBe('…这是普通消息的尾部');
  });

  it('识别旧主机保尾裁剪的行，标记 previewTruncated', () => {
    const truncated = conversationOutlineEntryFromRow({
      id: 'legacy-long',
      role: 'user',
      content: `…${'尾'.repeat(40)}`,
      createdAt: 1_000,
      agentMeta: { remoteContentTruncated: true },
    });
    expect(truncated?.previewTruncated).toBe(true);

    // 没有 agentMeta 的更老 payload：保尾裁剪必然以省略号开头，兜底判据要认出来。
    const noMeta = conversationOutlineEntryFromRow({
      id: 'legacy-no-meta',
      role: 'user',
      content: `…${'尾'.repeat(40)}`,
      createdAt: 1_001,
    });
    expect(noMeta?.previewTruncated).toBe(true);

    // 未被裁剪的普通行不该带这个标记，否则会误走一对一配对。
    const plain = conversationOutlineEntryFromRow({
      id: 'plain',
      role: 'user',
      content: '短消息',
      createdAt: 1_002,
    });
    expect(plain?.previewTruncated).toBeUndefined();
  });

  it('按 rowid 保持同毫秒插入顺序，并按 messageId 去重', () => {
    const entries = buildConversationOutline([
      { id: 'row-a', rowid: 3, role: 'user', content: '第三条', createdAt: 1_000 },
      { id: 'row-z', rowid: 1, role: 'user', content: '第一条', createdAt: 1_000 },
      { id: 'row-m', rowid: 2, role: 'user', content: '第二条', createdAt: 1_000 },
      { id: 'row-m', rowid: 2, role: 'user', content: '第二条重复', createdAt: 1_000 },
    ]);

    expect(entries.map((entry) => entry.messageId)).toEqual(['row-z', 'row-m', 'row-a']);
    expect(entries.find((entry) => entry.messageId === 'row-m')?.preview).toBe('第二条重复');
  });

  it('回复预览折成一段并剥掉 markdown 结构标记', () => {
    expect(
      normalizeConversationOutlineReplyPreview('## 根因\n\n- 连线是 `absolute` 的\n- **可视高度**'),
    ).toBe('根因 连线是 absolute 的 可视高度');
    // 与 user 预览不同：回复不止取首行，否则只会显示一个 markdown 标题。
    expect(normalizeConversationOutlinePreview('## 根因\n连线是 absolute 的')).toBe('## 根因');
    expect(normalizeConversationOutlineReplyPreview('a'.repeat(200))).toHaveLength(160);
    expect(normalizeConversationOutlineReplyPreview('   \n\n  ')).toBe('');
    expect(normalizeConversationOutlineReplyPreview(null)).toBe('');
    // 数组形态的 content 只取 text 块，附件/工具块不进预览。
    expect(
      normalizeConversationOutlineReplyPreview([
        { type: 'text', text: '第一段' },
        { type: 'image', source: 'secret' },
      ]),
    ).toBe('第一段');
  });

  it('回复预览带过来的隐藏续跑指令不渲染', () => {
    expect(
      normalizeConversationOutlineReplyPreview('[UI_ACTION_TRIGGER] continue after error'),
    ).toBe('');
  });

  /**
   * 两个预览函数都改成「取到需要的量就停」，不再折完整段正文（流式期间每个 turn
   * 每批 delta 都要跑一次）。这组用例钉住提前停止与全量折行**结果完全一致**，
   * 尤其是长度恰好等于上限、以及 \r\n / 单独 \r / 尾随换行这些分行边界。
   */
  it('提前停止的预览与全量折行结果一致，包含恰好等于上限的边界', () => {
    // 恰好 160:后面还有行 → 总长超限，必须裁剪加省略号。
    expect(normalizeConversationOutlineReplyPreview(`${'a'.repeat(160)}\nb`)).toBe(
      `${'a'.repeat(159)}…`,
    );
    // 恰好 160 且到此为止 → 原样返回，不能因为"攒够了"就误加省略号。
    expect(normalizeConversationOutlineReplyPreview('a'.repeat(160))).toBe('a'.repeat(160));
    expect(normalizeConversationOutlineReplyPreview(`${'a'.repeat(160)}\n   \n  `)).toBe(
      'a'.repeat(160),
    );
    expect(normalizeConversationOutlineReplyPreview('a'.repeat(161))).toBe(`${'a'.repeat(159)}…`);
    // \r\n 的 \r 属于分隔符，不能留进正文；单独的 \r 不分行，按空白归一。
    expect(normalizeConversationOutlineReplyPreview('第一段\r\n第二段')).toBe('第一段 第二段');
    expect(normalizeConversationOutlinePreview('\r\n  首行  \r\n次行')).toBe('首行');
    expect(normalizeConversationOutlinePreview('前\r后')).toBe('前 后');
    expect(normalizeConversationOutlinePreview('尾随换行\n')).toBe('尾随换行');
    // 首行前有大量空行时仍要跳到第一条有内容的行,不能停在空行上。
    expect(normalizeConversationOutlinePreview(`${'\n'.repeat(50)}真正的首行\n更多`)).toBe(
      '真正的首行',
    );
    expect(normalizeConversationOutlinePreview('a'.repeat(200))).toBe(`${'a'.repeat(139)}…`);
    expect(normalizeConversationOutlinePreview('长首行', 1)).toBe('…');
  });

  it('规范化空白、首行和阈值显示判定', () => {
    expect(normalizeConversationOutlinePreview(' \n  hello   world \n ignored')).toBe(
      'hello world',
    );
    expect(normalizeConversationOutlinePreview('1')).toBe('1');
    expect(normalizeConversationOutlinePreview('true')).toBe('true');
    expect(normalizeConversationOutlinePreview('null')).toBe('null');
    expect(normalizeConversationOutlinePreview('"quoted"')).toBe('quoted');
    expect(
      shouldShowConversationOutline(
        Array.from({ length: 3 }, (_, index) => ({
          messageId: `m${index}`,
          createdAt: index,
          preview: `turn ${index}`,
        })),
      ),
    ).toBe(false);
    expect(
      shouldShowConversationOutline(
        Array.from({ length: 4 }, (_, index) => ({
          messageId: `m${index}`,
          createdAt: index,
          preview: `turn ${index}`,
        })),
      ),
    ).toBe(true);
  });
});

describe('conversationOutlineAssistantSealsTurn', () => {
  const seal = (agentMeta: unknown) =>
    conversationOutlineAssistantSealsTurn({ role: 'assistant', text: '回复', agentMeta });

  it('turnCompleted 必须是布尔 true，数字 1 不算', () => {
    expect(seal({ turnCompleted: true })).toBe(true);
    expect(seal({ turnCompleted: 1 })).toBe(false);
  });

  it('存量会话用收尾金额等价推导', () => {
    expect(seal({ turnCostUsd: 0.02 })).toBe(true);
    expect(
      seal({
        turnCost: { amount: 0.03, currency: 'USD', approximate: false, kind: 'actual-cost' },
      }),
    ).toBe(true);
  });

  it('拒绝非数字、非正数与形态非法的金额', () => {
    expect(seal({ turnCostUsd: '0.04' })).toBe(false);
    expect(seal({ turnCostUsd: -0.05 })).toBe(false);
    // 币种不在白名单内 → normalizeRegionalMoney 判为无效，回落到旧字段（这里没有）。
    expect(
      seal({
        turnCost: { amount: 0.06, currency: 'EUR', approximate: false, kind: 'actual-cost' },
      }),
    ).toBe(false);
  });

  it('合法的零值新字段压住旧字段，不再由正数 turnCostUsd 推导为已收尾', () => {
    // 与 renderer 的 `normalizedTurnMoney ?? legacyTurnMoney` 同序。
    expect(
      seal({
        turnCost: { amount: 0, currency: 'USD', approximate: false, kind: 'actual-cost' },
        turnCostUsd: 0.07,
      }),
    ).toBe(false);
  });

  it('无法解析的 agent_meta 视为未收尾，而不是抛错', () => {
    expect(seal('{malformed-json')).toBe(false);
    expect(seal(null)).toBe(false);
    expect(seal(undefined)).toBe(false);
  });

  it('只有 assistant 行能携带 seal', () => {
    expect(
      conversationOutlineAssistantSealsTurn({
        role: 'user',
        text: '提问',
        agentMeta: { turnCompleted: true },
      }),
    ).toBe(false);
  });
});
