/** XHR supplies browser upload progress without buffering the File in JS. The
 * fixed same-origin Host endpoint never redirects; unexpected redirect results
 * are rejected and reconciled using the original command ID. */
export function uploadRequest(url: string, token: string, commandId: string, data: FormData, signal: AbortSignal,
  progress: (fraction: number) => void): Promise<Response> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    const abort = (): void => xhr.abort()
    const cleanup = (): void => signal.removeEventListener('abort', abort)
    xhr.open('POST', url)
    xhr.withCredentials = false
    xhr.setRequestHeader('Authorization', `Bearer ${token}`)
    xhr.setRequestHeader('X-Rovai-Upload-Command-Id', commandId)
    xhr.upload.onprogress = event => { if (event.lengthComputable) progress(event.loaded / event.total) }
    xhr.upload.onload = () => progress(1)
    xhr.onerror = () => { cleanup(); reject(new TypeError('上传连接中断，正在核对原结果。')) }
    xhr.onabort = () => { cleanup(); reject(new DOMException('Upload cancelled', 'AbortError')) }
    xhr.onload = () => {
      cleanup()
      if (xhr.responseURL !== url) { reject(new Error('上传响应地址无效，正在核对原结果。')); return }
      resolve(new Response(xhr.responseText, { status: xhr.status, headers: { 'Content-Type': 'application/json' } }))
    }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) { cleanup(); reject(new DOMException('Upload cancelled', 'AbortError')); return }
    xhr.send(data)
  })
}
