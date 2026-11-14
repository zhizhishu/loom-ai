import {describe,it,expect,vi} from 'vitest'
import {isWorkspaceChoice,readWorkspaceDefault,writeWorkspaceDefault,validateWorkspaceDefault,WORKSPACE_DEFAULT_KEY} from './workspace-defaults'
describe('default workspace is a checked preference, never an authorization',()=>{
  it('persists a selected Host root but ignores garbage and old shapes',()=>{
    const data=new Map<string,string>()
    const storage={getItem:(x:string)=>data.get(x)??null,setItem:(x:string,v:string)=>{data.set(x,v)},removeItem:(x:string)=>{data.delete(x)}}
    expect(readWorkspaceDefault(storage)).toBeNull()
    writeWorkspaceDefault(storage,{name:'Project',projectPath:'C:\\src\\project'})
    expect(readWorkspaceDefault(storage)).toEqual({name:'Project',projectPath:'C:\\src\\project'})
    data.set(WORKSPACE_DEFAULT_KEY,JSON.stringify({version:5,workspace:{projectPath:'C:\\src',name:'x'}}))
    expect(readWorkspaceDefault(storage)).toBeNull()
    data.set(WORKSPACE_DEFAULT_KEY,'not json')
    expect(readWorkspaceDefault(storage)).toBeNull()
    writeWorkspaceDefault(storage,null)
    expect(data.has(WORKSPACE_DEFAULT_KEY)).toBe(false)
    expect(isWorkspaceChoice({name:'',projectPath:'C:\\x'})).toBe(false)
  })
  it('sends saved location through Core validate and refuses substituted paths',async()=>{
    const read=vi.fn().mockResolvedValue({name:'Project',projectPath:'C:\\src\\project'})
    await expect(validateWorkspaceDefault(read,{name:'Project',projectPath:'C:\\src\\project'})).resolves.toMatchObject({name:'Project'})
    expect(read).toHaveBeenCalledWith('workspaces.validate',{path:'C:\\src\\project'})
    read.mockResolvedValue({name:'Elsewhere',projectPath:'C:\\other'})
    await expect(validateWorkspaceDefault(read,{name:'Project',projectPath:'C:\\src\\project'})).rejects.toThrow()
  })
})
