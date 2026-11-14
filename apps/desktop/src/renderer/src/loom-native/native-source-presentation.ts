import type { NativeCatalog } from './host-services'

export type NativeSource = {
  runtime: string; scope: string; kind: string; path: string
  status: 'read' | 'absent' | 'refused' | 'unreadable' | 'skipped' | 'truncated'
  items: number; reasonCode?: string; aliasSource?: string; declared?: boolean; truncated?: boolean
}
const REASONS: Record<string,string> = {
  native_link_refused:'链接指向未授权的目录，没有跟随读取。',
  native_root_unreadable:'主机无法读取这个能力目录。',
  native_config_unreadable:'配置不可读取或超过安全大小限制。',
  native_config_invalid:'配置格式无效，未猜测或自动修复。',
  native_declared_root_refused:'客户端声明的路径格式不受支持。',
  native_declared_root_unresolved:'客户端声明的目录不存在或无法确认。',
  native_declared_root_outside_home:'声明目录超出已允许的来源范围。',
  native_home_unverifiable:'无法确认扫描根目录，已停止读取。',
  native_source_already_visited:'此目录已通过另一个来源读取，没有重复导入。',
  native_budget_limit:'达到本次扫描上限，结果可能不完整。',
  discovery_home_required:'当前主机没有设置原生能力来源。需要主机管理员选择允许读取的用户目录。',
  discovery_home_invalid:'当前主机的原生能力来源无效或不受允许。'
}
const STATES:Record<NativeSource['status'],string>={read:'已读取',absent:'未配置',refused:'未读取',unreadable:'无法读取',skipped:'同源复用',truncated:'部分结果'}
export function sourceStateLabel(source:NativeSource):string { return STATES[source.status] || '状态未确认' }
export function sourceExplanation(source:NativeSource):string {
  if(source.reasonCode&&REASONS[source.reasonCode])return REASONS[source.reasonCode]
  if(source.status==='absent')return '这个客户端尚未声明此类能力；不会把未配置当作读取失败。'
  if(source.status==='read')return `读取到 ${Math.max(0,source.items)} 项${source.aliasSource?'，来源为共享的客户端配置':''}。`
  return '查看来源详情，未自动扩大目录权限。'
}
export function discoveryExplanation(code:string):string {return REASONS[code]||'来源暂时无法读取，请检查主机配置。'}
export function sourceTotals(catalog:NativeCatalog):{read:number;absent:number;needsAttention:number;partial:boolean} {
  const sources=catalog.sources??[]
  return {read:sources.filter(source=>source.status==='read').length,absent:sources.filter(source=>source.status==='absent').length,
    needsAttention:sources.filter(source=>source.status==='refused'||source.status==='unreadable').length,
    partial:catalog.truncated.limitHit||sources.some(source=>source.status==='truncated')}
}
