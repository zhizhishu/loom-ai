/**
 * 群聊 @ 补全：纯函数，照抄 rakazo `packages/core/src/composer/composer-mentions.ts:112-159,170-198,220-233`
 * 的算法（只换语言，不发挥）——在 textarea 的光标处认出正在输入的 `@名字`，按名字排候选，
 * 补全时只替换这一个 token，前后的正文原样保留。
 *
 * 与 `group-mentions.ts` 的分工：那边决定「这条消息要发给谁」（正文里 @ 了谁），
 * 这边只负责输入时的候选列表和插入的文本，**不改收件人解析**。
 */

export interface MentionMember {
  agentId: string
  displayName: string
}

/** 一次 @ 查询：`start` 是 `@` 的位置，`end` 是这个 token 的右边界（含已认出的完整名字）。 */
export interface MentionQuery {
  start: number
  end: number
  query: string
}

/** 候选上限：rakazo `use-composer-triggers.ts:149-153` 的 `.slice(0, 10)`。 */
export const MAX_MENTION_OPTIONS = 10

/**
 * @ 补全的作用域：只有**群聊**、且会话条目与快照指向同一个会话时才有候选。
 * 单聊、快照缺失、或两者不同步时返回 null——此时不查询、不弹层，也不接受选择。
 */
export function mentionScope(
  item: { threadId?: string | null } | null,
  snapshot: { thread: { id: string } } | null,
  isGroup: boolean
): string | null {
  if (!isGroup || !snapshot || !item) return null
  const threadId = item.threadId ?? null
  return threadId !== null && threadId === snapshot.thread.id ? snapshot.thread.id : null
}

// 名字正在被输入时，`@` 前面是开头、空白，或者中日韩文字（「请@Wr」不写空格）。
const PARTIAL_MENTION = /(?:^|\s|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}])@((?:[\p{L}\p{M}\p{N}_\u200c\u30fb-]|\u200d)*)$/u
const TOKEN_TAIL = /^(?:[\p{L}\p{M}\p{N}_\u200c\u30fb-]|\u200d)*/u
const CJK_CHAR = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u

/**
 * 光标处正在输入的 @ 查询。选区不折叠（用户选中一段文字）时没有查询——
 * 此时 Enter/Tab 该照常走发送/焦点，不该被候选列表吃掉。
 */
export function mentionQuery(
  text: string,
  selectionStart = text.length,
  selectionEnd = selectionStart,
  members: readonly MentionMember[] = []
): MentionQuery | null {
  if (selectionStart !== selectionEnd || selectionStart < 0 || selectionStart > text.length) return null
  const match = PARTIAL_MENTION.exec(text.slice(0, selectionStart))
  if (!match) return null
  const query = match[1] ?? ''
  const start = selectionStart - query.length - 1
  const rest = TOKEN_TAIL.exec(text.slice(selectionStart))?.[0] ?? ''
  // CJK 正文不写空格，所以不能整段吞掉右边：只在能对上已知名字时向右扩。
  const cjk = rest.search(CJK_CHAR)
  let end = selectionStart + (cjk < 0 ? rest.length : cjk)
  const typed = text.slice(start + 1, selectionStart + rest.length)
  for (const member of members) {
    const candidate = member.displayName.trim()
    if (!candidate) continue
    let matched = 0
    for (const character of typed) {
      if (candidate.slice(matched, matched + character.length).toLowerCase() !== character.toLowerCase()) break
      matched += character.length
    }
    if (matched >= query.length) end = Math.max(end, start + 1 + matched)
    // 名字本身带空格（`Review Bot`）时 TOKEN_TAIL 会停在空格前：只有从 `@` 起整段正文**正好**是
    // 已知全名才向右补齐到名字末尾，不吞任意空格或后面的词——`@Re|view Bot 在吗` 补全后仍是
    // `@Review Bot 在吗`，不会变成 `@Review Bot Bot 在吗`。
    if (text.slice(start + 1, start + 1 + candidate.length).toLowerCase() === candidate.toLowerCase()) {
      end = Math.max(end, start + 1 + candidate.length)
    }
  }
  return { start, end, query }
}

/**
 * 弹层是上一帧的状态：Ctrl/Cmd+A 全选、光标移走、草稿在别处被改写之后，它记录的区间已经作废。
 * 键盘（↑↓ / Enter / Tab / Esc）和点选插入前都用它按 textarea 的**实时**正文与选区复核：
 * 只有折叠光标仍落在显示的那段查询里才原样返回该查询，否则返回 null——过期或没有查询时
 * 绝不劫持 Tab/Enter，也绝不拿旧区间去替换正文。
 */
export function liveMentionQuery(
  query: MentionQuery | null,
  text: string,
  selectionStart: number,
  selectionEnd: number
): MentionQuery | null {
  if (!query) return null
  if (selectionStart !== selectionEnd) return null
  if (query.start < 0 || query.start >= query.end || query.end > text.length) return null
  if (selectionStart <= query.start || selectionStart > query.end) return null
  if (!text.startsWith('@', query.start)) return null
  if (!text.startsWith(query.query, query.start + 1)) return null
  return query
}

function pickerWords(value: string): string[] {
  return value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().split(/\s+/).filter(Boolean)
}

/**
 * 候选排序（rakazo `composer-mentions.ts:170-198`）：每个查询词都得出现在名字里，
 * 命中名字词开头比命中中间更靠前，同分保持传入顺序。空查询保持原顺序。
 * 不造 `everyone`/别名这类合成目标：候选只来自当前会话的在册成员。
 */
export function filterMentionMembers<T extends MentionMember>(members: readonly T[], query: string): T[] {
  const words = pickerWords(query)
  if (words.length === 0) return [...members]
  const scored = members.flatMap((member, index) => {
    const nameWords = pickerWords(member.displayName)
    const name = nameWords.join(' ')
    let score = 0
    for (const word of words) {
      if (nameWords.some(nameWord => nameWord.startsWith(word))) score += 2
      else if (name.includes(word)) score += 1
      else return []
    }
    return [{ member, index, score }]
  })
  return scored.sort((left, right) => right.score - left.score || left.index - right.index).map(row => row.member)
}

/** 补全列表：先按查询排序，再截到 {@link MAX_MENTION_OPTIONS} 个。 */
export function mentionOptions<T extends MentionMember>(members: readonly T[], query: string): T[] {
  return filterMentionMembers(members, query).slice(0, MAX_MENTION_OPTIONS)
}

/**
 * 把查询换成选中的名字（rakazo `composer-mentions.ts:220-233`）：只替换 `[start, end)` 这一段，
 * 后面的正文一个字符都不动；结尾没有文字时补一个空格，光标落在空格之后。
 */
export function completeMention(text: string, query: MentionQuery, member: MentionMember): { text: string; caret: number } {
  const suffix = text.slice(query.end)
  const token = `@${member.displayName.trim()}`
  const separator = suffix.length === 0 ? ' ' : ''
  return {
    text: `${text.slice(0, query.start)}${token}${separator}${suffix}`,
    caret: query.start + token.length + (separator || suffix.startsWith(' ') ? 1 : 0)
  }
}
