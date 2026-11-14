import type { AgentProfile, MemberExecutionAvailability } from '@contracts'
import { uiAttribute } from './interface-language'
import type { RuntimeStatusPresentation } from './runtime-status'

/** Older Core snapshots have only local facts. Current Core always sends this field. */
export function memberExecutionAvailability(agent: AgentProfile): MemberExecutionAvailability {
  if (agent.executionAvailability) return agent.executionAvailability
  const configured = agent.runtimeConfiguration !== null
  return {
    location: 'local',
    configured,
    canLaunch: configured && ['ready', 'light_ready', 'installed_unverified'].includes(agent.runtimeReadiness.status),
    adapterKind: agent.runtimeConfiguration?.adapterKind ?? null,
    readiness: agent.runtimeReadiness,
    targetRevision: 0
  }
}

/** Remote facts do not use the controller machine's installation/platform list. */
export function remoteExecutionPresentation(
  execution: MemberExecutionAvailability
): RuntimeStatusPresentation | null {
  if (execution.location !== 'remote') return null
  if (execution.configured && execution.canLaunch
    && ['ready', 'light_ready', 'installed_unverified'].includes(execution.readiness.status)) {
    return {
      status: 'available',
      label: uiAttribute('远端可用'),
      detail: uiAttribute('将在所选远端节点运行；本机不需要安装这个智能体。')
    }
  }
  const codes = new Set(execution.readiness.blockers.map(blocker => blocker.code))
  if (codes.has('remote_node_offline')) {
    return {
      status: 'unavailable',
      label: uiAttribute('远端节点离线'),
      detail: uiAttribute('远端配置仍已保存。节点上线后才能启动，不会改为本地运行。')
    }
  }
  return {
    status: 'unavailable',
    label: uiAttribute('远端配置需要处理'),
    detail: codes.has('remote_catalog_node_revoked')
      ? uiAttribute('所选节点已作废。请在运行位置中重新选择。')
      : uiAttribute('所选远端节点、工作区或智能体配置已不可用。请重新读取运行位置。')
  }
}
