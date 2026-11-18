import { isLocalHookScope, type HookReviewScope } from '../member-catalog-model'

/** Display the exact scope supplied by Core; never invent a local device or root. */
export function HookScopeSummary({ scope }: { scope: HookReviewScope }) {
  const local = isLocalHookScope(scope)
  const runtime = scope.adapterKind === 'deepseek-harness' ? 'DSH' : scope.adapterKind
  const labels: Record<string, string> = {
    'read-only': '只读', 'workspace-write': '允许修改工作目录',
    ask: '需要时向你确认', 'on-request': '需要时向你确认', never: '按已授权的权限执行'
  }
  const show = (value: unknown) => typeof value === 'string' ? labels[value] ?? value : '未提供'
  return <>
    <p>{local ? '本机' : '远程设备'} · {runtime}</p>
    <p>工作目录：{scope.workspaceRoot}</p>
    {local && <><p>文件权限：{show(scope.permissions.values.sandbox_mode)}</p><p>操作确认：{show(scope.permissions.values.approval_policy)}</p></>}
    <details><summary>绑定的设备和对话</summary><p>设备：{local ? scope.executionHostId : scope.nodeId}</p><p>对话：{scope.campId}</p><p>助手：{scope.memberId}</p></details>
  </>
}
