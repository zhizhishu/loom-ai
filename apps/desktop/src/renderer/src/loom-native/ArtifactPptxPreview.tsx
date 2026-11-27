import type { LoomArtifactPptxPreview } from '@contracts'

export function ArtifactPptxPreview({ preview, fileName }: { preview: LoomArtifactPptxPreview; fileName: string }) {
  if (preview.status === 'missing_dependency') {
    return <div className="ln-artifact-state" data-state="unavailable" data-dependency={preview.missingDependency ?? undefined}>
      <strong>安装 LibreOffice 后可逐页预览</strong>
      <p className="ln-artifact-fact-note">当前先按原有二进制成果处理，不展示正文。</p>
    </div>
  }
  if (preview.status === 'conversion_failed') {
    return <div className="ln-artifact-state" data-state="error" role="alert">
      PPT 逐页预览转换失败{preview.error ? `：${preview.error}` : '。'}
    </div>
  }
  if (preview.slides.length === 0) return <div className="ln-artifact-state" data-state="unavailable">这个 PPT 没有可显示的页面。</div>
  return <div className="ln-artifact-pptx" aria-label={`${fileName} 逐页预览`}>
    {preview.slides.map((slide, index) => <figure key={`${slide.label}-${index}`} className="ln-artifact-pptx-slide" data-hidden={slide.hidden ? 'true' : 'false'}>
      {slide.jpegBase64
        ? <img src={`data:image/jpeg;base64,${slide.jpegBase64}`} alt={`${fileName} 第 ${index + 1} 页 ${slide.label}`}/>
        : <div className="ln-artifact-pptx-hidden" aria-label={`${slide.label} 隐藏页占位`}/>}
      <figcaption>{index + 1} · {slide.label}</figcaption>
    </figure>)}
  </div>
}
