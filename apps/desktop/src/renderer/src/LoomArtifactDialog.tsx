import { useMemo, useRef } from 'react'
import type { ReactNode } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { UiText, uiAttribute, useUiText } from './interface-language'

/**
 * 成果正文浮层：只做外壳。焦点陷阱、Escape 关闭、焦点归还与滚动锁都由 Radix Dialog 提供，
 * 正文与验收上下文由 LoomDelivery 传入——这里不持有 draft、不发 RPC、不缓存正文。
 * 因此浮层既不能绕过链头校验和验收门槛，也不能显示另一份正文。
 */
export function LoomArtifactDialog({
  artifactPath,
  fileName,
  candidateTitle,
  versionLabel,
  previewStatus,
  previewText,
  documentContent,
  context,
  onClose
}: {
  /** 登记里的完整相对路径，只用于标题提示，不当作正文来源。 */
  artifactPath: string
  /** 标题用的文件名（loomArtifactLabel 的结果）。 */
  fileName: string
  /** 所属候选的任务名；没有就显示中性占位。 */
  candidateTitle: string | null
  /** 版本链标签；读不到就不显示。 */
  versionLabel: string | null
  /** 正文状态：只决定下载按钮是否可用，不决定正文内容。 */
  previewStatus: 'reading' | 'ready' | 'unavailable' | 'error'
  /** 只有 ready 时才有真实文本；其余状态为 null，绝不编内容。 */
  previewText: string | null
  documentContent: ReactNode
  context: ReactNode
  onClose(): void
}): React.JSX.Element {
  const t = useUiText()
  // This controlled dialog is opened by an external artifact row, not Dialog.Trigger.
  const opener = useRef<HTMLElement | null>(typeof document === 'undefined' ? null : document.activeElement as HTMLElement | null)
  // 下载只对已取到的正文快照成立：没有正文就不给按钮，避免点了没反应的假动作。
  const download = useMemo(
    () => (previewStatus === 'ready' && previewText !== null ? { text: previewText, name: fileName } : null),
    [previewStatus, previewText, fileName])
  return <Dialog.Root open onOpenChange={next => { if (!next) onClose() }}>
    <Dialog.Portal>
      {/* Portal 挂在根节点之外：这里再挂一次作用域类，浮层内样式才取到同一套变量。 */}
      <div className="loom-mikka">
        <Dialog.Overlay className="loom-artifact-backdrop"/>
        <Dialog.Content className="loom-artifact-dialog" aria-busy={previewStatus === 'reading'} aria-describedby={undefined}
          onCloseAutoFocus={event => {
            event.preventDefault()
            if (opener.current?.isConnected) opener.current.focus({ preventScroll: true })
          }}>
          <header className="loom-artifact-head">
            <span className="loom-artifact-mark" aria-hidden="true"><i/><i/></span>
            <div className="loom-artifact-titles">
              <Dialog.Title className="loom-artifact-title" title={artifactPath}>{fileName}</Dialog.Title>
              <span className="loom-artifact-subtitle">
                {candidateTitle ?? t('交付物')}
                {versionLabel === null ? '' : ` · ${versionLabel}`}
                {' · '}{previewStatus === 'ready' ? t('只读快照')
                  : previewStatus === 'reading' ? t('正在读取正文…')
                    : previewStatus === 'unavailable' ? t('无正文可预览')
                      : t('正文读取失败')}
              </span>
            </div>
            <span className="loom-artifact-head-actions">
              {download !== null && <button
                type="button"
                className="loom-artifact-download"
                onClick={() => {
                  const url = URL.createObjectURL(new Blob([download.text], { type: 'text/plain;charset=utf-8' }))
                  const anchor = window.document.createElement('a')
                  anchor.href = url
                  anchor.download = download.name
                  window.document.body.appendChild(anchor)
                  anchor.click()
                  anchor.remove()
                  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
                }}
              ><UiText zh={"下载正文"}/></button>}
              <Dialog.Close asChild>
                <button
                  type="button"
                  className="loom-artifact-close"
                  aria-label={uiAttribute("关闭成果正文")}
                  title={uiAttribute("关闭")}
                ><svg viewBox="0 0 12 12" aria-hidden="true"><path d="m3 3 6 6M9 3 3 9"/></svg></button>
              </Dialog.Close>
            </span>
          </header>
          <div className="loom-artifact-body">
            <div className="loom-artifact-doc">{documentContent}</div>
            <aside className="loom-artifact-side" aria-label={uiAttribute("验收上下文")}>{context}</aside>
          </div>
        </Dialog.Content>
      </div>
    </Dialog.Portal>
  </Dialog.Root>
}
