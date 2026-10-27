import { useState } from 'react'
import type { CoreMethod, TaskView } from '@contracts'
import { ThreadClientProvider, type ThreadClient } from '../../../apps/desktop/src/renderer/src/camp-client'
import { useTaskCapability } from '../../../apps/desktop/src/renderer/src/TaskCapabilityProvider'
import { TaskPanel } from '../../../apps/desktop/src/renderer/src/ThreadWorkspace'
import { initial } from '../host-web-parity/data'

let switchScope: (scope: { host: number; thread: string }) => void
let reviseTask: (description: string) => void
let nextResult: 'applied' | 'rejected' | 'pending' | 'unknown' = 'applied'
let finish: (status: 'applied' | 'rejected' | 'unknown') => void
const calls: Array<{ method: CoreMethod; params: unknown }> = []
let hosts: ThreadClient[]
const task: TaskView = {
  taskId: 'task-one', threadId: 'draft-thread', title: '原任务', description: '原说明', status: 'pending',
  assigneeAgentId: initial.members[0].agentId, blockedReason: null, completionSummary: null, cancelReason: null,
  createdByType: 'user', createdById: 'local_user', sourceAgentRunId: null, closedByType: null, closedById: null,
  closedByAgentRunId: null, createdAt: '2026-10-17T00:00:00Z', updatedAt: '2026-10-17T00:00:00Z', closedAt: null, availableActions: ['update']
}
function Panel({ thread, description }: { thread: string; description: string }) {
  const { enabled } = useTaskCapability()
  return enabled ? <TaskPanel snapshot={{ ...initial, thread: { ...initial.thread, id: thread },
    tasks: [{ ...task, threadId: thread, description }, { ...task, taskId: 'task-two', threadId: thread, title: '第二项任务' }] }} busy={false} onTasksChanged={async () => {}} /> : null
}
export function TaskDraftFixture({ client }: { client: ThreadClient }) {
  const [scope, setScope] = useState({ host: 0, thread: 'draft-thread' })
  const [description, setDescription] = useState('原说明')
  switchScope = setScope; reviseTask = setDescription
  const [clients] = useState(() => [0, 1].map(() => ({ ...client, request: (async <T,>(method: CoreMethod, params?: unknown): Promise<T> => {
    if (!method.startsWith('tasks.')) return client.request<T>(method, params)
    calls.push({ method, params })
    const status = nextResult; nextResult = 'applied'
    if (status === 'unknown') throw new Error('保存回执未收到')
    if (status === 'pending') return new Promise<T>((resolve, reject) => {
      finish = status => status === 'unknown'
        ? reject(new Error('保存回执未收到'))
        : resolve({ status, code: 'fixture', payload: {} } as T)
    })
    return { status, code: 'fixture', payload: {} } as T
  }) as ThreadClient['request'] })))
  hosts = clients
  return <ThreadClientProvider client={clients[scope.host]}><Panel thread={scope.thread} description={description} /></ThreadClientProvider>
}
Object.assign(window, { taskDraftTest: {
  scope: (host: number, thread = 'draft-thread') => switchScope({ host, thread }),
  tasks: (enabled: boolean) => hosts[0].request('preferences.tasks.set', { enabled }),
  description: (value: string) => reviseTask(value),
  result: (status: typeof nextResult) => { nextResult = status },
  finish: (status: 'applied' | 'rejected' | 'unknown') => finish(status),
  calls: () => calls,
  assignee: initial.members[0].agentId
} })
