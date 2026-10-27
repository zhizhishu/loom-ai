import { useEffect, useState } from 'react'
import type { ConsoleClient, UploadProgress } from './client'
import { UiText, uiAttribute } from '../../desktop/src/renderer/src/interface-language'

function label(upload: UploadProgress): string {
  if (upload.phase === 'received') return uiAttribute('原上传已确认。重新选择原文件可恢复附件。')
  if (upload.cancelled) return uiAttribute('已取消发送，原上传结果待核对。')
  if (upload.phase === 'hashing') return uiAttribute('正在准备文件…')
  if (upload.phase === 'binding') return uiAttribute('文件已传输，正在确认附件…')
  if (upload.phase === 'unknown') return uiAttribute('连接中断，原上传结果待核对。')
  return uiAttribute('正在上传 {0}%', String(upload.percent))
}

/** Only the current uploads live here; native downloads belong to the browser. */
export function UploadStatus({ transport }: { transport: ConsoleClient }): React.JSX.Element | null {
  const [uploads, setUploads] = useState(transport.uploadProgress)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => transport.onUploadsChanged(() => setUploads(transport.uploadProgress)), [transport])
  if (!uploads.length) return null
  const recover = (id: string, retry: boolean): void => {
    if (busy) return
    setBusy(id); setError(null)
    void (retry ? transport.retryUpload(id) : transport.reconcilePending())
      .catch(error => setError(error instanceof Error ? error.message : uiAttribute('暂时无法核对，请重试。')))
      .finally(() => setBusy(null))
  }
  return <section className="web-upload-status" aria-label={uiAttribute('附件上传')}>
    {uploads.map(upload => <div className="web-upload-row" key={upload.id}>
      <strong title={upload.name}>{upload.name}</strong>
      <span role="status">{label(upload)}</span>
      {upload.phase === 'unknown' && !transport.canRetryUpload(upload.id) && <span><UiText zh="可重新选择原文件，继续核对或重试原上传。" /></span>}
      {upload.phase === 'transferring' && <progress max={100} value={upload.percent} aria-label={uiAttribute('上传进度')} />}
      <div className="web-upload-actions">
        {upload.phase === 'unknown' && <button type="button" disabled={busy !== null} onClick={() => recover(upload.id, false)}><UiText zh="核对结果" /></button>}
        {upload.phase === 'unknown' && transport.canRetryUpload(upload.id) && <button type="button" disabled={busy !== null} onClick={() => recover(upload.id, true)}><UiText zh="重试原上传" /></button>}
        {!upload.cancelled && upload.phase !== 'received' && <button type="button" onClick={() => transport.cancelUpload(upload.id)}><UiText zh="取消上传" /></button>}
        {(upload.cancelled || upload.phase === 'received') && <button type="button" onClick={() => transport.dismissUpload(upload.id)}><UiText zh="收起" /></button>}
      </div>
    </div>)}
    {error && <p role="alert">{error}</p>}
  </section>
}
