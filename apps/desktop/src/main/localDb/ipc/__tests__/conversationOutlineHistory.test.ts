/**
 * 对话大纲 history projection 的真实 SQL 回归测试。
 *
 * 使用内存 SQLite 而不是 mock Drizzle 链，确保 /clear、rewind、rowid 游标和
 * 隐藏 user 行的组合过滤与生产查询一致。
 */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DL_HISTORY_MESSAGES_CHANNEL } from '@cindy/device-link';

import { messages, sessions } from '../../schema';
import type {
  ConversationOutlineHistoryPage,
  ConversationOutlineHistoryRequest,
} from '../../../../shared/conversationOutline';

const h = vi.hoisted(() => ({
  db: null as ReturnType<typeof drizzle> | null,
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  assertTrusted: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      h.handlers.set(channel, handler);
    }),
  },
}));

vi.mock('../../client/current', () => ({
  getDbClient: () => ({ drizzle: h.db }),
}));

// 真实断言依赖构建期注入的 renderer 地址全局（单测里未定义），这里替换成可观测的
// stub：既能让既有用例照常跑，也能断言 handler 是否按来源调用了它。
vi.mock('../../../security/trustedAppRenderer', () => ({
  assertTrustedAppRendererEvent: (event: unknown) => h.assertTrusted(event),
}));

import { runDeviceLinkInvokeContext } from '../../../device-link/invoke-context';
import { registerRemoteHistoryIpc } from '../history';

let sqlite: Database.Database | null = null;

function createDb(clearedAt: number | null = null): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      cleared_at INTEGER
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      agent_meta TEXT,
      created_at INTEGER NOT NULL,
      rewind_at INTEGER
    );
  `);
  db.prepare('INSERT INTO sessions (id, cleared_at) VALUES (?, ?)').run('s1', clearedAt);
  h.db = drizzle(db, { schema: { messages, sessions } });
  return db;
}

function insertMessage(
  db: Database.Database,
  input: {
    id: string;
    role?: string;
    content: unknown;
    createdAt: number;
    agentMeta?: Record<string, unknown> | null;
    rewindAt?: number | null;
  },
): void {
  db.prepare(
    `
    INSERT INTO messages (
      id, client_id, session_id, role, content, agent_meta, created_at, rewind_at
    ) VALUES (
      @id, @clientId, 's1', @role, @content, @agentMeta, @createdAt, @rewindAt
    )
  `,
  ).run({
    id: input.id,
    clientId: `client-${input.id}`,
    role: input.role ?? 'user',
    content: JSON.stringify(input.content),
    agentMeta: input.agentMeta ? JSON.stringify(input.agentMeta) : null,
    createdAt: input.createdAt,
    rewindAt: input.rewindAt ?? null,
  });
}

function outlineRequest(
  patch: Partial<ConversationOutlineHistoryRequest> = {},
): ConversationOutlineHistoryRequest {
  return {
    sessionId: 's1',
    workdir: null,
    fromMs: null,
    toMs: null,
    agentKind: null,
    roles: ['user'],
    includeRewound: false,
    limit: 100,
    cursor: null,
    order: 'asc',
    projection: 'turn-index',
    contentCharLimit: null,
    ...patch,
  };
}

async function readPage(
  request: ConversationOutlineHistoryRequest,
): Promise<ConversationOutlineHistoryPage> {
  const handler = h.handlers.get(DL_HISTORY_MESSAGES_CHANNEL);
  expect(handler).toBeTypeOf('function');
  return (await handler?.({}, request)) as ConversationOutlineHistoryPage;
}

beforeEach(() => {
  h.handlers.clear();
  h.db = null;
  h.assertTrusted.mockReset();
  registerRemoteHistoryIpc();
});

afterEach(() => {
  sqlite?.close();
  sqlite = null;
});

describe('conversation outline history projection', () => {
  it('只返回 /clear 后可见的真实 user turn，并生成前缀预览', async () => {
    sqlite = createDb(1_000);
    insertMessage(sqlite, { id: 'before-clear', content: '旧消息', createdAt: 999 });
    insertMessage(sqlite, { id: 'at-clear', content: '同毫秒旧消息', createdAt: 1_000 });
    insertMessage(sqlite, {
      id: 'assistant',
      role: 'assistant',
      content: 'assistant',
      createdAt: 1_001,
    });
    insertMessage(sqlite, {
      id: 'rewound',
      content: '已回滚',
      createdAt: 1_002,
      rewindAt: 9_999,
    });
    insertMessage(sqlite, {
      id: 'auto-resume',
      content: 'continue',
      createdAt: 1_003,
      agentMeta: { autoResume: true },
    });
    insertMessage(sqlite, {
      id: 'ui-trigger',
      content: '[UI_ACTION_TRIGGER] continue',
      createdAt: 1_004,
    });
    insertMessage(sqlite, {
      id: 'steer',
      content: '运行中追加',
      createdAt: 1_005,
      agentMeta: { delivery: 'steer' },
    });
    insertMessage(sqlite, {
      id: 'attachment-only',
      content: { text: '', images: [{ src: 'secret' }] },
      createdAt: 1_006,
    });
    insertMessage(sqlite, {
      id: 'visible',
      content: '  第一行预览  \n第二行不应进入目录',
      createdAt: 1_007,
    });

    const page = await readPage(outlineRequest());

    expect(page).toEqual({
      items: [
        {
          messageId: 'visible',
          clientId: 'client-visible',
          rowid: 9,
          createdAt: 1_007,
          preview: '第一行预览',
        },
      ],
      nextCursor: null,
      hasMore: false,
    });
    expect(JSON.stringify(page)).not.toContain('secret');
  });

  /**
   * 端到端走真实 SQL 投影：正文本身就是 JSON 字面量的提问必须留在大纲里。
   *
   * history.ts 的投影把**原始存库列**（`content: messages.content`）直接交给
   * conversationOutlineEntryFromRow，而 user 消息的存法是 JSON.stringify(纯字符串)
   * ——所以库里是「包着 JSON 的 JSON 字符串」。解一层拿到可见文本后若再解析一次，
   * 就会解出没有 text/content 字段的对象、预览变空，这条 turn 连同跳转锚点一起消失。
   * 共享函数层面的用例见 shared/__tests__/conversationOutline.test.ts；这条锁住 DB
   * 这一整条链路，因为缺陷正是在这个调用点暴露的（Codex review 第二轮）。
   */
  it('正文是 JSON 字面量的提问不会从投影里消失', async () => {
    const db = (sqlite = createDb());
    const literals = ['{"cmd":"build"}', '[1,2,3]', '{}', '[]'];
    literals.forEach((literal, index) => {
      // 用局部的 db 而不是模块级 sqlite：后者类型是 `Database | null`，
      // 在回调里拿不到外层的类型收窄。
      insertMessage(db, { id: `json-${index}`, content: literal, createdAt: 3_000 + index });
    });

    const page = await readPage(outlineRequest({ limit: 10 }));
    expect(page.items.map((item) => item.messageId)).toEqual(
      literals.map((_, index) => `json-${index}`),
    );
    expect(page.items.map((item) => item.preview)).toEqual(literals);
  });

  it('以 rowid 稳定分页同毫秒消息，不因 id 字典序跳项', async () => {
    sqlite = createDb();
    insertMessage(sqlite, { id: 'row-z', content: '第一条', createdAt: 2_000 });
    insertMessage(sqlite, {
      id: 'hidden-middle',
      content: '[UI_ACTION_TRIGGER] hidden',
      createdAt: 2_000,
    });
    insertMessage(sqlite, { id: 'row-a', content: '第二条', createdAt: 2_000 });

    const first = await readPage(outlineRequest({ limit: 1 }));
    expect(first.items.map((item) => item.messageId)).toEqual(['row-z']);
    expect(first.nextCursor).toEqual({ createdAt: 2_000, id: 'row-z', rowid: 1 });
    expect(first.hasMore).toBe(true);

    const second = await readPage(outlineRequest({ limit: 1, cursor: first.nextCursor }));
    expect(second.items.map((item) => item.messageId)).toEqual(['row-a']);
    expect(second.nextCursor).toBeNull();
    expect(second.hasMore).toBe(false);
  });

  it('不带 rowid 的旧游标按 id 反查补齐，同毫秒分页不跳项', async () => {
    sqlite = createDb();
    // id 字典序与插入顺序刻意相反：若第二页退化成按 id 排，row-a 会被判定为
    // "已在游标之前" 而被跳过。
    insertMessage(sqlite, { id: 'row-z', content: '第一条', createdAt: 2_000 });
    insertMessage(sqlite, { id: 'row-a', content: '第二条', createdAt: 2_000 });

    const first = await readPage(outlineRequest({ limit: 1 }));
    expect(first.items.map((item) => item.messageId)).toEqual(['row-z']);

    const legacyCursor = { createdAt: 2_000, id: 'row-z' };
    const second = await readPage(outlineRequest({ limit: 1, cursor: legacyCursor }));

    expect(second.items.map((item) => item.messageId)).toEqual(['row-a']);
  });

  it('跨过整批隐藏行继续扫描，不把原始行数误当可见目录数', async () => {
    sqlite = createDb();
    for (let index = 0; index < 260; index += 1) {
      insertMessage(sqlite, {
        id: `hidden-${String(index).padStart(3, '0')}`,
        content: `[UI_ACTION_TRIGGER] hidden ${index}`,
        createdAt: 3_000 + index,
      });
    }
    insertMessage(sqlite, {
      id: 'visible-after-hidden-page',
      content: '真正的用户消息',
      createdAt: 4_000,
    });

    const page = await readPage(outlineRequest({ limit: 1 }));

    expect(page.items.map((item) => item.messageId)).toEqual(['visible-after-hidden-page']);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
  });

  it('取该 turn 的第一条 assistant 正文做回复预览，工具输出与思考不参与', async () => {
    sqlite = createDb();
    insertMessage(sqlite, { id: 'turn-1', content: '连线为什么断了', createdAt: 6_000 });
    insertMessage(sqlite, { id: 'think', role: 'thinking', content: '内部思考', createdAt: 6_001 });
    insertMessage(sqlite, {
      id: 'tool',
      role: 'tool_use',
      content: 'grep secret-token',
      createdAt: 6_002,
    });
    insertMessage(sqlite, {
      id: 'reply-1',
      role: 'assistant',
      content: '## 根因\n连线绝对定位在滚动容器上，`top/bottom` 只按可视高度解析',
      createdAt: 6_003,
    });
    insertMessage(sqlite, {
      id: 'reply-2',
      role: 'assistant',
      content: '第二段不应作为预览',
      createdAt: 6_004,
      agentMeta: { turnCompleted: true },
    });

    const page = await readPage(outlineRequest());

    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.replyPreview).toBe(
      '根因 连线绝对定位在滚动容器上，top/bottom 只按可视高度解析',
    );
    expect(JSON.stringify(page)).not.toContain('secret-token');
    expect(JSON.stringify(page)).not.toContain('内部思考');
  });

  it('本 turn 未收尾时不给回复预览，seal 落库后才给', async () => {
    sqlite = createDb();
    insertMessage(sqlite, { id: 'turn-1', content: '帮我查一下', createdAt: 10_000 });
    // assistant 正文在 block 边界（这里是紧随的 tool_use）就落库，此时 SDK 还没 done、
    // agent_meta 里没有 turnCompleted —— 属于「我先检查一下……」那一类半截回复。
    insertMessage(sqlite, {
      id: 'reply-partial',
      role: 'assistant',
      content: '我先检查一下这段代码',
      createdAt: 10_001,
    });
    insertMessage(sqlite, {
      id: 'tool',
      role: 'tool_use',
      content: 'grep something',
      createdAt: 10_002,
    });

    const running = await readPage(outlineRequest());
    expect(running.items[0]?.replyPreview).toBeUndefined();

    // done 之后 markAssistantTurnCompleted 把 seal patch 到收尾 assistant 上。
    insertMessage(sqlite, {
      id: 'reply-final',
      role: 'assistant',
      content: '查完了，问题在这里',
      createdAt: 10_003,
      agentMeta: { turnCompleted: true },
    });

    const sealed = await readPage(outlineRequest());
    // 收尾后仍取**第一条** assistant 的正文，而不是带 seal 的那条。
    expect(sealed.items[0]?.replyPreview).toBe('我先检查一下这段代码');
  });

  it('费用字段形成的历史 seal 对最后一轮同样生效', async () => {
    // seal 判据的全部形态（turnCompleted / turnCost / turnCostUsd、非法金额、
    // 零值压制、无法解析的 agent_meta）已在 shared 的
    // conversationOutlineAssistantSealsTurn 单测里穷举；这里只验端到端接线：
    // 存量会话没有 turnCompleted，仅凭收尾金额也能让最后一轮显示回复。
    sqlite = createDb();
    insertMessage(sqlite, { id: 'turn-legacy', content: '存量会话的提问', createdAt: 10_100 });
    insertMessage(sqlite, {
      id: 'reply-legacy',
      role: 'assistant',
      content: '存量会话的回复',
      createdAt: 10_101,
      agentMeta: { turnCostUsd: 0.02 },
    });

    const page = await readPage(outlineRequest());

    expect(page.items.map((item) => [item.messageId, item.replyPreview])).toEqual([
      ['turn-legacy', '存量会话的回复'],
    ]);
  });

  it('历史 turn 没有任何 seal 字段，但后面还有 turn，仍展示回复', async () => {
    // 2026-07-29 实机回归：只认 seal 会让所有历史 turn 都拿不到回复预览。
    // 「后面还有真实 user turn」是同等有效的收尾证据——用户都问下一个问题了。
    sqlite = createDb();
    insertMessage(sqlite, { id: 'turn-1', content: '第一问', createdAt: 10_200 });
    insertMessage(sqlite, {
      id: 'reply-1',
      role: 'assistant',
      content: '第一问的回复',
      createdAt: 10_201,
    });
    insertMessage(sqlite, { id: 'turn-2', content: '第二问', createdAt: 10_202 });
    insertMessage(sqlite, {
      id: 'reply-2',
      role: 'assistant',
      content: '第二问的回复',
      createdAt: 10_203,
    });

    const page = await readPage(outlineRequest());

    expect(page.items.map((item) => [item.messageId, item.replyPreview])).toEqual([
      // 被下一轮界定 → 展示；最后一轮既无 seal 也无后续 turn → 不展示。
      ['turn-1', '第一问的回复'],
      ['turn-2', undefined],
    ]);
  });

  it('steer / autoResume / 续跑指令不算 turn 边界，不切断回复预览', async () => {
    sqlite = createDb();
    insertMessage(sqlite, { id: 'turn-1', content: '帮我改一下', createdAt: 12_000 });
    // 这三种 role='user' 行都落在真实 user 与其 assistant 之间。
    insertMessage(sqlite, {
      id: 'steer',
      content: '顺便也看下测试',
      createdAt: 12_001,
      agentMeta: { delivery: 'steer' },
    });
    insertMessage(sqlite, {
      id: 'auto-resume',
      content: 'continue',
      createdAt: 12_002,
      agentMeta: { autoResume: true },
    });
    insertMessage(sqlite, {
      id: 'ui-trigger',
      content: '[UI_ACTION_TRIGGER] continue after error',
      createdAt: 12_003,
    });
    insertMessage(sqlite, {
      id: 'reply',
      role: 'assistant',
      content: '改完了',
      createdAt: 12_004,
      agentMeta: { turnCompleted: true },
    });

    const page = await readPage(outlineRequest());

    // 目录里只有真实 turn，且它拿到了回复预览——三种续跑行既不成为目录项，
    // 也不充当边界。
    expect(page.items.map((item) => [item.messageId, item.replyPreview])).toEqual([
      ['turn-1', '改完了'],
    ]);
  });

  it('按顺序读取数组里的全部可见文本块，后置续跑指令仍不算边界', async () => {
    sqlite = createDb();
    insertMessage(sqlite, { id: 'turn-1', content: '帮我看一下图片', createdAt: 12_100 });
    // 导入历史可能把附件放在 text 前面；隐藏指令仍应由后面的 text 块识别，不能
    // 因 `$[0].text` 为空而被误判成下一条真实 user turn。
    insertMessage(sqlite, {
      id: 'ui-trigger-array',
      content: [
        { type: 'image', source: 'private-image' },
        { type: 'text', text: '[UI_ACTION_TRIGGER] continue after error' },
      ],
      createdAt: 12_101,
    });
    insertMessage(sqlite, {
      id: 'reply-array',
      role: 'assistant',
      content: [
        // 非 text 块即使碰巧带 text 字段也不能进入用户可见预览。
        { type: 'thinking', text: '内部推理不能显示' },
        { type: 'text', text: '' },
        { type: 'text', text: '第一段回复' },
        '第二段回复',
      ],
      createdAt: 12_102,
      agentMeta: { turnCompleted: true },
    });

    const page = await readPage(outlineRequest());

    expect(page.items.map((item) => [item.messageId, item.replyPreview])).toEqual([
      ['turn-1', '第一段回复 第二段回复'],
    ]);
    expect(JSON.stringify(page)).not.toContain('private-image');
    expect(JSON.stringify(page)).not.toContain('内部推理不能显示');
  });

  it('支持对象 content 字段与看似 JSON 标量的纯文本回复', async () => {
    sqlite = createDb();
    insertMessage(sqlite, {
      id: 'object-turn',
      content: { content: '对象里的提问' },
      createdAt: 12_200,
    });
    insertMessage(sqlite, {
      id: 'object-trigger',
      content: { content: '[UI_ACTION_TRIGGER] continue' },
      createdAt: 12_201,
    });
    insertMessage(sqlite, {
      id: 'object-reply',
      role: 'assistant',
      content: { content: '对象里的回复' },
      createdAt: 12_202,
      agentMeta: { turnCompleted: true },
    });
    insertMessage(sqlite, { id: 'scalar-turn', content: '答案只要一个数字', createdAt: 12_203 });
    // 字符串 "1" 在 SQLite 看来是合法 JSON integer，但 shared 会把它当用户可见原文。
    insertMessage(sqlite, {
      id: 'scalar-reply',
      role: 'assistant',
      content: '1',
      createdAt: 12_204,
      agentMeta: { turnCompleted: true },
    });

    const page = await readPage(outlineRequest());

    expect(page.items.map((item) => [item.messageId, item.replyPreview])).toEqual([
      ['object-turn', '对象里的回复'],
      ['scalar-turn', '1'],
    ]);
  });

  it('空正文的 assistant system card 不顶掉真实回复', async () => {
    sqlite = createDb();
    insertMessage(sqlite, { id: 'turn-1', content: '继续这个目标', createdAt: 15_000 });
    // goal-host 的 persistGoalNotice：role='assistant' 且 content=''，渲染成 system card。
    insertMessage(sqlite, {
      id: 'goal-notice',
      role: 'assistant',
      content: '',
      createdAt: 15_001,
      agentMeta: { goalNotice: 'usage-resumed' },
    });
    // 用量恢复后的自动续跑触发行（不算边界）。
    insertMessage(sqlite, {
      id: 'auto-resume',
      content: 'continue',
      createdAt: 15_002,
      agentMeta: { autoResume: true },
    });
    insertMessage(sqlite, {
      id: 'reply',
      role: 'assistant',
      content: '继续做完了',
      createdAt: 15_003,
      agentMeta: { turnCompleted: true },
    });

    const page = await readPage(outlineRequest());

    // 与 Renderer 的 replyPreviewForTurn 一致：跳过空内容，取后面的正文。
    expect(page.items.map((item) => [item.messageId, item.replyPreview])).toEqual([
      ['turn-1', '继续做完了'],
    ]);
  });

  it('只有空 assistant、没有正文时不给回复预览', async () => {
    sqlite = createDb();
    insertMessage(sqlite, { id: 'turn-1', content: '只触发了提示卡', createdAt: 16_000 });
    insertMessage(sqlite, {
      id: 'blank-card',
      role: 'assistant',
      content: '   \n  ',
      createdAt: 16_001,
      agentMeta: { turnCompleted: true },
    });

    const page = await readPage(outlineRequest());

    // 空白字符也算没有正文；seal 在这条空行上仍然有效，但没有可展示的回复。
    expect(page.items.map((item) => [item.messageId, item.replyPreview])).toEqual([
      ['turn-1', undefined],
    ]);
  });

  it('近似但不相同的合成前缀是可见 turn，仍充当边界', async () => {
    sqlite = createDb();
    insertMessage(sqlite, { id: 'turn-1', content: '第一问', createdAt: 14_000 });
    // 两条都不等于真正的前缀：`-` 不是 `_`，小写不等于大写。Renderer 的
    // startsWith 不会命中，SQL 也必须一致——否则丢掉边界、回复挂到上一轮。
    insertMessage(sqlite, {
      id: 'near-miss-dash',
      content: '[UI-ACTION-TRIGGER] 这是用户自己打的',
      createdAt: 14_001,
    });
    insertMessage(sqlite, {
      id: 'reply-dash',
      role: 'assistant',
      content: '回给 dash 那条',
      createdAt: 14_002,
      agentMeta: { turnCompleted: true },
    });
    insertMessage(sqlite, {
      id: 'near-miss-lower',
      content: '[ui_action_trigger] 小写也是用户输入',
      createdAt: 14_003,
    });
    insertMessage(sqlite, {
      id: 'reply-lower',
      role: 'assistant',
      content: '回给小写那条',
      createdAt: 14_004,
      agentMeta: { turnCompleted: true },
    });

    const page = await readPage(outlineRequest());

    // 三条都是可见 turn；turn-1 被 dash 那条截断、拿不到回复。
    expect(page.items.map((item) => [item.messageId, item.replyPreview])).toEqual([
      ['turn-1', undefined],
      ['near-miss-dash', '回给 dash 那条'],
      ['near-miss-lower', '回给小写那条'],
    ]);
  });

  it('附件-only 行仍是真实 turn，继续充当边界', async () => {
    sqlite = createDb();
    insertMessage(sqlite, { id: 'turn-1', content: '第一问', createdAt: 13_000 });
    // 只有图片没有文字：不作为目录项（无预览文本），但它确实是一次提问。
    insertMessage(sqlite, {
      id: 'attachment-only',
      content: { text: '', images: [{ src: 'shot.png' }] },
      createdAt: 13_001,
    });
    insertMessage(sqlite, {
      id: 'reply-for-attachment',
      role: 'assistant',
      content: '这是图里的内容',
      createdAt: 13_002,
      agentMeta: { turnCompleted: true },
    });

    const page = await readPage(outlineRequest());

    // turn-1 被附件-only 那次提问截断，拿不到后面那条回复。
    expect(page.items.map((item) => [item.messageId, item.replyPreview])).toEqual([
      ['turn-1', undefined],
    ]);
  });

  it('被下一轮界定的 turn 展示自己说过的话，不会串到下一轮的正文', async () => {
    sqlite = createDb();
    insertMessage(sqlite, { id: 'turn-1', content: '第一问', createdAt: 11_000 });
    insertMessage(sqlite, {
      id: 'reply-1-partial',
      role: 'assistant',
      content: '第一问被打断前说的话',
      createdAt: 11_001,
    });
    // 第一轮被打断，用户直接发了第二问；seal 属于第二轮。
    insertMessage(sqlite, { id: 'turn-2', content: '第二问', createdAt: 11_002 });
    insertMessage(sqlite, {
      id: 'reply-2',
      role: 'assistant',
      content: '第二问的回复',
      createdAt: 11_003,
      agentMeta: { turnCompleted: true },
    });

    const page = await readPage(outlineRequest());

    // 第一轮取自己那条（被打断的话也是它说过的），绝不能取到第二轮的正文。
    expect(page.items.map((item) => [item.messageId, item.replyPreview])).toEqual([
      ['turn-1', '第一问被打断前说的话'],
      ['turn-2', '第二问的回复'],
    ]);
  });

  it('turn 没有回复时不越界取下一个 turn 的正文', async () => {
    sqlite = createDb();
    insertMessage(sqlite, { id: 'failed-turn', content: '这条报错了', createdAt: 7_000 });
    insertMessage(sqlite, {
      id: 'error-row',
      role: 'error',
      content: 'turn failed',
      createdAt: 7_001,
    });
    insertMessage(sqlite, { id: 'next-turn', content: '重试一次', createdAt: 7_002 });
    insertMessage(sqlite, {
      id: 'next-reply',
      role: 'assistant',
      content: '这次成功了',
      createdAt: 7_003,
      agentMeta: { turnCompleted: true },
    });

    const page = await readPage(outlineRequest());

    expect(page.items.map((item) => [item.messageId, item.replyPreview])).toEqual([
      ['failed-turn', undefined],
      ['next-turn', '这次成功了'],
    ]);
  });

  it('跳过已 rewind 的回复，并按扫描上限截断超长正文', async () => {
    sqlite = createDb();
    insertMessage(sqlite, { id: 'turn-1', content: '继续', createdAt: 8_000 });
    insertMessage(sqlite, {
      id: 'rewound-reply',
      role: 'assistant',
      content: '已回退的回复',
      createdAt: 8_001,
      rewindAt: 9_999,
    });
    insertMessage(sqlite, {
      id: 'live-reply',
      role: 'assistant',
      content: 'X'.repeat(600),
      createdAt: 8_002,
      agentMeta: { turnCompleted: true },
    });

    const page = await readPage(outlineRequest());

    const replyPreview = page.items[0]?.replyPreview ?? '';
    expect(replyPreview.startsWith('X')).toBe(true);
    // 160 字上限 + 省略号；rewind 行不参与。
    expect(replyPreview).toHaveLength(160);
    expect(replyPreview.endsWith('…')).toBe(true);
    expect(JSON.stringify(page)).not.toContain('已回退的回复');
  });

  it('Renderer 来源校验 sender，device-link 合成 event 跳过校验', async () => {
    sqlite = createDb();
    insertMessage(sqlite, { id: 'turn-1', content: '你好', createdAt: 9_000 });

    // Renderer 直接调用（无 device-link 上下文）→ 必须过 sender 断言。
    await readPage(outlineRequest());
    expect(h.assertTrusted).toHaveBeenCalledTimes(1);

    // device-link 经 dispatchLocalInvoke 复用本机 handler，传的是没有 senderFrame
    // 的合成 event；此时不能断言，否则远程读取全被拒。
    h.assertTrusted.mockReset();
    const handler = h.handlers.get(DL_HISTORY_MESSAGES_CHANNEL);
    await runDeviceLinkInvokeContext({ controllerDeviceId: 'ctrl-1', channel: 'x' }, () =>
      handler?.({}, outlineRequest()),
    );
    expect(h.assertTrusted).not.toHaveBeenCalled();

    // 断言抛错时请求必须失败，不能继续读库。
    h.assertTrusted.mockImplementation(() => {
      throw new Error('[PERMISSION_DENIED] 此操作只能从 Cindy 主页面发起');
    });
    await expect(readPage(outlineRequest())).rejects.toThrow('PERMISSION_DENIED');
  });

  it('后继行只用一次范围扫描取回，不按 turn 逐个发查询', async () => {
    sqlite = createDb();
    // 大量隐藏续跑行 + 两个可见 turn；limit=1 时只应为第 1 个可见 turn 取窗口。
    for (let index = 0; index < 20; index += 1) {
      insertMessage(sqlite, {
        id: `hidden-${index}`,
        content: `[UI_ACTION_TRIGGER] hidden ${index}`,
        createdAt: 20_000 + index,
      });
    }
    insertMessage(sqlite, { id: 'turn-1', content: '第一问', createdAt: 20_100 });
    insertMessage(sqlite, {
      id: 'reply-1',
      role: 'assistant',
      content: '第一问的回复',
      createdAt: 20_101,
      agentMeta: { turnCompleted: true },
    });
    insertMessage(sqlite, { id: 'turn-2', content: '第二问', createdAt: 20_200 });

    // 统计后继行查询的执行次数：它是唯一带 json_each 的语句（主扫描查询直接取
    // 原始 content，不解码）。
    let windowQueries = 0;
    const originalPrepare = sqlite.prepare.bind(sqlite);
    (sqlite as unknown as { prepare: typeof originalPrepare }).prepare = ((source: string) => {
      if (source.includes('json_each')) windowQueries += 1;
      return originalPrepare(source);
    }) as typeof originalPrepare;

    const page = await readPage(outlineRequest({ limit: 1 }));

    expect(page.items.map((item) => [item.messageId, item.replyPreview])).toEqual([
      ['turn-1', '第一问的回复'],
    ]);
    // 一次范围扫描覆盖本页全部可见行——不随 turn 数量增长，也不为隐藏行发查询。
    expect(windowQueries).toBe(1);
  });

  it('尊重 fromMs 包含边界与 toMs 排除边界', async () => {
    sqlite = createDb();
    insertMessage(sqlite, { id: 'from-boundary', content: '包含', createdAt: 5_000 });
    insertMessage(sqlite, { id: 'inside', content: '包含', createdAt: 5_001 });
    insertMessage(sqlite, { id: 'to-boundary', content: '排除', createdAt: 5_002 });

    const page = await readPage(outlineRequest({ fromMs: 5_000, toMs: 5_002 }));

    expect(page.items.map((item) => item.messageId)).toEqual(['from-boundary', 'inside']);
  });
});
