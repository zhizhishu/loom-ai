import { useEffect, useId, useRef, useState, type RefObject } from 'react'
import type { MemberAvatarCrop } from '@contracts'
import { useThreadClient } from './camp-client'
import { normalizeMemberAvatarSource, normalizedMemberAvatarBlob, rasterizeMemberAvatarSvg, type NormalizedMemberAvatarSource } from './member-avatar-image'
import { readErrorMessage } from './error-message'
import * as Dialog from '@radix-ui/react-dialog'
import { MemberAvatar } from './MemberAvatar'
import { MemberAvatarCropper } from './MemberAvatarCropper'
import { AppDialogContent, AppDialogHeader, AppDialogBody, AppDialogFooter, AppDialogGlyph, DialogControlIcon } from './AppDialog'
import { BUILTIN_MEMBER_PRESETS } from './member-presets'
import { uiAttribute } from './interface-language'
import { renderAvatarSvg } from 'open-bot-avatar'
import { botMemberAvatarRef, parseControlledMemberAvatarRef } from '@contracts'
import { OpenBotAvatar, setAvatarMotionEnabled, useAvatarMotionEnabled } from './OpenBotAvatar'
import { OPEN_BOT_AVATAR_COLORS, OPEN_BOT_AVATAR_SHAPES, openBotAvatarShape } from './open-bot-avatar-catalog'

/** Edge of the still PNG that backs a shape avatar, in pixels. */
const BOT_AVATAR_STILL_EDGE = 512

export function MemberAvatarEditor({ value, open, disabled, returnFocusRef, onChange, onClose, onPendingChange }: {
  value: string | null
  open: boolean
  disabled: boolean
  returnFocusRef: RefObject<HTMLButtonElement | null>
  onChange(value: string | null): void
  onClose(): void
  onPendingChange(pending: boolean): void
}): React.JSX.Element {
  const client = useThreadClient()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [source, setSource] = useState<{ asset: NormalizedMemberAvatarSource; url: string } | null>(null)
  const [crop, setCrop] = useState<MemberAvatarCrop | null>(null)
  const [presetsOpen, setPresetsOpen] = useState(false)
  const [shapeId, setShapeId] = useState<string>(OPEN_BOT_AVATAR_SHAPES[0]?.id ?? '')
  const [botColor, setBotColor] = useState<string>(OPEN_BOT_AVATAR_SHAPES[0]?.defaultColor ?? '#f97316')
  const shape = openBotAvatarShape(shapeId) ?? OPEN_BOT_AVATAR_SHAPES[0] ?? null
  const motionEnabled = useAvatarMotionEnabled()
  const presetsId = useId()
  const uploadButton = useRef<HTMLButtonElement>(null)
  const dialogId = useId()
  const attempt = useRef(0)
  useEffect(() => { onPendingChange(busy || Boolean(source)) }, [busy, source, onPendingChange])
  useEffect(() => () => { attempt.current++ }, [])
  useEffect(() => {
    if (!open) { attempt.current++; setSource(null); setCrop(null); setBusy(false); setError(null); setPresetsOpen(false) }
  }, [open])
  useEffect(() => () => { if (source) URL.revokeObjectURL(source.url) }, [source])
  useEffect(() => {
    if (!open) return
    const frame = requestAnimationFrame(() => {
      const target = source ? document.getElementById(dialogId)?.querySelector<HTMLElement>('.avatar-crop-stage') : uploadButton.current
      target?.focus({ preventScroll: true })
    })
    return () => cancelAnimationFrame(frame)
  }, [open, source])
  useEffect(() => {
    if (!open) return
    // A late save from a previous member must never write into this one.
    attempt.current++
    // Open on whatever the member already has, so cancel/confirm start from it.
    const current = value ? parseControlledMemberAvatarRef(value) : null
    if (current?.kind === 'bot' && openBotAvatarShape(current.id)) {
      setShapeId(current.id)
      setBotColor(current.color)
    } else {
      setShapeId(OPEN_BOT_AVATAR_SHAPES[0]?.id ?? '')
      setBotColor(OPEN_BOT_AVATAR_SHAPES[0]?.defaultColor ?? '#f97316')
    }
  }, [open, value])
  const dismiss = () => {
    attempt.current++
    setBusy(false); setSource(null); setCrop(null); setError(null)
    onClose()
  }
  const back = () => { setSource(null); setCrop(null); setError(null) }
  const choose = (ref: string | null): void => { onChange(ref); dismiss() }
  const upload = async (): Promise<void> => {
    if (busy || disabled) return
    const current = ++attempt.current
    setBusy(true); setError(null)
    try {
      const selection = await client.memberAvatars.selectSource()
      if (!selection || attempt.current !== current) return
      const asset = await normalizeMemberAvatarSource(selection)
      if (attempt.current !== current) return
      const url = URL.createObjectURL(normalizedMemberAvatarBlob(asset))
      setCrop({ centerX: .5, centerY: .5, size: 1 })
      setSource({ asset, url })
    } catch (failure) {
      if (attempt.current === current) setError(`${uiAttribute('更换未应用，原头像已保留。')} ${readErrorMessage(failure)}`)
    } finally { if (attempt.current === current) setBusy(false) }
  }
  const confirm = async (): Promise<void> => {
    if (!source || !crop || busy || disabled) return
    const current = ++attempt.current
    setBusy(true); setError(null)
    try {
      // Materialize an immutable file; only the main identity Save commits its
      // reference to the member. Cancellation can never change the Profile.
      const saved = await client.memberAvatars.save({
        kind: 'image', source: source.asset.kind === 'gif' ? source.asset.sourceGif : source.asset.sourcePng,
        sourceWidth: source.asset.width, sourceHeight: source.asset.height, crop
      })
      if (current === attempt.current) choose(saved.avatarRef)
    } catch (failure) {
      if (current === attempt.current) setError(`${uiAttribute('更换未应用，原头像已保留。')} ${readErrorMessage(failure)}`)
    } finally { if (current === attempt.current) setBusy(false) }
  }
  const confirmShape = async (): Promise<void> => {
    if (!shape || busy || disabled) return
    const current = ++attempt.current
    // Freeze the choice now: later edits to the grid must not leak into a save
    // that was already started.
    const chosenId = shape.id
    const chosenColor = botColor
    setBusy(true); setError(null)
    try {
      // Static export goes through upstream's still SVG and then the existing
      // normalized-image path, so channel/Agent reads and crops keep working
      // on the managed PNG behind this shape.
      const svg = renderAvatarSvg(shape.definition, {
        color: chosenColor, size: BOT_AVATAR_STILL_EDGE, reducedMotion: true
      })
      const png = await rasterizeMemberAvatarSvg(svg, BOT_AVATAR_STILL_EDGE)
      // A cancel or a newer attempt must not trigger a fresh save.
      if (current !== attempt.current) return
      const saved = await client.memberAvatars.save({
        kind: 'image', source: png,
        sourceWidth: BOT_AVATAR_STILL_EDGE, sourceHeight: BOT_AVATAR_STILL_EDGE,
        crop: { centerX: .5, centerY: .5, size: 1 }
      })
      if (current !== attempt.current) return
      const managed = parseControlledMemberAvatarRef(saved.avatarRef)
      if (managed?.kind !== 'managed') throw new Error(uiAttribute('头像保存未返回可用的图片资产'))
      choose(botMemberAvatarRef(chosenId, chosenColor, managed.assetId))
    } catch (failure) {
      if (current === attempt.current) setError(`${uiAttribute('更换未应用，原头像已保留。')} ${readErrorMessage(failure)}`)
    } finally { if (attempt.current === current) setBusy(false) }
  }
  return <Dialog.Root open={open} onOpenChange={next => { if (!next) dismiss() }}>
    <Dialog.Portal><Dialog.Overlay className="dialog-overlay app-dialog-overlay" />
      <AppDialogContent id={dialogId} className={`avatar-picker-dialog${source ? ' avatar-cut-dialog' : ''}`} tone="neutral"
        onOpenAutoFocus={event => { event.preventDefault(); uploadButton.current?.focus({ preventScroll: true }) }}
        onCloseAutoFocus={event => {
          event.preventDefault()
          requestAnimationFrame(() => {
            const target = returnFocusRef.current
            if (target?.isConnected) target.focus({ preventScroll: true })
          })
        }}>
        <AppDialogHeader title={uiAttribute(source ? '裁切头像' : '更换头像')}
          description={uiAttribute(source ? '调整头像里显示的部分。' : '选择一个外形和颜色，也可以上传一张图片。')}
          hideDescription closeLabel={uiAttribute('关闭')} />
        <AppDialogBody>
          {source && crop ? <MemberAvatarCropper compact sourceUrl={source.url} sourceWidth={source.asset.width} sourceHeight={source.asset.height} value={crop} onChange={setCrop} disabled={busy} /> : <>
            <div className="avatar-picker-bot">
              <div className="avatar-picker-bot-preview">
                {shape && <OpenBotAvatar definition={shape.definition} color={botColor} label="" followPointer className="avatar-picker-bot-stage" />}
              </div>
              <div className="avatar-picker-bot-shapes" role="group" aria-label={uiAttribute('外形')}>
                {OPEN_BOT_AVATAR_SHAPES.map(item => <button key={item.id} className="member-editor-avatar-option avatar-picker-bot-shape-option" type="button"
                  disabled={disabled || busy} aria-pressed={item.id === shape?.id} aria-label={uiAttribute(item.name)}
                  onClick={() => setShapeId(item.id)}>
                  <OpenBotAvatar definition={item.definition} color={botColor} label="" followPointer={false} className="avatar-picker-bot-shape" />
                </button>)}
              </div>
              <div className="avatar-picker-bot-colors" role="group" aria-label={uiAttribute('颜色')}>
                {OPEN_BOT_AVATAR_COLORS.map(color => <button key={color} className="avatar-picker-bot-swatch" type="button"
                  disabled={disabled || busy} aria-pressed={color === botColor} aria-label={color} title={color}
                  style={{ '--avatar-picker-swatch': color } as React.CSSProperties} onClick={() => setBotColor(color)} />)}
              </div>
              <label className="avatar-picker-bot-motion">
                <input type="checkbox" checked={motionEnabled} disabled={busy}
                  onChange={event => setAvatarMotionEnabled(event.currentTarget.checked)} />
                <span>{uiAttribute('头像动画')}</span>
              </label>
            </div>
            <div className="avatar-picker-upload-area" aria-busy={busy}>
              <span className="avatar-picker-upload-glyph"><AppDialogGlyph name="image" /></span>
              <button ref={uploadButton} className="member-editor-primary avatar-picker-upload" type="button" title={uiAttribute('支持 PNG、JPEG 和 GIF')}
                disabled={disabled || busy} onClick={() => void upload()} aria-live="polite">{uiAttribute(busy ? '正在处理头像…' : '上传头像')}</button>
            </div>
            <div className="avatar-picker-presets">
              <button className="avatar-picker-preset-toggle" type="button" disabled={disabled || busy} aria-expanded={presetsOpen}
                aria-controls={presetsId} onClick={() => setPresetsOpen(current => !current)}>
                <span>{uiAttribute('使用预设头像')}</span><DialogControlIcon name="chevron" />
              </button>
              <div id={presetsId} className="avatar-picker-options" hidden={!presetsOpen} aria-label={uiAttribute('预设头像')}>
                {BUILTIN_MEMBER_PRESETS.map(preset => <button key={preset.role} className="member-editor-avatar-option" type="button" disabled={disabled || busy}
                  aria-pressed={value === preset.avatarRef} aria-label={preset.displayName} onClick={() => choose(preset.avatarRef)}>
                  <MemberAvatar agentId={preset.role} avatarRef={preset.avatarRef} displayName={preset.displayName} size="picker" decorative />
                  <span>{preset.displayName}</span>
                  {value === preset.avatarRef && <span className="avatar-picker-check"><DialogControlIcon name="check" /></span>}
                </button>)}
              </div>
            </div>
          </>}
          {error && <p className="member-editor-field-error" role="alert">{error}</p>}
        </AppDialogBody>
        {source ? <AppDialogFooter>
          <button className="quiet-button" type="button" disabled={busy} onClick={back}>{uiAttribute('返回')}</button>
          <button className="member-editor-primary" type="button" disabled={disabled || busy || !crop}
            onClick={() => void confirm()}>{uiAttribute('确认头像')}</button>
        </AppDialogFooter> : <AppDialogFooter leading={value && <button className="quiet-button avatar-picker-remove" type="button" disabled={disabled || busy} onClick={() => choose(null)}>{uiAttribute('移除头像')}</button>}>
          <button className="member-editor-primary avatar-picker-bot-apply" type="button" disabled={disabled || busy || !shape}
            onClick={() => void confirmShape()}>{uiAttribute('使用这个外形')}</button>
          <Dialog.Close asChild><button className="quiet-button" type="button">{uiAttribute('取消')}</button></Dialog.Close>
        </AppDialogFooter>}
      </AppDialogContent>
    </Dialog.Portal>
  </Dialog.Root>
}
