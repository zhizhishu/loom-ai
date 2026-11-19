import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ChoiceMenu } from '../../../apps/desktop/src/renderer/src/loom-native/Controls'
declare global { interface Window { choiceQA: { enable(): void; changes: Record<string, number>; trustedPointers: number } } }
function Fixture() {
  const [ready, setReady] = useState(false), [purge, setPurge] = useState('off'), [access, setAccess] = useState('read')
  useEffect(() => {
    window.choiceQA = { enable: () => setReady(true), changes: { purge: 0, access: 0 }, trustedPointers: 0 }
    const record = (event: PointerEvent) => { if (event.isTrusted) window.choiceQA.trustedPointers++ }
    document.addEventListener('pointerdown', record)
    return () => document.removeEventListener('pointerdown', record)
  }, [])
  return <div className="ln-surface-dialog ln-studio">
    <ChoiceMenu label="Pi Purge 模式" disabled={!ready} value={purge}
      choices={[{ value: 'off', label: '关闭' }, { value: 'append', label: '追加助手设定' }]}
      onChange={value => { window.choiceQA.changes.purge++; setPurge(value) }}/>
    <ChoiceMenu label="文件与任务权限" disabled={!ready} value={access}
      choices={[{ value: 'read', label: '只读工作目录' }, { value: 'workflow', label: '读写文件并处理任务' }]}
      onChange={value => { window.choiceQA.changes.access++; setAccess(value) }}/>
  </div>
}
const style = document.createElement('style')
style.textContent = 'body{margin:60px;font:16px sans-serif}.ln-choice{display:block;margin:20px;padding:10px;min-width:240px}.ln-choice-menu{background:white;border:1px solid #777;padding:8px}.ln-choice-item{padding:12px;min-width:240px}.ln-choice-item[data-highlighted]{background:#eee}'
document.head.appendChild(style)
createRoot(document.getElementById('root')!).render(<Fixture/>)

