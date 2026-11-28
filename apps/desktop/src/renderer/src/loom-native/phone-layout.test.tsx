/**
 * 工兵单 C：iPhone 390×844 手机网页（浏览器 + PWA 资产）的静态契约。
 *
 * 这里钉三件事，跑在真机仿真之前：
 *  1) index.html / manifest / 四个图标文件齐备且互相一致（添加主屏入口）；
 *  2) loom-native 的 native.css / product.css 给出五条流程（看群、任务进度、
 *     发指令、批准、看附件）在 ≤520 窄屏与刘海/圆点条安全区下的规则，
 *     且旧 Rovai shell 选择器没有回流进来；
 *  3) 这些规则要落到真 DOM 钩子上：待批准卡与消息附件卡在 ConversationView
 *     静态渲染里存在，composer 仍是唯一的发送入口。
 *
 * 真实点击、真实授权回执、真实附件读取需要 Runtime/Host，本文件不合成；
 * 那部分由 scripts/lib/host-web-phone-loom.test.mjs 用真 Host + 无头 Chrome 跑。
 */
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync, statSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import type { ActionApprovalView, ThreadMessageAttachmentView } from '@contracts'
import type { AgentProfile, ConversationItem, ThreadSnapshot } from './types'
import { ConversationView } from './ConversationView'

vi.mock('../MemberAvatar', async () => {
  const { createElement: h } = await import('react')
  return { MemberAvatar: vi.fn((props: { agentId: string }) => h('span', { className: 'member-avatar', 'data-agent': props.agentId })) }
})

const root = new URL('../../../../../../', import.meta.url)
const read = (relative: string): string => readFileSync(new URL(relative, root), 'utf8')
const nativeCss = read('apps/desktop/src/renderer/src/loom-native/native.css')
const productCss = read('apps/desktop/src/renderer/src/loom-native/product.css')

/** 只抽 `@media(max-width:520px)` 这一层，避免用「全文件出现过」冒充「窄屏生效」。 */
function phoneBlocks(css: string): string {
  const blocks: string[] = []
  for (let at = css.indexOf('@media(max-width:520px)'); at !== -1; at = css.indexOf('@media(max-width:520px)', at + 1)) {
    const open = css.indexOf('{', at)
    if (open === -1) continue
    let depth = 0
    for (let index = open; index < css.length; index++) {
      if (css[index] === '{') depth++
      else if (css[index] === '}' && --depth === 0) { blocks.push(css.slice(open + 1, index)); break }
    }
  }
  return blocks.join('\n')
}
const phone = phoneBlocks(nativeCss) + '\n' + phoneBlocks(productCss)

describe('PWA entry in the production Web shell', () => {
  const html = read('apps/web/index.html')

  it('links the manifest, the touch icon and the iOS home-screen metas from index.html', () => {
    expect(html).toContain('<link rel="manifest" href="./manifest.webmanifest"')
    expect(html).toContain('<link rel="apple-touch-icon" href="./loom-icon-192.png"')
    expect(html).toContain('<meta name="apple-mobile-web-app-capable" content="yes"')
    expect(html).toContain('<meta name="apple-mobile-web-app-title" content="LOOM"')
    expect(html).toContain('<meta name="theme-color"')
    // 刘海机型必须让内容铺到安全区外，再由 CSS 的 env() 让出可读区。
    expect(html).toContain('viewport-fit=cover')
    expect(html).toMatch(/<meta name="viewport" content="width=device-width, initial-scale=1\.0[^"]*"/)
    // 保留既有图标与单入口脚本，不因为加 manifest 改动启动合同。
    expect(html).toContain('<link rel="icon" type="image/png" href="./loom-favicon-9bd461c1.png"')
    expect(html).toContain('src="/src/main.tsx"')
  })

  it('declares a standalone-installable manifest whose icons exist at the declared sizes', () => {
    const manifest = JSON.parse(read('apps/web/public/manifest.webmanifest')) as {
      name: string; short_name: string; start_url: string; scope: string; display: string
      icons: { src: string; sizes: string; type: string; purpose: string }[]
    }
    expect(manifest.name).toBe('LOOM')
    expect(manifest.short_name).toBe('LOOM')
    expect(manifest.start_url).toBe('/')
    expect(manifest.scope).toBe('/')
    expect(manifest.display).toBe('standalone')
    const purposes = manifest.icons.map(icon => `${icon.sizes}/${icon.purpose}`)
    for (const wanted of ['192x192/any', '512x512/any', '192x192/maskable', '512x512/maskable']) expect(purposes).toContain(wanted)
    for (const icon of manifest.icons) {
      expect(icon.type).toBe('image/png')
      expect(icon.src.startsWith('/')).toBe(true)
      const file = new URL(`apps/web/public${icon.src}`, root)
      expect(statSync(file).size).toBeGreaterThan(1024)
      const png = readFileSync(file)
      // PNG signature + IHDR: the declared size is the real pixel size, not a rename.
      expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      const [width, height] = [png.readUInt32BE(16), png.readUInt32BE(20)]
      expect(`${width}x${height}`).toBe(icon.sizes)
    }
  })
})

describe('phone CSS keeps the five flows usable at 390x844', () => {
  it('lets the notch and home bar through on the shell and the fixed notice', () => {
    for (const inset of ['top', 'right', 'bottom', 'left']) {
      expect(nativeCss).toMatch(new RegExp(`\\.ln-app\\{[^}]*padding-${inset}:env\\(safe-area-inset-${inset},0px\\)`))
    }
    expect(nativeCss).toMatch(/\.ln-notice\{bottom:calc\(30px \+ env\(safe-area-inset-bottom,0px\)\)\}/)
  })

  it('keeps one overlay column instead of squeezing three panes below 800px', () => {
    const narrow = nativeCss.slice(nativeCss.indexOf('@media(max-width:800px)'))
    expect(narrow).toMatch(/\.ln-sidebar\{position:absolute/)
    expect(narrow).toMatch(/\.ln-inspector\{position:absolute/)
    // 手机层只是在覆盖显示之上补宽度，不新增第二套三栏。
    expect(phoneBlocks(nativeCss)).not.toContain('.ln-inspector{width:var(--ln-inspector)')
  })

  it('covers 看群 / 任务进度 / 发指令 / 批准 / 看附件 in the 520px layer', () => {
    // 看群：身份胶囊能把标题让出去（不撑破 340px 的群头），工作根在手机只留图标。
    expect(phone).toMatch(/\.ln-identity-pill\{flex:0 1 auto;min-width:0;padding-right:9px!important\}/)
    expect(phone).toMatch(/\.ln-chat-root\{max-width:32px;padding:5px 7px!important;justify-content:center\}/)
    expect(phone).toMatch(/\.ln-chat-root span\{display:none\}/)
    // 任务进度：任务卡按内容长高，标题和时间可换行，不再被 60px 固定高裁掉。
    expect(phone).toMatch(/\.ln-task-card\{height:auto;min-height:56px\}/)
    expect(phone).toMatch(/\.ln-task-firstline\{flex-wrap:wrap;row-gap:2px\}/)
    // 覆盖层只留一层：准备清单封顶高度，抽屉打开时整块让位。
    expect(phone).toMatch(/\.ln-setup-checklist\{width:calc\(100% - 24px\);top:8px;max-height:min\(60dvh,420px\);overflow:auto\}/)
    expect(phone).toMatch(/\.ln-frame:has\(\.ln-sidebar\) \.ln-setup-checklist,\.ln-frame:has\(\.ln-inspector\) \.ln-setup-checklist\{display:none\}/)
    // 发指令：输入区贴着 home bar 之上（安全区由 .ln-app 让出），本身只留呼吸。
    expect(phone).toMatch(/\.ln-composer-area\{padding-bottom:8px\}/)
    expect(nativeCss).toMatch(/@media\(max-width:520px\)\{[^@]*\.ln-composer\{padding:10px;min-height:90px;border-radius:17px\}/)
    // 批准：授权卡自己滚动，聊天记录不会被一张长卡挤成 0 高。
    expect(phone).toMatch(/\.ln-approval-request\{max-height:min\(46dvh,340px\);overflow:auto\}/)
    expect(nativeCss).toMatch(/\.ln-approval-request>div\{display:flex;gap:8px;flex-wrap:wrap/)
    // 看附件：附件卡占满消息列，长文件名省略而不是撑出横向滚动。
    expect(phone).toMatch(/\.ln-message-files\{width:100%;max-width:100%\}/)
    expect(phone).toMatch(/\.ln-file-card,\.ln-attachment-thumb\{max-width:100%\}/)
    expect(nativeCss).toMatch(/\.ln-attachment-thumb-copy|\.ln-pending-attachment-copy strong\{[^}]*text-overflow:ellipsis/)
  })

  it('thins the glass layer on phones instead of keeping desktop backdrop cost', () => {
    expect(phone).toMatch(/\.ln-sidebar\{backdrop-filter:blur\(14px\) saturate\(1\.06\);/)
    expect(phone).toMatch(/\.ln-surface-dialog\{background:var\(--ln-bg\);backdrop-filter:none;/)
    expect(phone).toMatch(/\.ln-composer\{backdrop-filter:blur\(12px\);/)
  })

  it('never reintroduces the retired Rovai shell selectors into the native sheets', () => {
    // `.web-login-overlay` 的 auth token（`--conversation-action`）是登录面自己的，不算旧 shell。
    for (const legacy of ['.camp-', '.unified-sidebar', 'app-shell', '.mobile-camp', '.mobile-bottom-navigation']) {
      expect(nativeCss).not.toContain(legacy)
      expect(productCss).not.toContain(legacy)
    }
  })
})

describe('the phone CSS lands on real ConversationView hooks', () => {
  const member = { agentId: 'a1', displayName: 'Hanzi', avatarRef: null, teamRole: '助手', profilePresence: 'present', membershipStatus: 'active' }
  const approval = {
    id: 'ap1', actionId: 'ac1', actionKind: 'shell.command', actionSummary: '运行 npm test', canonicalInput: {},
    reason: '这条命令会写入工作目录', agentRunId: 'r1', agentId: 'a1', adapterKind: 'pi',
    nativeMethod: null, requestDigest: null, permissionSemantics: 'core_enforced_v1',
    options: [
      { optionId: 'o1', kind: 'allow_once', label: '允许一次', consequence: '只运行这一条命令', nativeResponseDigest: 'd1' },
      { optionId: 'o2', kind: 'allow_session', label: '本次会话允许', consequence: '本会话不再询问', nativeResponseDigest: 'd2' }
    ],
    status: 'pending', requestedForUserId: 'local_user', resolvedByType: null, resolvedById: null,
    resolutionCode: null, version: 1, requestedAt: '2026-11-22T00:00:00.000Z', resolvedAt: null
  } as ActionApprovalView
  const attachment = {
    id: 'at1', displayName: 'release-notes-2026-11-22.png', kind: 'file', fileCount: null,
    mediaType: 'image/png', byteSize: 327_680, previewKind: 'image', availability: 'available'
  } as ThreadMessageAttachmentView
  const thread = {
    schemaVersion: 9, throughGlobalSequence: 1,
    thread: { id: 'th-1', title: '发版群', defaultLeadAgentId: 'a1', projectPath: '/repo/app', projectBindingKind: 'directory', version: 1 },
    members: [member], membershipReconciliations: [], tasksEnabled: true, tasks: [], memberCreations: [],
    messages: [{
      id: 'm1', sequence: 1, authorType: 'user', authorId: 'local_user', authorDisplayName: null,
      body: '截图在这里', withdrawn: false, attachments: [attachment], agentRunId: null, createdAt: '2026-11-22T00:00:00.000Z'
    }],
    messageDeliveries: [], turns: [], agentRuns: [], executionEvidence: [], agentRunFileChanges: [], agentRunImages: [],
    approvals: [approval], contextManifests: [], actions: [], timeline: []
  } as unknown as ThreadSnapshot
  const row: ConversationItem = {
    id: 'th-1', title: '发版群', subtitle: '', agentId: 'a1', threadId: 'th-1', missionId: null, unread: false, updatedAt: null
  }
  const html = renderToStaticMarkup(createElement(ConversationView, {
    item: row, snapshot: thread, agents: [{ agentId: 'a1', displayName: 'Hanzi', avatarRef: null, teamRole: '助手' } as unknown as AgentProfile],
    bundles: [], loading: false, sending: false, draft: '', files: [], error: null,
    onDraft: () => {}, onFiles: () => {}, onSend: () => {}, onProfile: () => {}, onArtifact: () => {},
    onShowSidebar: () => {}, sidebarHidden: false, onShowWork: () => {}, inspectorHidden: false,
    onAttachment: () => {}, onResolveApproval: () => {}, approvalBusy: false, onMembers: () => {}, onWorkspaceManager: () => {}
  }))

  it('renders the pending approval above the composer with both option buttons', () => {
    expect(html).toContain('class="ln-approval-request"')
    expect(html).toContain('运行 npm test')
    expect(html).toContain('允许一次')
    expect(html).toContain('本次会话允许')
    expect(html).toContain('ln-approval-scope')
    expect(html.indexOf('ln-approval-request')).toBeLessThan(html.indexOf('class="ln-composer"'))
  })

  it('renders a sent attachment as the file card the phone CSS sizes', () => {
    expect(html).toContain('class="ln-message-files"')
    expect(html).toContain('class="ln-file-card is-image"')
    expect(html).toContain('class="ln-attachment-thumb is-image"')
    expect(html).toContain('release-notes-2026-11-22.png')
  })

  it('keeps the composer the only send surface', () => {
    expect(html).toContain('class="ln-composer-area"')
    expect(html).toContain('class="ln-send-button"')
    expect(html.match(/class="ln-send-button"/g)).toHaveLength(1)
    expect(html).not.toContain('ln-recipient-control')
  })
})
