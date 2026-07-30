/**
 * 对话大纲的跨进程数据契约与纯函数。
 *
 * 目录只需要 user turn 的锚点、时间和一小段预览，不应把完整消息内容
 * （尤其是 tool 输出、附件和引用快照）带进 renderer。这个文件同时被
 * main 的历史投影和 renderer 的兼容降级路径使用，避免两边各自解析出不同
 * 的目录项。
 */

import {
  CONTINUE_AFTER_APP_EXIT_PROMPT,
  CONTINUE_AFTER_ERROR_PROMPT,
  isSyntheticTriggerText,
} from './interruptedTurn';
import { normalizeRegionalMoney } from './regionalMoney';

export type ConversationOutlineProjection = 'messages' | 'turn-index';

export interface ConversationOutlineCursor {
  createdAt: number;
  id: string;
  rowid?: number;
}

export interface ConversationOutlineHistoryRequest {
  sessionId: string;
  workdir: string | null;
  fromMs: number | null;
  toMs: number | null;
  agentKind: 'cc' | 'codex' | null;
  roles: ['user'] | null;
  includeRewound: false;
  limit: number;
  cursor: ConversationOutlineCursor | null;
  order: 'asc';
  /**
   * `turn-index` is an additive projection on the existing history channel.
   * Older hosts ignore this field and return the regular HistoryPage shape;
   * renderer code deliberately accepts both shapes.
   */
  projection?: ConversationOutlineProjection;
  contentCharLimit: number | null;
}

export interface ConversationOutlineEntry {
  /** messages.id; used as the authoritative around-message anchor. */
  messageId: string;
  /** Present on new hosts; optional for old-host compatibility. */
  clientId?: string;
  /** SQLite insertion order, retained so same-millisecond turns keep DB order. */
  rowid?: number;
  /** Unix milliseconds. */
  createdAt: number;
  /** A bounded, attachment-free preview of the user turn. */
  preview: string;
  /**
   * 该 turn 第一条 assistant 正文的开头，供 tooltip 补充上下文。
   * 老主机的降级投影不提供，因此始终可选；空字符串一律不落字段。
   */
  replyPreview?: string;
  /**
   * 预览来自旧主机的**保尾**裁剪（`…尾部`），与本地乐观项的头部预览不可比。
   * 合并时据此改用按时间的一对一配对，避免同一 turn 出现两根刻度。
   */
  previewTruncated?: true;
}

export interface ConversationOutlineHistoryPage {
  items: ConversationOutlineEntry[];
  nextCursor: ConversationOutlineCursor | null;
  hasMore: boolean;
}

/**
 * The regular history projection has a wider row shape. Keep this input
 * intentionally structural so it can also consume a response from an older
 * controlled device without importing main-process types into renderer code.
 */
export interface ConversationOutlineRow {
  id?: unknown;
  messageId?: unknown;
  clientId?: unknown;
  rowid?: unknown;
  role?: unknown;
  content?: unknown;
  preview?: unknown;
  replyPreview?: unknown;
  agentMeta?: unknown;
  createdAt?: unknown;
}

const DEFAULT_PREVIEW_LIMIT = 140;
/** tooltip 只显示两行，取头部即可；同时限制远程 payload 的增量。 */
export const CONVERSATION_OUTLINE_REPLY_PREVIEW_LIMIT = 160;
const KNOWN_SYNTHETIC_TRIGGER_PROMPTS = [
  CONTINUE_AFTER_APP_EXIT_PROMPT,
  CONTINUE_AFTER_ERROR_PROMPT,
] as const;

function parseJsonString(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function contentText(value: unknown): string {
  if (typeof value === 'string') {
    const parsed = parseJsonString(value);
    if (parsed === value) return value;
    // ChatMessage.content 已经是用户可见字符串；像 "1" / "true" / "null"
    // 这样的纯文本恰好也是合法 JSON 标量，不能解析后当成无文本丢掉。
    // 对象/数组和被 JSON 字符串包裹的结构仍继续递归解码。
    if (parsed === null || typeof parsed === 'number' || typeof parsed === 'boolean') {
      return value;
    }
    return contentText(parsed);
  }
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && !Array.isArray(part)) {
          const record = part as Record<string, unknown>;
          return record.type === 'text' && typeof record.text === 'string' ? record.text : '';
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
  return '';
}

function agentMetaRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    const parsed = parseJsonString(value);
    value = parsed;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/**
 * 旧主机的 regular history 裁剪策略保留文本尾部。若隐藏续跑指令超过
 * 该上限，`[UI_ACTION_TRIGGER]` 前缀会消失；用已知完整指令的尾部做兼容
 * 判定，避免把系统提示渲染进目录。长度门槛防止省略号后极短的普通文本误判。
 */
function isSyntheticTriggerPreview(text: string): boolean {
  if (isSyntheticTriggerText(text)) return true;
  if (!text.startsWith('…')) return false;
  const truncatedSuffix = text.slice(1);
  if (truncatedSuffix.length < 32) return false;
  return KNOWN_SYNTHETIC_TRIGGER_PROMPTS.some((prompt) => prompt.endsWith(truncatedSuffix));
}

/**
 * 按 `\r?\n` 逐行遍历，不为整段正文物化行数组。
 *
 * 下面两个预览函数在流式期间会被**每个 turn** 各调用一次（乐观目录随 messages
 * 引用变化重算，见 useConversationOutline），而它们都只要开头一小段。
 * `split(/\r?\n/)` 会把整段正文——可能是几十 KB 的粘贴日志或一整篇长回复——切成
 * 完整数组再逐行跑正则，取完首行就全丢掉。
 *
 * 语义与 `split(/\r?\n/)` 严格一致:单独的 `\r` 不是分隔符，留在行内交给调用方的
 * `\s+` 归一。
 */
function* eachLine(text: string): Generator<string> {
  let start = 0;
  for (;;) {
    const breakIndex = text.indexOf('\n', start);
    const end = breakIndex < 0 ? text.length : breakIndex;
    const withoutCr = end > start && text.charCodeAt(end - 1) === 13 ? end - 1 : end;
    yield text.slice(start, withoutCr);
    if (breakIndex < 0) return;
    start = breakIndex + 1;
  }
}

/**
 * Turn preview extraction is deliberately conservative:
 * - only the first non-empty line is shown in the rail;
 * - whitespace and attachment-only blocks disappear;
 * - hidden UI trigger prompts never cross into user-facing text.
 */
export function normalizeConversationOutlinePreview(
  value: unknown,
  maxChars = DEFAULT_PREVIEW_LIMIT,
): string {
  const text = contentText(value);
  if (!text || isSyntheticTriggerPreview(text)) return '';
  // 归一到拿到第一条非空行为止:后面的行不参与显示，不必逐行跑正则。
  let firstLine = '';
  for (const line of eachLine(text)) {
    firstLine = line.replace(/\s+/g, ' ').trim();
    if (firstLine) break;
  }
  if (!firstLine) return '';
  if (firstLine.length <= maxChars) return firstLine;
  if (maxChars <= 1) return '…';
  return `${firstLine.slice(0, maxChars - 1)}…`;
}

/**
 * 回复预览在 tooltip 里当成连续两行读，所以不保留 markdown 结构：行首的
 * 标题/引用/列表标记与成对强调符号剥掉，多行折成一段。只处理行首标记和
 * 成对符号，不解析 markdown——预览多剥一个星号无所谓，吞掉正文才是问题。
 */
function stripMarkdownNoise(line: string): string {
  return line
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s*|[-*+]\s+|\d{1,3}[.)]\s+)/, '')
    .replace(/\*\*|__|`/g, '')
    .trim();
}

/**
 * assistant 回复的头部预览。与 user 预览的差异是刻意的：user 只取首行（一条
 * 提问的第一行就是它的标题），回复的首行常是 markdown 标题或列表项，单独拿
 * 出来读不通，所以折成一段连续文本交给 UI 的 line-clamp 裁剪。
 */
export function normalizeConversationOutlineReplyPreview(
  value: unknown,
  maxChars = CONVERSATION_OUTLINE_REPLY_PREVIEW_LIMIT,
): string {
  const text = contentText(value);
  if (!text || isSyntheticTriggerPreview(text)) return '';
  // 攒过 maxChars 就停:再往后折行只会被下面的 slice 丢掉，而"要不要加省略号"这个
  // 唯一还需要的信息，长度一旦**严格大于** maxChars 就已经定了（恰好等于 maxChars
  // 时还得继续看后面有没有行，所以判据不能放宽成 >=）。
  let collapsed = '';
  for (const line of eachLine(text)) {
    const stripped = stripMarkdownNoise(line.replace(/\s+/g, ' '));
    if (!stripped) continue;
    collapsed = collapsed ? `${collapsed} ${stripped}` : stripped;
    if (collapsed.length > maxChars) break;
  }
  if (!collapsed) return '';
  if (collapsed.length <= maxChars) return collapsed;
  if (maxChars <= 1) return '…';
  return `${collapsed.slice(0, maxChars - 1)}…`;
}

/**
 * 旧主机 regular history 对超过 contentCharLimit 的正文是**保尾**裁剪
 * （`'…' + text.slice(-(limit - 1))`，见 history.ts 的 capReferenceMessageRows），
 * 同时打上 `agentMeta.remoteContentTruncated`。而本地乐观项取的是正文**头部**，
 * 两者必然不相等——所以这类行不能用「预览文本相同」去和乐观项配对，需要靠这个
 * 标记改走按时间的一对一配对。
 */
export function isTruncatedLegacyRow(row: ConversationOutlineRow): boolean {
  const meta = agentMetaRecord(row.agentMeta);
  if (meta?.remoteContentTruncated === true) return true;
  // 没有 agentMeta 的更老 payload：保尾裁剪必然以省略号开头，作为兜底判据。
  const visibleText = row.preview !== undefined ? row.preview : row.content;
  return typeof visibleText === 'string' && visibleText.startsWith('…');
}

/**
 * 一条 turn 之后的「后继行」——SQL 只负责按时间取出这些原始行，所有判定在这里做。
 *
 * 这是把判据收口到一处的接口：SQL 侧曾经自己实现过「哪算 user 边界、哪算收尾、
 * 哪算有正文」，结果与本文件的判据反复走偏（前缀匹配语义、NULL 传播、空 system
 * card、markdown-only…）。现在 SQL 只做粗筛（按时间取 user / assistant 行），
 * 判定全部复用下面这些函数。
 */
export interface ConversationOutlineFollowingRow {
  role?: unknown;
  /** content 解码后的正文（SQL 侧只做 JSON 形态解码与长度截断，不做业务判定）。 */
  text?: unknown;
  agentMeta?: unknown;
}

/**
 * 这一行是否是下一个真实 turn 的开头（逻辑 user 边界）。
 *
 * steer（运行中追加）、autoResume 与 `[UI_ACTION_TRIGGER]` 续跑指令都是 role='user'
 * 且落在真实 user 与它的 assistant 之间，不能算边界。附件-only 行正文为空但**是**
 * 真实提问，仍算边界——所以这里只看 role 与续跑标记，不看正文是否为空。
 */
export function isConversationOutlineTurnBoundary(row: ConversationOutlineFollowingRow): boolean {
  if (row.role !== 'user') return false;
  const meta = agentMetaRecord(row.agentMeta);
  if (meta?.autoResume === true || meta?.delivery === 'steer') return false;
  const text = contentText(row.text);
  return !isSyntheticTriggerText(text);
}

/**
 * 这条 assistant 是否携带 turn 收尾标记（SDK done 边界的 seal）。
 *
 * 三种形态与 renderer 的推导一致：新数据用 `turnCompleted`；存量会话没有该字段但
 * 有收尾金额，`turnCost`（RegionalMoney，复用 normalizeRegionalMoney 校验形态）或
 * 更老的 `turnCostUsd` 都可等价推导。
 */
export function conversationOutlineAssistantSealsTurn(
  row: ConversationOutlineFollowingRow,
): boolean {
  if (row.role !== 'assistant') return false;
  const meta = agentMetaRecord(row.agentMeta);
  if (!meta) return false;
  if (meta.turnCompleted === true) return true;
  const money = normalizeRegionalMoney(meta.turnCost);
  if (money) return money.amount > 0;
  return typeof meta.turnCostUsd === 'number' && Number.isFinite(meta.turnCostUsd)
    ? meta.turnCostUsd > 0
    : false;
}

/**
 * 从后继行里算出该 turn 的回复预览。
 *
 * 规则：
 *   1. 扫到下一个逻辑 user 边界就停——不越界到下一轮；
 *   2. 取**第一条能产出非空预览**的 assistant 正文（空 system card、只有 markdown
 *      标记、只有空白的行都跳过，继续往后找）；
 *   3. 必须有「这一轮已经结束」的证据才展示。两种证据等价：
 *      - 区间内出现带 seal 的 assistant（SDK done 边界）；
 *      - **后面还有真实 user turn** —— 用户已经问下一个问题了，这轮显然结束了。
 *
 * 第 3 条为什么要两种证据：`turnCompleted` 是较新的机制，存量会话的 assistant 行
 * 可能既没有它、也没有可推导的收尾金额（无费用数据的会话）。只认 seal 会让**所有
 * 历史 turn** 都拿不到回复预览——2026-07-29 实机就是这个现象。而「有后续 user turn」
 * 对历史数据永远成立，只有正在跑的最后一轮拿不到，这恰好是我们想要的：
 * 流式期间不展示半截回复。
 *
 * 取行窗口被上限截断时不需要额外处理：窗口内没看到 seal 也没看到边界，本来就返回空，
 * 与"还在跑"的处置一致。代价是极端情况（一轮里有 32 条以上 assistant 正文行、且没有
 * seal、边界恰好落在窗口外）会少显示一条预览——保守方向，可接受。
 */
export function conversationOutlineReplyPreviewFromFollowingRows(
  rows: readonly ConversationOutlineFollowingRow[],
): string {
  let preview = '';
  let sealed = false;
  for (const row of rows) {
    // 遇到下一轮的开头：这一轮已经结束，无论有没有 seal 都可以展示它说过的话。
    if (isConversationOutlineTurnBoundary(row)) return preview;
    if (row.role !== 'assistant') continue;
    if (!preview) preview = normalizeConversationOutlineReplyPreview(row.text);
    if (!sealed) sealed = conversationOutlineAssistantSealsTurn(row);
  }
  return sealed ? preview : '';
}

export function isHiddenConversationOutlineRow(row: ConversationOutlineRow): boolean {
  if (row.role !== undefined && row.role !== 'user') return true;
  const meta = agentMetaRecord(row.agentMeta);
  // steer 会在正文消息流中保留，但产品目录只索引独立 user turn。
  if (meta?.autoResume === true || meta?.delivery === 'steer') return true;
  // Native turn-index rows carry only `preview`; legacy history rows carry
  // `content`.  Prefer the projection when present so new rows are not
  // mistaken for attachment-only hidden rows.
  const visibleText = row.preview !== undefined ? row.preview : row.content;
  return normalizeConversationOutlinePreview(visibleText) === '';
}

/** Convert either a native turn-index row or an old regular history row. */
export function conversationOutlineEntryFromRow(
  row: ConversationOutlineRow,
): ConversationOutlineEntry | null {
  if (isHiddenConversationOutlineRow(row)) return null;
  const rawId = row.messageId ?? row.id;
  if (typeof rawId !== 'string' || rawId.length === 0) return null;
  const createdAt =
    typeof row.createdAt === 'number'
      ? row.createdAt
      : typeof row.createdAt === 'string'
        ? new Date(row.createdAt).getTime()
        : Number.NaN;
  if (!Number.isFinite(createdAt)) return null;
  const preview =
    typeof row.preview === 'string'
      ? normalizeConversationOutlinePreview(row.preview)
      : normalizeConversationOutlinePreview(row.content);
  if (!preview) return null;
  const replyPreview = normalizeConversationOutlineReplyPreview(row.replyPreview);
  return {
    messageId: rawId,
    ...(typeof row.clientId === 'string' && row.clientId.length > 0
      ? { clientId: row.clientId }
      : {}),
    ...(typeof row.rowid === 'number' && Number.isInteger(row.rowid) && row.rowid > 0
      ? { rowid: row.rowid }
      : {}),
    createdAt,
    preview,
    ...(replyPreview ? { replyPreview } : {}),
    ...(isTruncatedLegacyRow(row) ? { previewTruncated: true as const } : {}),
  };
}

/**
 * Normalize, de-duplicate and order entries from one or more pages. The
 * message id is the primary key; clientId is only a convenience on new hosts.
 */
export function buildConversationOutline(
  rows: readonly ConversationOutlineRow[],
): ConversationOutlineEntry[] {
  const byMessageId = new Map<string, ConversationOutlineEntry>();
  for (const row of rows) {
    const entry = conversationOutlineEntryFromRow(row);
    if (!entry) continue;
    const existing = byMessageId.get(entry.messageId);
    if (!existing || entry.createdAt >= existing.createdAt) {
      byMessageId.set(entry.messageId, entry);
    }
  }
  return [...byMessageId.values()].sort(
    (a, b) =>
      a.createdAt - b.createdAt ||
      (a.rowid ?? Number.MAX_SAFE_INTEGER) - (b.rowid ?? Number.MAX_SAFE_INTEGER) ||
      a.messageId.localeCompare(b.messageId),
  );
}

/** 至少四个 user turn 后显示目录，避免短对话增加视觉噪音。 */
export const CONVERSATION_OUTLINE_MIN_TURNS = 4;

export function shouldShowConversationOutline(
  entries: readonly ConversationOutlineEntry[],
  minimum = CONVERSATION_OUTLINE_MIN_TURNS,
): boolean {
  return entries.length >= minimum;
}
