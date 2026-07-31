/**
 * Device-link 专用的单会话历史读取入口。
 *
 * 该入口只暴露 cindy_helper 已有 history reader 的只读能力，不开放跨会话扫描。
 * 参数在被控端再次校验，避免 allowlist 只能校验 channel、不能校验 payload 的缺口。
 */
import { ipcMain } from 'electron';
import { and, asc, desc, eq, gt, gte, inArray, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import { DL_HISTORY_MESSAGES_CHANNEL } from '@cindy/device-link';

import {
  getMessagesForHistory,
  type GetMessagesParams,
  type HistoryAgentKind,
  type HistoryCursor,
  type HistoryOrder,
  type HistoryRole,
} from '../chatHistoryReader';
import { getDbClient } from '../client/current';
import { isDeviceLinkInvoke } from '../../device-link/invoke-context';
import { assertTrustedAppRendererEvent } from '../../security/trustedAppRenderer';
import { messages, sessions } from '../schema';
import { readLatestSessionTerminal, type SessionTerminalHint } from '../sessionTerminal';
import { requireObject, requireString, throwIpcError } from '../../utils/ipcValidate';
import {
  conversationOutlineEntryFromRow,
  conversationOutlineReplyPreviewFromFollowingRows,
  type ConversationOutlineFollowingRow,
  type ConversationOutlineCursor,
  type ConversationOutlineEntry,
  type ConversationOutlineHistoryPage,
  type ConversationOutlineProjection,
} from '../../../shared/conversationOutline';

const VALID_AGENT_KINDS: readonly HistoryAgentKind[] = ['cc', 'codex'];
const VALID_ORDERS: readonly HistoryOrder[] = ['asc', 'desc'];
const VALID_ROLES: readonly HistoryRole[] = [
  'user',
  'assistant',
  'tool_use',
  'tool_result',
  'ask_user',
  'plan_review',
  'thinking',
];

/** Wire payload accepted by the remote history channel. */
export interface RemoteHistoryMessagesRequest {
  sessionId: string;
  workdir: string | null;
  fromMs: number | null;
  toMs: number | null;
  agentKind: HistoryAgentKind | null;
  roles: HistoryRole[] | null;
  includeRewound: boolean;
  limit: number;
  cursor: HistoryCursor | null;
  order: HistoryOrder;
  /** Additive response projection; omitted means the regular history page. */
  projection?: ConversationOutlineProjection;
  /** Session-reference callers may cap each row before it crosses the relay. Raw MCP reads use null. */
  contentCharLimit: number | null;
}

/** Injectable dependencies keep handler behavior testable without a real Electron DB. */
export interface RemoteHistoryIpcDeps {
  sessionExists(sessionId: string): Promise<boolean>;
  getMessages(params: GetMessagesParams): ReturnType<typeof getMessagesForHistory>;
  readTerminal(sessionId: string, clearedAt: number | null): Promise<SessionTerminalHint | undefined>;
  /** 可选:turn-index 投影不经过 getMessages / readTerminal,见下方 handler。 */
  getTurnIndex?: (request: RemoteHistoryMessagesRequest) => Promise<ConversationOutlineHistoryPage>;
}

function nullableFiniteNumber(value: unknown, name: string): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throwIpcError('INVALID_PARAMS', `${name} must be a finite number or null`);
  }
  return value;
}

function nullableString(value: unknown, name: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') {
    throwIpcError('INVALID_PARAMS', `${name} must be a string or null`);
  }
  return value;
}

function nullableEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  name: string,
): T | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throwIpcError('INVALID_PARAMS', `${name} must be ${allowed.join(' | ')} or null`);
  }
  return value as T;
}

/** Validate an untrusted device-link payload into the history reader contract. */
export function parseRemoteHistoryMessagesRequest(value: unknown): RemoteHistoryMessagesRequest {
  const input = requireObject(value, 'request');
  const sessionId = requireString(input.sessionId, 'sessionId');
  const includeRewound = input.includeRewound;
  if (typeof includeRewound !== 'boolean') {
    throwIpcError('INVALID_PARAMS', 'includeRewound must be a boolean');
  }
  const limit = input.limit;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throwIpcError('INVALID_PARAMS', 'limit must be an integer between 1 and 1000');
  }

  let roles: HistoryRole[] | null = null;
  if (input.roles !== null) {
    if (
      !Array.isArray(input.roles) ||
      input.roles.some(
        (role) => typeof role !== 'string' || !VALID_ROLES.includes(role as HistoryRole),
      )
    ) {
      throwIpcError('INVALID_PARAMS', 'roles contains an unsupported role');
    }
    roles = input.roles as HistoryRole[];
  }

  let cursor: HistoryCursor | null = null;
  if (input.cursor !== null) {
    const rawCursor = requireObject(input.cursor, 'cursor');
    const createdAt = nullableFiniteNumber(rawCursor.createdAt, 'cursor.createdAt');
    if (createdAt === null) {
      throwIpcError('INVALID_PARAMS', 'cursor.createdAt must be a finite number');
    }
    const rowid = rawCursor.rowid;
    if (
      rowid !== undefined &&
      (typeof rowid !== 'number' || !Number.isInteger(rowid) || rowid < 1)
    ) {
      throwIpcError('INVALID_PARAMS', 'cursor.rowid must be a positive integer when provided');
    }
    cursor = {
      createdAt,
      id: requireString(rawCursor.id, 'cursor.id'),
      ...(rowid !== undefined ? { rowid } : {}),
    };
  }

  const order = input.order;
  if (typeof order !== 'string' || !VALID_ORDERS.includes(order as HistoryOrder)) {
    throwIpcError('INVALID_PARAMS', 'order must be asc or desc');
  }
  // 提前解析:下面的 turn-index 守卫要读它们（原先内联在 return 里）。
  const workdir = nullableString(input.workdir, 'workdir');
  const agentKind = nullableEnum(input.agentKind, VALID_AGENT_KINDS, 'agentKind');
  const projection = input.projection === undefined ? 'messages' : input.projection;
  if (projection !== 'messages' && projection !== 'turn-index') {
    throwIpcError('INVALID_PARAMS', 'projection must be messages or turn-index');
  }
  // turn-index 的回复预览按「本页第一条可见 turn 之后」一次范围扫描 + **升序**双指针
  // 分组算出（见 attachTurnReplyPreviews）。desc 下这套分组不成立:范围起点会变成最新
  // 一轮，靠后的 turn 既拿不到窗口、还可能配到别的 turn 的回复。目录只需要 asc，所以
  // 在入口拒掉，而不是让 handler 静默返回错配的预览。
  if (projection === 'turn-index' && order !== 'asc') {
    throwIpcError('INVALID_PARAMS', 'turn-index projection requires order asc');
  }
  // turn-index 的查询把「只要未 rewind 的 user 行」写死在 SQL 里，不消费下面这几个
  // 筛选参数（它们是从常规 history 契约继承来的）。静默忽略比报错难查得多——调用方会
  // 以为筛选生效了，拿到未筛选的结果还不知道，只能靠读实现才发现。所以传了就拒。
  // contentCharLimit 不在此列:它对旧被控端的降级投影仍然有意义(见 makerTransport)。
  if (projection === 'turn-index') {
    if (agentKind !== null) {
      throwIpcError('INVALID_PARAMS', 'turn-index projection does not filter by agentKind');
    }
    if (workdir !== null) {
      throwIpcError('INVALID_PARAMS', 'turn-index projection does not filter by workdir');
    }
    if (includeRewound) {
      throwIpcError('INVALID_PARAMS', 'turn-index projection never returns rewound rows');
    }
    // null = 不筛选,与「本投影只索引 user turn」等价,放行;其它组合(如 ['assistant']
    // 或 ['user','assistant'])一定不会被兑现,拒掉。
    if (roles !== null && (roles.length !== 1 || roles[0] !== 'user')) {
      throwIpcError('INVALID_PARAMS', 'turn-index projection only indexes user turns');
    }
  }
  let contentCharLimit: number | null = null;
  if (input.contentCharLimit !== undefined && input.contentCharLimit !== null) {
    if (
      typeof input.contentCharLimit !== 'number' ||
      !Number.isInteger(input.contentCharLimit) ||
      input.contentCharLimit < 1 ||
      input.contentCharLimit > 8_000
    ) {
      throwIpcError(
        'INVALID_PARAMS',
        'contentCharLimit must be an integer between 1 and 8000 or null',
      );
    }
    contentCharLimit = input.contentCharLimit;
  }

  return {
    sessionId,
    workdir,
    fromMs: nullableFiniteNumber(input.fromMs, 'fromMs'),
    toMs: nullableFiniteNumber(input.toMs, 'toMs'),
    agentKind,
    roles,
    includeRewound,
    limit,
    cursor,
    order: order as HistoryOrder,
    projection,
    contentCharLimit,
  };
}

function contentPreview(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && !Array.isArray(part)) {
          const block = part as Record<string, unknown>;
          return block.type === 'text' && typeof block.text === 'string' ? block.text : '';
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.text === 'string') return record.text;
    if (typeof record.content === 'string') return record.content;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value ?? '');
  }
}

function contentHasOmittedData(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((part) => {
      if (typeof part === 'string') return false;
      if (part && typeof part === 'object' && !Array.isArray(part)) {
        const block = part as Record<string, unknown>;
        return !(block.type === 'text' && typeof block.text === 'string');
      }
      return true;
    });
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.text === 'string' || typeof record.content === 'string') {
      const hasNonEmptyArray = (key: string) =>
        Array.isArray(record[key]) && record[key].length > 0;
      return (
        (Array.isArray(record.images) && record.images.length > 0) ||
        (Array.isArray(record.files) && record.files.length > 0) ||
        hasNonEmptyArray('sessionReferences') ||
        record.quotesEncoded === true ||
        hasNonEmptyArray('pastedTextRanges') ||
        hasNonEmptyArray('slashCommandRanges')
      );
    }
    return true;
  }
  return false;
}

/** Cap per-row reference text before it crosses device-link and mark lossy rows. */
export function capReferenceMessageRows<T extends { content: unknown; agentMeta?: unknown }>(
  items: readonly T[],
  limit: number | null,
  preserveStructuredRoles = false,
): T[] {
  if (limit === null) return [...items];
  return items.map((item) => {
    if (
      preserveStructuredRoles &&
      'role' in item &&
      typeof item.role === 'string' &&
      item.role !== 'user' &&
      item.role !== 'assistant'
    ) {
      return item;
    }
    const text = contentPreview(item.content);
    const textWasTruncated = text.length > limit;
    const omittedData = contentHasOmittedData(item.content);
    if (!textWasTruncated && !omittedData) {
      return typeof item.content === 'string' ? item : ({ ...item, content: text } as T);
    }
    const priorMeta =
      item.agentMeta && typeof item.agentMeta === 'object' && !Array.isArray(item.agentMeta)
        ? (item.agentMeta as Record<string, unknown>)
        : {};
    const content = !textWasTruncated ? text : limit === 1 ? '…' : `…${text.slice(-(limit - 1))}`;
    return {
      ...item,
      content,
      agentMeta: { ...priorMeta, remoteContentTruncated: true },
    } as T;
  });
}

function capReferenceHistoryPage(
  page: Awaited<ReturnType<typeof getMessagesForHistory>>,
  limit: number | null,
  preserveStructuredRoles = false,
): Awaited<ReturnType<typeof getMessagesForHistory>> {
  if (limit === null) return page;
  return {
    ...page,
    items: capReferenceMessageRows(page.items, limit, preserveStructuredRoles),
  };
}

const historyMessageRowid = sql<number>`"messages"."rowid"`;
const TURN_INDEX_FETCH_LIMIT = 256;
/**
 * SQL 层就把回复正文截断，长回复不会整段读进 main 进程。留出比
 * CONVERSATION_OUTLINE_REPLY_PREVIEW_LIMIT 更多的余量，供剥 markdown 标记后
 * 仍能填满预览长度。
 */
const TURN_INDEX_REPLY_SCAN_CHARS = 480;
function historyRowDecodedText(alias: string): SQL {
  const row = sql.identifier(alias);
  return sql`coalesce(
    case
      when not json_valid(${row}."content") then ${row}."content"
      when json_type(${row}."content") = 'text' then json_extract(${row}."content", '$')
      when json_type(${row}."content") in ('integer', 'real', 'true', 'false', 'null')
        then ${row}."content"
      when json_type(${row}."content") = 'array' then (
        -- 顺序用 group_concat 自带的 ORDER BY（SQLite 3.44+）。不要退回"子查询里
        -- ORDER BY 再拼"那个老写法：官方文档明确说 group_concat 的拼接顺序是任意的，
        -- 那种写法只是碰巧可行，查询优化器一变就可能把块顺序拼反（表现为某条 turn 的
        -- 回复预览里两段话颠倒）。本仓打包的 SQLite 是 3.53，官方语法可用。
        select group_concat("decoded_part"."text", char(10) order by "decoded_part"."key")
        from (
          select
            cast("content_part"."key" as integer) as "key",
            case
              when "content_part"."type" = 'text' then "content_part"."value"
              when "content_part"."type" = 'object'
                and json_extract("content_part"."value", '$.type') = 'text'
                and json_type("content_part"."value", '$.text') = 'text'
                then json_extract("content_part"."value", '$.text')
              else null
            end as "text"
          from json_each(${row}."content") as "content_part"
        ) as "decoded_part"
        where "decoded_part"."text" <> ''
      )
      when json_type(${row}."content") = 'object' then case
        when json_type(${row}."content", '$.text') = 'text'
          then json_extract(${row}."content", '$.text')
        when json_type(${row}."content", '$.content') = 'text'
          then json_extract(${row}."content", '$.content')
        else ''
      end
      else ''
    end,
    ''
  )`;
}

type TurnIndexDbRow = {
  id: string;
  clientId: string;
  content: unknown;
  agentMeta: unknown;
  createdAt: number;
  rowid: number;
};


function turnIndexCursor(row: TurnIndexDbRow): ConversationOutlineCursor {
  return {
    createdAt: row.createdAt,
    id: row.id,
    rowid: row.rowid,
  };
}

/**
 * 目录项本体（不含回复预览）。可见性过滤只需要它——隐藏行判定看的是 role、
 * agentMeta 与正文，跟回复无关，所以扫描阶段不必为此取后继行窗口。
 */
function turnIndexEntryBase(row: TurnIndexDbRow): ConversationOutlineEntry | null {
  return conversationOutlineEntryFromRow({
    id: row.id,
    clientId: row.clientId,
    rowid: row.rowid,
    role: 'user',
    content: row.content,
    agentMeta: row.agentMeta,
    createdAt: row.createdAt,
  });
}

/**
 * 每个可见 turn 平均分摊多少条后继行的取数预算。
 *
 * 一轮通常是「1 条 user + 数条 assistant 正文」，4 条足够；给到 12 条是留余量，
 * 遇到 steer 频繁或工具密集的会话也不至于截断。预算耗尽时靠后的 turn 拿不到预览
 * （少显示，不会显示错），不影响正文与目录本体。
 */
const TURN_INDEX_FOLLOWING_ROWS_PER_TURN = 12;

/**
 * 给本页可见 turn 补回复预览。
 *
 * **一次范围扫描 + TS 分组**，不是每个 turn 一次子查询。实测差别很大：3000 轮会话
 * （21000 行）读完整份目录，逐 turn 相关子查询要 1.1s，其中 91% 花在那 3000 次子查询
 * 调用上（与每次取多少行几乎无关——32 条降到 8 条只快 2%）。改成按位置范围一次取
 * 出、在 TS 里按 turn 切片后，同一份数据只需一次索引区间扫描。
 *
 * 分组是纯位置计算：行按 (created_at, rowid) 排序，第 i 个 turn 的窗口 = 它之后、
 * 到**下一个可见 turn（含）**为止的那一段。下一个可见 turn 本身是真实 user 行，正好
 * 充当判定函数的边界；夹在中间的隐藏 user 行（附件-only）也会被一起交出去，由判定
 * 函数按同一套规则处理。
 */
async function attachTurnReplyPreviews(
  db: ReturnType<typeof getDbClient>['drizzle'],
  sessionId: string,
  rows: readonly TurnIndexDbRow[],
): Promise<ConversationOutlineEntry[]> {
  const visible: Array<{ row: TurnIndexDbRow; entry: ConversationOutlineEntry }> = [];
  for (const row of rows) {
    const entry = turnIndexEntryBase(row);
    if (entry) visible.push({ row, entry });
  }
  if (visible.length === 0) return [];

  const first = visible[0].row;
  const following = (await db
    .select({
      role: messages.role,
      // 必须在 SQL 层截断：这一列会为本页每条后继行返回一次，不截断等于把长回复
      // 整段读进 main 进程。截断的代价只是少显示一条预览，方向保守。
      // （主查询的 user 正文刻意不这么做，两边判错的代价不同，见那边的注释。）
      text: sql<string>`substr(${historyRowDecodedText('messages')}, 1, ${TURN_INDEX_REPLY_SCAN_CHARS})`,
      agentMeta: messages.agentMeta,
      createdAt: messages.createdAt,
      rowid: historyMessageRowid,
    })
    .from(messages)
    .where(
      and(
        eq(messages.sessionId, sessionId),
        isNull(messages.rewindAt),
        inArray(messages.role, ['user', 'assistant']),
        or(
          gt(messages.createdAt, first.createdAt),
          and(eq(messages.createdAt, first.createdAt), gt(historyMessageRowid, first.rowid)),
        ),
      ),
    )
    .orderBy(asc(messages.createdAt), asc(historyMessageRowid))
    .limit(visible.length * TURN_INDEX_FOLLOWING_ROWS_PER_TURN)) as Array<
    ConversationOutlineFollowingRow & { role: string; createdAt: number; rowid: number }
  >;

  // 每个可见 turn 在 following 里的起始下标（following 与 visible 都按同一顺序排好，
  // 双指针一次扫完即可，不必对每个 turn 重新查找）。
  const startIndexes: number[] = [];
  let scan = 0;
  for (const { row } of visible) {
    while (
      scan < following.length &&
      (following[scan].createdAt < row.createdAt ||
        (following[scan].createdAt === row.createdAt && following[scan].rowid <= row.rowid))
    ) {
      scan += 1;
    }
    startIndexes.push(scan);
  }

  return visible.map(({ entry }, index) => {
    // 到下一个可见 turn（含）为止；最后一个 turn 取到已取回的末尾。
    const end =
      index + 1 < visible.length ? Math.min(startIndexes[index + 1] + 1, following.length) : following.length;
    const window = following.slice(startIndexes[index], end);
    const replyPreview = conversationOutlineReplyPreviewFromFollowingRows(window);
    return replyPreview ? { ...entry, replyPreview } : entry;
  });
}

function turnIndexCursorCondition(cursor: ConversationOutlineCursor, order: HistoryOrder) {
  const isAscending = order === 'asc';
  const timeAfter = isAscending
    ? gt(messages.createdAt, cursor.createdAt)
    : lt(messages.createdAt, cursor.createdAt);
  const tieBreaker =
    cursor.rowid === undefined
      ? isAscending
        ? gt(messages.id, cursor.id)
        : lt(messages.id, cursor.id)
      : isAscending
        ? gt(historyMessageRowid, cursor.rowid)
        : lt(historyMessageRowid, cursor.rowid);
  return or(timeAfter, and(eq(messages.createdAt, cursor.createdAt), tieBreaker));
}

/**
 * Lightweight turn-index query used by the conversation outline.
 *
 * It intentionally lives beside the existing history IPC instead of opening a
 * second channel: the device-link allowlist and sender/process checks therefore
 * remain exactly the same. Hidden continuation rows are skipped after the
 * keyset page is read, so the cursor still advances even when a page contains
 * only internal prompts.
 */
async function getTurnIndexPage(
  request: RemoteHistoryMessagesRequest,
): Promise<ConversationOutlineHistoryPage> {
  const db = getDbClient().drizzle;
  const [sessionRow] = await db
    .select({ clearedAt: sessions.clearedAt })
    .from(sessions)
    .where(eq(sessions.id, request.sessionId))
    .limit(1);
  if (!sessionRow) throwIpcError('NOT_FOUND', 'Session does not exist');

  const baseConds = [
    eq(messages.sessionId, request.sessionId),
    eq(messages.role, 'user'),
    isNull(messages.rewindAt),
  ];
  const clearBoundary = sessionRow.clearedAt;
  if (clearBoundary !== null) baseConds.push(gt(messages.createdAt, clearBoundary));
  if (request.fromMs !== null) baseConds.push(gte(messages.createdAt, request.fromMs));
  if (request.toMs !== null) baseConds.push(lt(messages.createdAt, request.toMs));

  const orderFn = request.order === 'asc' ? asc : desc;
  const fetchLimit = Math.min(1001, Math.max(TURN_INDEX_FETCH_LIMIT, request.limit + 1));
  const visibleRows: TurnIndexDbRow[] = [];
  let scanCursor = request.cursor;
  const seenScanCursors = new Set<string>();

  // 分页必须全程用同一个 tie-breaker：第一页按 rowid 排，若后续页收到一个不带
  // rowid 的游标就退化成按 id 排，同毫秒那一组的相对顺序就变了，跨页会跳项或
  // 重复。本机链路的游标一定带 rowid，但 wire 上是可选字段（旧被控端的普通
  // HistoryPage 游标就没有），所以这里按 id 反查补齐，把口径钉死在 rowid 上。
  if (scanCursor && scanCursor.rowid === undefined) {
    const [anchor] = await db
      .select({ rowid: historyMessageRowid })
      .from(messages)
      .where(eq(messages.id, scanCursor.id))
      .limit(1);
    if (typeof anchor?.rowid === 'number') scanCursor = { ...scanCursor, rowid: anchor.rowid };
  }

  // 目录项在 JS 层还要过滤 UI_ACTION_TRIGGER/附件-only 行；循环取数直到
  // 拿满可见项或确认数据库已到头，避免隐藏行把 limit/hasMore 算错。
  for (;;) {
    const rows = (await db
      .select({
        id: messages.id,
        clientId: messages.clientId,
        // 与后继行的 text 列刻意不对称：那边在 SQL 就 substr，这边取原始整列。
        // 理由不是"这列更便宜"，而是**判错的代价不同**：
        //  - 后继行每页最多 visible × 12 行、每行都是一整篇回复，不截断等于把长回复
        //    整段搬进 main；而截断的代价只是少显示一条预览（见那边的注释）。
        //  - user 行反过来：判定要过 isSyntheticTriggerText 与"附件-only"（首个非空行
        //    是否为空），截断后若开头恰好是一大段空白，这一 turn 会**从目录里消失**。
        //    另外这里必须交**原始 JSON 串**，不能交 historyRowDecodedText 解码后的文本：
        //    conversationOutlineEntryFromRow 走 decodeStoredContent（只解包一层，见那边
        //    注释），两者对双重编码这类冷门形态并不等价；而 isTruncatedLegacyRow 的兜底
        //    判据是"可见文本以 … 开头"，喂解码后的文本会给原生行错打 previewTruncated。
        // 代价是一次性的：user 正文按页读进来随即释放，不过隧道、不进每 token 路径。
        content: messages.content,
        agentMeta: messages.agentMeta,
        createdAt: messages.createdAt,
        rowid: historyMessageRowid,
      })
      .from(messages)
      .where(
        and(
          ...baseConds,
          ...(scanCursor ? [turnIndexCursorCondition(scanCursor, request.order)] : []),
        ),
      )
      .orderBy(
        orderFn(messages.createdAt),
        orderFn(!scanCursor || scanCursor.rowid !== undefined ? historyMessageRowid : messages.id),
      )
      .limit(fetchLimit)) as TurnIndexDbRow[];

    if (rows.length === 0) {
      return {
        items: await attachTurnReplyPreviews(db, request.sessionId, visibleRows),
        nextCursor: null,
        hasMore: false,
      };
    }

    for (const row of rows) {
      // 只判可见性，不取窗口。
      if (!turnIndexEntryBase(row)) continue;
      if (visibleRows.length < request.limit) {
        visibleRows.push(row);
        continue;
      }

      // 找到第 limit+1 个可见项，游标必须停在第 limit 项，不能跳过下一项。
      return {
        items: await attachTurnReplyPreviews(db, request.sessionId, visibleRows),
        nextCursor: turnIndexCursor(visibleRows[visibleRows.length - 1]),
        hasMore: true,
      };
    }

    // 没有额外可见项时，只有满页才可能还有下一批原始行。
    if (rows.length < fetchLimit) {
      return { items: await attachTurnReplyPreviews(db, request.sessionId, visibleRows), nextCursor: null, hasMore: false };
    }

    const lastRawRow = rows[rows.length - 1];
    scanCursor = turnIndexCursor(lastRawRow);
    const cursorKey = JSON.stringify(scanCursor);
    if (seenScanCursors.has(cursorKey)) {
      // 防御异常数据库/驱动重复返回同一页，避免远程请求卡死。
      return { items: await attachTurnReplyPreviews(db, request.sessionId, visibleRows), nextCursor: null, hasMore: false };
    }
    seenScanCursors.add(cursorKey);
  }
}

const defaultSessionExists = async (sessionId: string): Promise<boolean> => {
  const rows = await getDbClient().drizzle
    .select({ id: sessions.id })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  return rows.length > 0;
};

const defaultDeps: RemoteHistoryIpcDeps = {
  sessionExists: defaultSessionExists,
  getMessages: getMessagesForHistory,
  readTerminal: readLatestSessionTerminal,
  getTurnIndex: getTurnIndexPage,
};

/** Register the allowlisted, read-only remote history handler. */
export function registerRemoteHistoryIpc(deps: RemoteHistoryIpcDeps = defaultDeps): void {
  ipcMain.handle(DL_HISTORY_MESSAGES_CHANNEL, async (event, value: unknown) => {
    // 本 handler 原先只服务 device-link；目录投影把它首次暴露给 Renderer，属于
    // 「给旧 handler 扩展新的特权能力」，按 electron-security-and-process-boundaries
    // §5 必须验证 sender 来自 Cindy 自有顶层 frame（该节明确不接受「旧代码没校验」
    // 作为省略理由）。
    //
    // 不能无条件断言：device-link 经 dispatchLocalInvoke 复用本机 handler 时传的是
    // 合成 event，没有 senderFrame / BrowserWindow，断言必然失败。用 AsyncLocalStorage
    // 标记区分两条来源——它由主进程自己设置，Renderer 无法伪造。
    if (!isDeviceLinkInvoke()) {
      assertTrustedAppRendererEvent(event);
    }
    const request = parseRemoteHistoryMessagesRequest(value);
    if (!(await deps.sessionExists(request.sessionId))) {
      throwIpcError('NOT_FOUND', 'Session does not exist');
    }
    if (request.projection === 'turn-index') {
      return (deps.getTurnIndex ?? getTurnIndexPage)(request);
    }
    const page = await deps.getMessages({
      sessionIds: [request.sessionId],
      workdir: request.workdir,
      fromMs: request.fromMs,
      toMs: request.toMs,
      agentKind: request.agentKind,
      roles: request.roles,
      includeRewound: request.includeRewound,
      limit: request.limit,
      cursor: request.cursor,
      order: request.order,
    });
    // 终态标记与页面读取在同一次 handler 调用内完成:跨设备调用方拿到的
    // terminal 与消息快照来自同一数据库时刻(与本机解析路径的两查询间隔
    // 同价),不会出现「历史页读完、再探测时源端已写入更新回合的错误行」
    // 导致的终态错配。错误正文不出被控端,只回安全标记。
    // 页面下界是 gte(fromMs),终态探针是 gt(clearedAt)——同一窗口需 fromMs-1。
    const terminal = await deps.readTerminal(
      request.sessionId,
      request.fromMs === null ? null : request.fromMs - 1,
    );
    const preserveStructuredRoles =
      request.roles === null ||
      request.roles.some((role) => role !== 'user' && role !== 'assistant');
    return {
      ...capReferenceHistoryPage(page, request.contentCharLimit, preserveStructuredRoles),
      terminal: terminal ?? null,
    };
  });
}
