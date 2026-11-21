import { describe, expect, it, vi } from 'vitest'
import type { MissionRecord } from '@contracts'
import type { ThreadClient } from '../camp-client'
import { WorkBundleCache } from './work-bundle-cache'

const mission = (id: string, version = 'v1') => ({
  missionId:id, title:id, threadId:id, updatedAt:version
}) as MissionRecord
const snapshot = (missionId:string) => ({missionId,policy:null,stageReviews:[],dispatches:[],evaluatedAt:'2026-11-13T00:00:00Z'})
function fake() {
  const request = vi.fn(async (method:string, params?:{missionIds?:string[];missionId?:string}) => {
    if(method==='loom.bundles.getMany') return {bundles:(params?.missionIds??[]).map(id=>({missionId:id,plan:null,tasks:[],candidates:[],reviews:[],verifications:[],artifacts:{artifacts:[]}}))}
    if(method==='loom.control.get') return snapshot(String(params?.missionId??''))
    if(method==='loom.plan.get') return null
    if(method==='loom.artifacts.list') return {artifacts:[]}
    return []
  })
  return {request} as unknown as Pick<ThreadClient,'request'> & {request:typeof request}
}
const calls = (request:{mock:{calls:Array<[string, ...unknown[]]>}}, name:string) =>
  request.mock.calls.filter(([method]) => method === name).length
describe('one authenticated LOOM work projection cache', () => {
  it('deduplicates navigation/focus reads but never suppresses explicit/dirty reads',async () => {
    const cache=new WorkBundleCache()
    const client=fake()
    const first=await cache.read(client,[mission('a'),mission('b')])
    expect(first.bundles).toHaveLength(2)
    expect(calls(client.request,'loom.bundles.getMany')).toBe(1)
    expect(calls(client.request,'loom.control.get')).toBe(2)
    const unchanged=await cache.read(client,[mission('a'),mission('b')])
    expect(unchanged.fetched).toBe(0)
    expect(calls(client.request,'loom.bundles.getMany')).toBe(1)
    expect(unchanged.bundles[0]).toBe(first.bundles[0])
    cache.invalidate('a')
    const changed=await cache.read(client,[mission('a'),mission('b')])
    expect(changed.fetched).toBe(1)
    expect(calls(client.request,'loom.bundles.getMany')).toBe(2)
    expect(calls(client.request,'loom.control.get')).toBe(3)
    await cache.read(client,[mission('a'),mission('b')],true)
    expect(calls(client.request,'loom.bundles.getMany')).toBe(3)
    expect(calls(client.request,'loom.control.get')).toBe(5)
    expect((await cache.read(client,[mission('b')])).bundles).toHaveLength(1)
  })
  it('re-reads changed Mission revisions without a separate dirty event',async () => {
    const cache=new WorkBundleCache()
    const client=fake()
    await cache.read(client,[mission('a')])
    await cache.read(client,[mission('a','v2')])
    expect(calls(client.request,'loom.bundles.getMany')).toBe(2)
    expect(calls(client.request,'loom.control.get')).toBe(2)
  })
  it('shares pending read for concurrent unchanged Mission versions',async () => {
    const cache=new WorkBundleCache(),client=fake()
    const [a,b]=await Promise.all([cache.read(client,[mission('a')]),cache.read(client,[mission('a')])])
    expect(a.bundles).toHaveLength(1);expect(b.bundles).toHaveLength(1)
    expect(calls(client.request,'loom.bundles.getMany')).toBe(1)
    expect(calls(client.request,'loom.control.get')).toBe(1)
  })
  it('does not join a pre-invalidation request or let its late response overwrite new work',async () => {
    const cache=new WorkBundleCache()
    const resolveRead:Array<(value:unknown)=>void>=[]
    const request=vi.fn((method:string,params?:{missionId?:string})=>{
      if(method==='loom.bundles.getMany') return new Promise<unknown>(resolve=>resolveRead.push(resolve))
      if(method==='loom.control.get') return Promise.resolve(snapshot(String(params?.missionId??'a')))
      throw Error(`unexpected ${method}`)
    })
    const client={request} as unknown as Pick<ThreadClient,'request'>
    const response=(title:string)=>({bundles:[{missionId:'a',plan:null,
      tasks:[{taskId:'task-a',title}],candidates:[],reviews:[],verifications:[],artifacts:{artifacts:[]}}]})
    const stale=cache.read(client,[mission('a')])
    cache.invalidate('a')
    const fresh=cache.read(client,[mission('a')])
    expect(calls(request as unknown as {mock:{calls:Array<[string, ...unknown[]]>}},'loom.bundles.getMany')).toBe(2)
    resolveRead[1](response('after approval'))
    expect((await fresh).bundles[0].tasks[0].title).toBe('after approval')
    resolveRead[0](response('before approval'))
    await stale
    const cached=await cache.read(client,[mission('a')])
    expect(cached.bundles[0].tasks[0].title).toBe('after approval')
    expect(cached.fetched).toBe(0)
    expect(calls(request as unknown as {mock:{calls:Array<[string, ...unknown[]]>}},'loom.bundles.getMany')).toBe(2)
  })
  it('keeps an invalidation dirty when only the old in-flight read has finished',async () => {
    const cache=new WorkBundleCache()
    const resolveRead:Array<(value:unknown)=>void>=[]
    const request=vi.fn((method:string,params?:{missionId?:string})=>method==='loom.bundles.getMany'
      ? new Promise<unknown>(resolve=>resolveRead.push(resolve))
      : Promise.resolve(snapshot(String(params?.missionId??'a'))))
    const client={request} as unknown as Pick<ThreadClient,'request'>
    const response={bundles:[{missionId:'a',plan:null,tasks:[],candidates:[],reviews:[],verifications:[],artifacts:{artifacts:[]}}]}
    const stale=cache.read(client,[mission('a')])
    cache.invalidate()
    resolveRead[0](response)
    expect((await stale).bundles).toHaveLength(0)
    const fresh=cache.read(client,[mission('a')])
    expect(calls(request as unknown as {mock:{calls:Array<[string, ...unknown[]]>}},'loom.bundles.getMany')).toBe(2)
    resolveRead[1](response)
    expect((await fresh).bundles).toHaveLength(1)
  })
  it('marks a failed projection as error and retries instead of showing cached success',async () => {
    const cache=new WorkBundleCache()
    let broken = false
    const request = vi.fn(async(method:string,params?:{missionIds?:string[];missionId?:string})=>{
      if(method==='loom.bundles.getMany') {
        if (broken) throw Error('offline')
        return {bundles:(params?.missionIds??[]).map(id=>({missionId:id,plan:null,tasks:[],candidates:[],reviews:[],verifications:[],artifacts:{artifacts:[]}}))}
      }
      if(broken&&method==='loom.tasks.list') throw Error('offline')
      if(method==='loom.control.get') return snapshot(String(params?.missionId??'a'))
      return method==='loom.plan.get' ? null : method==='loom.artifacts.list' ? {artifacts:[]} : []
    })
    const client={request} as unknown as Pick<ThreadClient,'request'>
    expect((await cache.read(client,[mission('a')])).bundles).toHaveLength(1)
    broken=true;cache.invalidate('a')
    const failed=await cache.read(client,[mission('a')])
    expect(failed.bundles).toHaveLength(0);expect(failed.errors).toHaveLength(1)
    broken=false
    expect((await cache.read(client,[mission('a')])).bundles).toHaveLength(1)
  })
})
