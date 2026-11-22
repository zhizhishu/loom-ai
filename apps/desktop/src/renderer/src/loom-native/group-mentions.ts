/**
 * 群聊 @ 提及：照抄 Mikka `lib/group-mentions.ts:4-9` 的规则——消息正文里出现
 * `@<成员名>`（小写全包含）就算提到了那个成员，纯文本识别，不靠富文本编辑器，
 * 也不读任何隐藏元数据。LOOM 的输入框就是 textarea，正文是唯一的事实源。
 */
export interface MentionCandidate {
  agentId: string
  displayName: string
}

/** 正文里被 `@` 点到名的成员，按传入的成员顺序（与 Mikka 一致）。 */
export function mentionsIn(body: string, members: readonly MentionCandidate[]): string[] {
  const text = body.toLowerCase()
  return members
    .filter(member => member.displayName.trim() !== '' && text.includes(`@${member.displayName.trim().toLowerCase()}`))
    .map(member => member.agentId)
}

/**
 * 这条消息要指给谁：@ 了谁就谁答（Mikka `group-chat-view.tsx:151`）；正文里没点名
 * 就不指定收件人，交给服务端判断该谁来答（`group-chat-view.tsx:56`）。
 * Mikka 自己不做"只给一个人"的取舍：`mentionsIn`（`lib/group-mentions.ts:3-9`）返回全部
 * 被点名的成员，`group-chat-view.tsx:151` 把它们整份交给服务端。LOOM 的输入框只带一个
 * 收件人，所以按**正文里最先出现的那个 @ 名字**取（与 `mentionsIn` 的成员顺序无关）；
 * 同一位置命中（如 `@Han` 与 `@Hanzi`）仍按成员顺序取前者，与 `mentionsIn` 一致。
 */
export function mentionRecipient(body: string, members: readonly MentionCandidate[]): string | undefined {
  const text = body.toLowerCase()
  let first: { agentId: string; at: number } | undefined
  for (const member of members) {
    const name = member.displayName.trim().toLowerCase()
    if (!name) continue
    const at = text.indexOf(`@${name}`)
    if (at === -1) continue
    if (!first || at < first.at) first = { agentId: member.agentId, at }
  }
  return first?.agentId
}
