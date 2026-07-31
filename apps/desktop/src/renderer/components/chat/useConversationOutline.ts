import { useEffect, useMemo, useRef, useState } from 'react';

import type { ChatMessage } from '@/lib/makerChatStore';
import { createLogger } from '@/lib/logger';
import {
  listConversationOutlinePageFor,
  type ConversationOutlineLoadResult,
} from '@/lib/makerTransport';
import {
  conversationOutlineReplyPreviewFromFollowingRows,
  isConversationOutlineTurnBoundary,
  normalizeConversationOutlinePreview,
  type ConversationOutlineFollowingRow,
  type ConversationOutlineCursor,
  type ConversationOutlineEntry,
} from '../../../shared/conversationOutline';

const log = createLogger('conversation-outline');
const OPTIMISTIC_MESSAGE_ID_PREFIX = 'client:';
const EMPTY_OUTLINE_ENTRIES: readonly ConversationOutlineEntry[] = [];

export interface UseConversationOutlineOptions {
  sessionId?: string;
  clearedAt?: string | number | null;
  remoteDeviceId?: string;
  enabled: boolean;
  messages: readonly ChatMessage[];
}

export function isOptimisticConversationOutlineMessageId(messageId: string): boolean {
  return messageId.startsWith(OPTIMISTIC_MESSAGE_ID_PREFIX);
}

function isRealUserTurn(message: ChatMessage): boolean {
  return (
    message.role === 'user' &&
    message.delivery !== 'steer' &&
    !message.isSyntheticTrigger &&
    !message.systemCardType &&
    !message.blockedByGhost
  );
}

/**
 * 该 turn 的回复预览。
 *
 * 判定**不在这里实现**——把内存消息映射成后继行，交给
 * `conversationOutlineReplyPreviewFromFollowingRows`。main 的 DB 投影用的是同一个
 * 函数，两侧因此不可能再走偏（此前在前缀匹配、空 system card、未收尾等六处偏过）。
 *
 * store 侧还知道一些 DB 行上没有的信息（`systemCardType`、`blockedByGhost`），这些
 * 一并由 `isRealUserTurn` 判完，再用判定函数认得的 `autoResume` 表达「这条 user 行
 * 不是新的一轮」。这样"边界意味着什么"仍然只有共享函数一处定义。
 */
function replyPreviewForTurn(messages: readonly ChatMessage[], turnIndex: number): string {
  const following: ConversationOutlineFollowingRow[] = [];
  for (let index = turnIndex + 1; index < messages.length; index += 1) {
    const message = messages[index];
    const row: ConversationOutlineFollowingRow = {
      role: message.role,
      text: message.content,
      agentMeta:
        message.role === 'user' && !isRealUserTurn(message)
          ? { autoResume: true }
          : { ...(message.turnCompleted === true ? { turnCompleted: true } : {}) },
    };
    following.push(row);
    // 判定函数扫到边界就返回，边界之后的行不可能影响结果 —— 攒到边界即止。
    // 原先一直 push 到消息数组末尾:本函数对每个 turn 各跑一次，而整份乐观目录随
    // messages 引用变化在**每批流式 delta** 上重算，那是 O(turn 数 × 消息数)。
    // 不写成「遇到 isRealUserTurn 就停」——那等于在这里重新实现一遍边界判据，与本
    // 文件的分工相反（见上面的注释），也可能和 agentMeta 里的表达走偏。
    if (isConversationOutlineTurnBoundary(row)) break;
  }
  return conversationOutlineReplyPreviewFromFollowingRows(following);
}

/**
 * 当前消息切片只用于乐观补齐新 turn，不能替代数据库索引。ChatMessage 不携带
 * messages.id，因此临时锚点以 clientId 标记；落库投影回来后会被权威项替换。
 */
export function optimisticConversationOutlineFromMessages(
  messages: readonly ChatMessage[],
): ConversationOutlineEntry[] {
  const entries: ConversationOutlineEntry[] = [];
  messages.forEach((message, index) => {
    if (!isRealUserTurn(message)) return;
    const preview = normalizeConversationOutlinePreview(message.content);
    const createdAt = message.createdAt ? Date.parse(message.createdAt) : Number.NaN;
    if (!preview || !Number.isFinite(createdAt)) return;
    const replyPreview = replyPreviewForTurn(messages, index);
    entries.push({
      messageId: `${OPTIMISTIC_MESSAGE_ID_PREFIX}${message.clientId}`,
      clientId: message.clientId,
      ...(message.rowid ? { rowid: message.rowid } : {}),
      createdAt,
      preview,
      ...(replyPreview ? { replyPreview } : {}),
    });
  });
  return entries;
}

function compareOutlineEntries(a: ConversationOutlineEntry, b: ConversationOutlineEntry): number {
  return (
    a.createdAt - b.createdAt ||
    (a.rowid ?? Number.MAX_SAFE_INTEGER) - (b.rowid ?? Number.MAX_SAFE_INTEGER) ||
    a.messageId.localeCompare(b.messageId)
  );
}

function cursorFromOutlineEntry(entry: ConversationOutlineEntry): ConversationOutlineCursor {
  return {
    createdAt: entry.createdAt,
    id: entry.messageId,
    ...(entry.rowid !== undefined ? { rowid: entry.rowid } : {}),
  };
}

/** 合并一段增量权威项，按 messageId 去重并保持目录时间顺序。 */
function mergeAuthoritativeOutlineEntries(
  current: readonly ConversationOutlineEntry[],
  incoming: readonly ConversationOutlineEntry[],
): ConversationOutlineEntry[] {
  const byMessageId = new Map<string, ConversationOutlineEntry>();
  current.forEach((entry) => byMessageId.set(entry.messageId, { ...entry }));
  incoming.forEach((entry) => byMessageId.set(entry.messageId, { ...entry }));
  return [...byMessageId.values()].sort(compareOutlineEntries);
}

function outlineEntriesEqual(
  left: readonly ConversationOutlineEntry[],
  right: readonly ConversationOutlineEntry[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every((entry, index) => {
    const other = right[index];
    return (
      entry.messageId === other?.messageId &&
      entry.clientId === other.clientId &&
      entry.rowid === other.rowid &&
      entry.createdAt === other.createdAt &&
      entry.preview === other.preview &&
      entry.replyPreview === other.replyPreview
    );
  });
}

function outlineEntryIdentityEqual(
  left: ConversationOutlineEntry,
  right: ConversationOutlineEntry | undefined,
): boolean {
  if (!right) return false;
  return (left.clientId ?? left.messageId) === (right.clientId ?? right.messageId);
}

/** 只比较 user turn 身份与顺序；落库字段和回复预览变化不属于结构变化。 */
function outlineEntryStructureEqual(
  left: readonly ConversationOutlineEntry[],
  right: readonly ConversationOutlineEntry[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every((entry, index) => outlineEntryIdentityEqual(entry, right[index]));
}

export type OutlineStructureChange = 'history-filled' | 'tail-appended' | 'diverged';

/**
 * 判定 user turn 序列这次是怎么变的，据此决定要不要重读权威目录。
 *
 * 判据是**有序子序列**而不是连续块：store 明确允许窗口里同时存在多个稀疏消息岛
 * （`makerChatStore` 里 historyWindowHasIsland 的注释写明「到达本次目标只证明尾部 →
 * 本目标连续，不证明更早的孤岛都被跨过」）。于是 `[c1, c4] → [c1, c2, c4]` 这种
 * 「往两个岛之间补历史」是正常状态，按连续块判会被误判成破坏性变更、白重读整份。
 *
 *   - `history-filled` 旧项都还在且相对顺序不变，最后一个旧项之后没有新项 →
 *     只是在前部或岛之间补了旧历史。权威目录首次已从会话头读全，这些 turn 本来
 *     就在里面，**不必发任何请求**。
 *   - `tail-appended` 旧项都还在，且最后一个旧项之后出现了新项 → 尾部真有新 turn，
 *     从尾游标增量读一次。
 *   - `diverged`      旧项有缺失或相对顺序变了（删除 / rewind / 换序）→ 尾游标不再
 *     可信，清空后全量重建，否则消失的那一项会永久残留在导轨上。
 *
 * 贪心两指针即可判定子序列存在性（最早匹配是最优策略）；clientId 唯一，无歧义。
 */
export function classifyOutlineStructureChange(
  previous: readonly ConversationOutlineEntry[],
  next: readonly ConversationOutlineEntry[],
): OutlineStructureChange {
  let scan = 0;
  let lastMatchedIndex = -1;
  for (const entry of previous) {
    let matchedIndex = -1;
    while (scan < next.length) {
      const candidate = next[scan];
      scan += 1;
      if (outlineEntryIdentityEqual(entry, candidate)) {
        matchedIndex = scan - 1;
        break;
      }
    }
    if (matchedIndex < 0) return 'diverged';
    lastMatchedIndex = matchedIndex;
  }
  return lastMatchedIndex < next.length - 1 ? 'tail-appended' : 'history-filled';
}

/**
 * clientId 相同表示同一条 user turn。此时保留数据库 messageId/rowid 作为跳转
 * 锚点，只用内存消息覆盖预览文本，避免乐观项和权威项在 rail 上重复出现。
 *
 * 旧主机权威项没有 clientId，与已加载消息匹配后要把它回填，供
 * 导轨将正文 DOM 节点映射回目录项。回复预览只在乐观侧非空时才覆盖：
 * turn 未收尾的乐观项恒为空，不能因此把数据库已投影出来的历史回复预览擦掉。
 */
export function mergeConversationOutlineEntries(
  authoritative: readonly ConversationOutlineEntry[],
  optimistic: readonly ConversationOutlineEntry[],
): ConversationOutlineEntry[] {
  const merged = authoritative.map((entry) => ({ ...entry }));
  const indexByClientId = new Map<string, number>();
  const indexByMessageId = new Map<string, number>();
  merged.forEach((entry, index) => {
    if (entry.clientId) indexByClientId.set(entry.clientId, index);
    indexByMessageId.set(entry.messageId, index);
  });

  // 旧主机的**保尾裁剪**行（正文超过 contentCharLimit 时预览是 `…尾部`）与乐观项的
  // 头部预览永远不相等，靠文本配不上，同一 turn 会出现两根刻度、active 映射也会错。
  // 这类行按 createdAt 分组、组内按目录顺序做一对一配对：两侧都以 (createdAt, rowid)
  // 排序，同毫秒组内的第 k 项必然对应同一条 turn。用完即出队，保证一对一。
  const truncatedLegacyQueueByCreatedAt = new Map<number, number[]>();
  // 未被裁剪的 legacy 项按「createdAt + 预览」预建索引队列。
  //
  // 预建而不是循环里逐次 merged.findIndex：旧主机的权威项没有 clientId，于是**每个**
  // 乐观项都会走到这条匹配，逐次全量扫描是 O(权威项数 × 乐观项数)——上千 turn 的会话
  // 每次 merge 都要扫上百万次（Copilot review）。
  //
  // 与旧写法语义等价，不是行为变更：findIndex 扫的是**正在被修改**的数组，配对成功的
  // 权威项会被回填 clientId、从而被 `!candidate.clientId` 自动排除，所以一对一本来就
  // 成立。队列按下标顺序各消费一次，结果相同——变的只有复杂度。
  //
  // 两个队列按构造互斥（这里排除 previewTruncated），避免同一个下标被两条路径各消费
  // 一次。保尾裁剪项的预览是尾部，本就不该被「头部预览完全相同」命中。
  const legacyExactQueueByKey = new Map<string, number[]>();
  const legacyExactKey = (createdAt: number, preview: string): string =>
    `${createdAt}\u0000${preview}`;
  merged.forEach((entry, index) => {
    if (entry.clientId) return;
    if (entry.previewTruncated === true) {
      const queue = truncatedLegacyQueueByCreatedAt.get(entry.createdAt);
      if (queue) queue.push(index);
      else truncatedLegacyQueueByCreatedAt.set(entry.createdAt, [index]);
      return;
    }
    const key = legacyExactKey(entry.createdAt, entry.preview);
    const queue = legacyExactQueueByKey.get(key);
    if (queue) queue.push(index);
    else legacyExactQueueByKey.set(key, [index]);
  });

  for (const entry of optimistic) {
    let existingIndex =
      (entry.clientId ? indexByClientId.get(entry.clientId) : undefined) ??
      indexByMessageId.get(entry.messageId);
    if (existingIndex === undefined) {
      // 旧主机权威项没有 clientId：先试「时间 + 预览完全相同」（未被裁剪的短消息走
      // 这条），失败再从截断队列里按顺序取一个。顺序很重要——只有前两级都配不上时
      // 才消耗队列，否则会白占一个槽位、把真正该配对的那条挤成重复刻度。
      existingIndex =
        legacyExactQueueByKey.get(legacyExactKey(entry.createdAt, entry.preview))?.shift() ??
        truncatedLegacyQueueByCreatedAt.get(entry.createdAt)?.shift();
    }
    if (existingIndex !== undefined) {
      // 新主机的权威 clientId 优先；只在 legacy 项缺失时用已加载消息补齐。
      const resolvedClientId = merged[existingIndex].clientId ?? entry.clientId;
      merged[existingIndex] = {
        ...merged[existingIndex],
        ...(resolvedClientId ? { clientId: resolvedClientId } : {}),
        preview: entry.preview,
        ...(entry.replyPreview ? { replyPreview: entry.replyPreview } : {}),
      };
      if (resolvedClientId) indexByClientId.set(resolvedClientId, existingIndex);
      continue;
    }
    const index = merged.push({ ...entry }) - 1;
    if (entry.clientId) indexByClientId.set(entry.clientId, index);
    indexByMessageId.set(entry.messageId, index);
  }

  return merged.sort(compareOutlineEntries);
}

function pruneAfterLatestVisibleTurn(
  entries: readonly ConversationOutlineEntry[],
  latest: ConversationOutlineEntry | undefined,
): ConversationOutlineEntry[] {
  // messages 可能在历史重载的中间帧暂时为空；没有最新锚点时保留已有权威项，
  // 避免缓存被误裁空，下一次请求又退化成整份历史读取。
  if (!latest) return entries.slice();
  const exactIndex = latest.clientId
    ? entries.findIndex((entry) => entry.clientId === latest.clientId)
    : -1;
  if (exactIndex >= 0) return entries.slice(0, exactIndex + 1);
  return entries.filter((entry) => entry.createdAt <= latest.createdAt);
}

/**
 * 完整目录始终以 DB 投影为真源；messages 只负责新消息落库前的即时反馈。
 * 权威目录按 session/device/clear scope 缓存尾游标，后续只从尾部增量读取。
 */
export function useConversationOutline({
  sessionId,
  clearedAt,
  remoteDeviceId,
  enabled,
  messages,
}: UseConversationOutlineOptions): ConversationOutlineEntry[] {
  const optimisticEntriesRaw = useMemo(
    () => optimisticConversationOutlineFromMessages(messages),
    [messages],
  );
  const optimisticEntriesRef = useRef(optimisticEntriesRaw);
  const userTurnRevisionRef = useRef(0);
  const forceFullReloadRevisionRef = useRef(0);
  if (!outlineEntriesEqual(optimisticEntriesRef.current, optimisticEntriesRaw)) {
    if (!outlineEntryStructureEqual(optimisticEntriesRef.current, optimisticEntriesRaw)) {
      const change = classifyOutlineStructureChange(
        optimisticEntriesRef.current,
        optimisticEntriesRaw,
      );
      if (change === 'diverged') {
        // 删除 / rewind / 换序：尾游标不再可信，清空重读整份，否则消失的那一项
        // 会永久残留在导轨上。
        userTurnRevisionRef.current += 1;
        forceFullReloadRevisionRef.current += 1;
      } else if (change === 'tail-appended') {
        // 尾部真的多了 turn → 从尾游标增量读一次即可。
        userTurnRevisionRef.current += 1;
      }
      // `history-filled`（前插或往消息岛之间补历史）什么都不做：权威目录首次已从
      // 会话头读全，这些 turn 本来就在里面。别处新增的 turn 会经推送 / 重连对账
      // 进入 messages，届时尾部结构变化独立触发增量读取，不靠这次前插顺便捞。
    }
    optimisticEntriesRef.current = optimisticEntriesRaw;
  }
  // assistant 流式 token 会让 messages 引用持续变化；真实 user turn 未变化时
  // 复用上一份数组，避免 rail 重建 scroll/ResizeObserver 监听。
  const optimisticEntries = optimisticEntriesRef.current;
  const latestOptimistic = optimisticEntries.at(-1);
  const latestOptimisticForPrune = latestOptimistic;
  const latestOptimisticForPruneRef = useRef(latestOptimisticForPrune);
  latestOptimisticForPruneRef.current = latestOptimisticForPrune;
  const latestMessagePending = latestOptimistic?.clientId
    ? messages.find((message) => message.clientId === latestOptimistic.clientId)?.isPendingPersist
    : false;
  const refreshKey = latestOptimistic
    ? `${latestOptimistic.clientId}:${latestMessagePending ? 'pending' : 'stored'}`
    : 'empty';
  const scopeKey =
    enabled && sessionId
      ? `${sessionId}:${remoteDeviceId ?? 'local'}:${String(clearedAt ?? '')}`
      : null;
  const [authoritativeState, setAuthoritativeState] = useState<{
    scopeKey: string | null;
    entries: ConversationOutlineEntry[];
  }>({ scopeKey: null, entries: [] });
  const cacheRef = useRef<{
    scopeKey: string | null;
    entries: ConversationOutlineEntry[];
    cursor: ConversationOutlineCursor | null;
    initialized: boolean;
    fullReloadRevision: number;
  }>({ scopeKey: null, entries: [], cursor: null, initialized: false, fullReloadRevision: 0 });
  const requestIdRef = useRef(0);
  // 删除、rewind 或新增 user turn 会递增；assistant 的 replyPreview 收尾不递增。
  const userTurnRevision = userTurnRevisionRef.current;
  const forceFullReloadRevision = forceFullReloadRevisionRef.current;

  useEffect(() => {
    const requestId = ++requestIdRef.current;
    if (!scopeKey || !sessionId) {
      cacheRef.current = {
        scopeKey: null,
        entries: [],
        cursor: null,
        initialized: false,
        fullReloadRevision: forceFullReloadRevision,
      };
      setAuthoritativeState({ scopeKey: null, entries: [] });
      return;
    }

    const previousCache = cacheRef.current;
    const scopeCache =
      previousCache.scopeKey === scopeKey
        ? previousCache
        : {
            scopeKey,
            entries: [],
            cursor: null,
            initialized: false,
            fullReloadRevision: forceFullReloadRevision,
          };
    const baseCache =
      scopeCache.fullReloadRevision === forceFullReloadRevision
        ? scopeCache
        : {
            ...scopeCache,
            cursor: null,
            initialized: false,
            fullReloadRevision: forceFullReloadRevision,
          };
    // rewind 会让最后真实 user turn 向前移动；数据库重建期间先裁掉明显位于
    // 其后的旧 marker，避免远程高延迟下仍可点击已经回退的 turn。
    const prunedEntries = pruneAfterLatestVisibleTurn(
      baseCache.entries,
      latestOptimisticForPruneRef.current,
    );
    const pruned = prunedEntries.length !== baseCache.entries.length;
    const cache = pruned
      ? {
          ...baseCache,
          entries: prunedEntries,
          cursor: prunedEntries.at(-1) ? cursorFromOutlineEntry(prunedEntries.at(-1)!) : null,
        }
      : baseCache;
    cacheRef.current = cache;

    setAuthoritativeState((current) =>
      current.scopeKey === scopeKey && current.entries === cache.entries
        ? current
        : { scopeKey, entries: cache.entries },
    );

    let cancelled = false;
    // 只置 cancelled 不足以停下取数：长会话的分页循环最多 256 页顺序往返，
    // 远程时每页都过隧道。切会话 / 连发消息时必须让在飞的循环真正停下，
    // 否则多个作废的循环会继续占满隧道。
    const abort = new AbortController();
    const timer = window.setTimeout(
      () => {
        const cursor = cache.initialized ? cache.cursor : null;
        void listConversationOutlinePageFor(sessionId, clearedAt, {
          signal: abort.signal,
          cursor,
        })
          .then((result: ConversationOutlineLoadResult) => {
            if (cancelled || requestId !== requestIdRef.current) return;
            const entries =
              cursor && cache.initialized
                ? mergeAuthoritativeOutlineEntries(cache.entries, result.entries)
                : result.entries;
            const nextCache = {
              scopeKey,
              entries,
              cursor: result.cursor,
              initialized: true,
              fullReloadRevision: cache.fullReloadRevision,
            };
            cacheRef.current = nextCache;
            setAuthoritativeState({ scopeKey, entries });
          })
          .catch((error) => {
            // 老被控端不支持投影或设备暂时离线时，正文读取不能受影响；
            // 保留同 scope 已有目录，首次加载则自然隐藏。
            log.debug('outline projection unavailable', {
              sessionId,
              error: String(error),
            });
          });
      },
      latestMessagePending ? 300 : 0,
    );

    return () => {
      cancelled = true;
      abort.abort();
      window.clearTimeout(timer);
    };
  }, [
    clearedAt,
    forceFullReloadRevision,
    latestMessagePending,
    refreshKey,
    scopeKey,
    sessionId,
    userTurnRevision,
  ]);

  const authoritative =
    authoritativeState.scopeKey === scopeKey ? authoritativeState.entries : EMPTY_OUTLINE_ENTRIES;
  return useMemo(
    () => (scopeKey ? mergeConversationOutlineEntries(authoritative, optimisticEntries) : []),
    [authoritative, optimisticEntries, scopeKey],
  );
}
