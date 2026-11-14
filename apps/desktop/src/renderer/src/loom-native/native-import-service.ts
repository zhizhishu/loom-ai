import type { SkillImportInspection } from '@contracts'
import type { BusinessEnvironment } from '../business-environment'
import { createCapabilityPort } from './capability-service'
import { readMcpConnections } from './mcp-service'
import type { NativeCapability, NativePreview } from './host-services'

export type NativeImportReview = {
  candidate: NativeCapability
  commandId: string
  inspection?: SkillImportInspection
  preview?: NativePreview
  configDigest?: string
  committedSkillId?: string
}
export async function inspectNativeImport(environment: BusinessEnvironment, candidate: NativeCapability, threadId?: string): Promise<NativeImportReview> {
  if (!environment.workbench) throw new Error('当前主机未提供原生能力发现，请检查连接。')
  const port = createCapabilityPort(environment.client)
  const review: NativeImportReview = { candidate, commandId:crypto.randomUUID() }
  if (candidate.kind === 'skill') {
    review.inspection = await port.inspectSkill(candidate.sourcePath.replace(/[\\/]SKILL\.md$/i,''))
  } else if (candidate.kind === 'mcp') {
    const config = await readMcpConnections(environment.client)
    if (config.status !== 'ready') throw new Error(config.message)
    review.configDigest = config.configDigest
  } else {
    review.preview = await environment.workbench.preview(candidate.sourceId,candidate.digest,threadId)
    if (!review.preview.available || review.preview.truncated || !review.preview.content?.text) throw new Error(review.preview.reason?.message || '完整正文无法读取，未导入截断内容。')
  }
  return review
}
/** Import is explicit, version checked, and never authorizes/starts a Runtime. */
export async function commitNativeImport(environment: BusinessEnvironment, review: NativeImportReview, candidateName?: string, threadId?: string): Promise<{ selectionKey: string | null; message: string }> {
  const port = createCapabilityPort(environment.client)
  const { candidate } = review
  if (candidate.kind === 'skill') {
    if (!review.inspection) throw new Error('导入检查缺失，请重新检查。')
    const item = review.inspection.candidates.find(row => row.name === candidateName)
    if (!item) throw new Error('选择的技能不属于这次检查。')
    if (!review.committedSkillId) {
      const result = await port.commitSkill(review.inspection,{ candidateName:item.name, expectedSkillVersion:item.existingSkillVersion, confirmUpdate:item.importAction === 'update', commandId:review.commandId })
      if (result.status !== 'applied') throw new Error(result.message || '导入未成功。')
      if (!result.skillId) throw new Error('导入结果缺少身份，请核对原请求，不要重复导入。')
      review.committedSkillId = result.skillId
    }
    const registered = await port.registerSkill(review.committedSkillId)
    return { selectionKey:`skill:${registered.id}`, message:'技能已加入目录，并放入本次助手选择。最终创建或保存后才分配。' }
  }
  if (candidate.kind === 'mcp') {
    if (!environment.workbench || !review.configDigest) throw new Error('连接版本未读取。')
    const result = await environment.workbench.importMcp(candidate.sourceId,candidate.digest,review.configDigest,threadId)
    if (result.status !== 'ok' || !result.serverId || result.enabled !== false || result.assignedAgentIds?.length) throw new Error(result.status === 'conflict' ? '来源或连接版本已改变，请重新检查。' : '未确认连接以停用、未分配状态保存，请核对。')
    return { selectionKey:null, message:'MCP已登记但没有启用。打开下面的连接设置完成认证/启用后，再勾选给助手。' }
  }
  if (!review.preview?.available || review.preview.truncated || !review.preview.content?.text) throw new Error('没有完整正文，未保存。')
  const draft = { id:`native-${review.commandId}`, name:candidate.name, body:review.preview.content.text, scope:'cloud' as const, note:'原生客户端资源，经用户明确导入' }
  const result = candidate.kind === 'rule' ? await port.putRule(draft) : await port.putHook(draft)
  return { selectionKey:`${candidate.kind}:${result.id}`, message:candidate.kind === 'hook' ? 'Hook定义已加入选择，尚未执行；分配前还会单独审阅正文和范围。' : '规则已加入选择，最终保存后供助手使用。' }
}
