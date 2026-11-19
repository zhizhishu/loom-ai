import type { WorkspaceSelection } from '@contracts'

/** Presentation preference only. This is never an access-control grant.
 * Every use must be revalidated by the connected Core Host. */
export const WORKSPACE_DEFAULT_KEY = 'loom.workspace.default.v1'
export function isWorkspaceChoice(value: unknown): value is WorkspaceSelection {
  if(!value || typeof value!=='object' || Array.isArray(value)) return false
  const item=value as {projectPath?:unknown;name?:unknown}
  return typeof item.projectPath==='string' && item.projectPath.trim()!=='' && item.projectPath.length<=4096
    && typeof item.name==='string' && item.name.trim()!=='' && item.name.length<=200
}
export function readWorkspaceDefault(storage: Pick<Storage,'getItem'>): WorkspaceSelection|null {
  try {
    const value=storage.getItem(WORKSPACE_DEFAULT_KEY)
    if(!value)return null
    const parsed:unknown=JSON.parse(value)
    if(!parsed || typeof parsed!=='object' || (parsed as {version?:unknown}).version!==1) return null
    const workspace=(parsed as {workspace?:unknown}).workspace
    return isWorkspaceChoice(workspace)?workspace:null
  }catch{return null}
}
export function writeWorkspaceDefault(storage: Pick<Storage,'setItem'|'removeItem'>, selection: WorkspaceSelection|null):void {
  if(selection!==null&&!isWorkspaceChoice(selection))throw Error('工作目录缺少已验证的路径和名称')
  if(selection) storage.setItem(WORKSPACE_DEFAULT_KEY,JSON.stringify({version:1,workspace:selection}))
  else storage.removeItem(WORKSPACE_DEFAULT_KEY)
}
/** Validation is performed by Core, not by client path guessing or storage. */
export async function validateWorkspaceDefault(
  request:<T>(method:'workspaces.validate',params:{path:string})=>Promise<T>,
  choice:WorkspaceSelection
):Promise<WorkspaceSelection>{
  const checked=await request<WorkspaceSelection>('workspaces.validate',{path:choice.projectPath})
  if(!isWorkspaceChoice(checked) || checked.projectPath!==choice.projectPath)
    throw Error('主机返回的工作区路径已变更，请重新从主机选择')
  return checked
}
