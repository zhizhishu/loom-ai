import type { ArtifactSelection } from './types'
import { artifactSizeLabel } from './artifact-service'
import { Icon } from './icons'
import { resultGroupViews, resultEntryTitle, resultStatusLabel } from './thread-artifacts'
import type { ThreadResultEntry } from './thread-artifacts'

/**
 * 「成果」段（参照 Mikka `thread-artifacts.tsx:43-95` 的 ThreadArtifactsList，改用
 * loom-native 的成果卡样式）：计划 / 改动 / 报告 / 截图 各一组、各带数量，空组不出现。
 * 每一行都只打开既有预览入口（onArtifact → 成果浮层），这里不造第二种阅读面。
 */
export function ThreadResults({ entries, onArtifact }: {
  entries: readonly ThreadResultEntry[]
  onArtifact: (selection: ArtifactSelection) => void
}) {
  const groups = resultGroupViews(entries)
  return <div className="ln-results" role="tabpanel" aria-label="成果">
    {groups.length === 0 && <div className="ln-results-empty">
      <p>这场对话还没有成果。</p>
      <p>助手交付的文件会归档在这里。</p>
    </div>}
    {groups.map(({ group, label, count, entries: groupEntries }) => <section className="ln-result-group" data-group={group} key={group}>
      <h3>{label}<span className="ln-result-count">{count}</span></h3>
      <div className="ln-result-list">
        {groupEntries.map(({ selection }) => <button className="ln-artifact-card" data-artifact-id={selection.artifact.artifactId}
          data-artifact-group={group} key={selection.artifact.artifactId} type="button"
          aria-label={`打开成果：${resultEntryTitle(selection.artifact.relativePath)}`}
          onClick={() => onArtifact(selection)}>
          <span className="ln-document-icon"><Icon name={group === 'captures' ? 'image' : 'file'} size={22}/></span>
          <span>
            <strong>{resultEntryTitle(selection.artifact.relativePath)}</strong>
            <small>{resultStatusLabel(selection.candidate)} · {artifactSizeLabel(selection.artifact.sizeBytes)}</small>
          </span>
          <Icon name="right" size={15}/>
        </button>)}
      </div>
    </section>)}
  </div>
}
