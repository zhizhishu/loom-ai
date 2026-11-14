import type { MissionRecord } from '@contracts'
import type { ThreadClient } from '../camp-client'
import type { WorkBundle } from './types'
import { readWorkBundlesFast } from './service'

type Cached = { fingerprint: string; value: WorkBundle }
type WorkReader = Pick<ThreadClient, 'request'>

/** One cache per authenticated LOOM instance. Nothing private persists here.
 * Navigation-only/focus refresh reuses unchanged bundles instead of issuing
 * six RPCs per Mission, while true work changes force a re-read. */
export class WorkBundleCache {
  private readonly cache = new Map<string, Cached>()
  private readonly pending = new Map<string, ReturnType<typeof readWorkBundlesFast>>()
  private allDirty = false
  private readonly dirtyIds = new Set<string>()
  private epoch = 0
  invalidate(missionId?: string | null): void {
    if (missionId) this.dirtyIds.add(missionId)
    else this.allDirty = true
    this.epoch++
  }
  prime(bundle: WorkBundle): void {
    this.cache.set(bundle.mission.missionId, { fingerprint: JSON.stringify(bundle.mission), value: bundle })
  }
  async read(client: WorkReader, missions: readonly MissionRecord[], force = false): Promise<{ bundles: WorkBundle[]; errors: string[]; fetched: number }> {
    const ticket = this.epoch
    const keep = new Set(missions.map(mission => mission.missionId))
    for (const key of this.cache.keys()) if (!keep.has(key)) this.cache.delete(key)
    const need = missions.filter(mission => force || this.allDirty || this.dirtyIds.has(mission.missionId)
      || this.cache.get(mission.missionId)?.fingerprint !== JSON.stringify(mission))
    let fetched=0
    const key=need.map(mission=>mission.missionId+':'+JSON.stringify(mission)).join('|')
    const fallback={bundles:[] as WorkBundle[],errors:[] as string[]}
    let work=fallback
    if(need.length){
      let task=this.pending.get(key)
      if(!task){
        task=readWorkBundlesFast(client,need)
        this.pending.set(key,task)
        fetched=need.length
      }
      try {
        work=await task
        const incoming=new Map(work.bundles.map(bundle=>[bundle.mission.missionId,bundle]))
        for(const mission of need){
          const bundle=incoming.get(mission.missionId)
          if(bundle) this.cache.set(mission.missionId,{fingerprint:JSON.stringify(mission),value:bundle})
          else this.cache.delete(mission.missionId)
        }
      }finally{
        if(this.pending.get(key)===task) this.pending.delete(key)
      }
    }
    const errors=work.errors
    if(this.epoch===ticket) { this.allDirty = false; this.dirtyIds.clear() }
    const bundles = missions.flatMap(mission => {
      const row = this.cache.get(mission.missionId)
      return row?.fingerprint===JSON.stringify(mission) ? [row.value] : []
    }).sort((left,right)=>right.mission.updatedAt.localeCompare(left.mission.updatedAt))
    return {bundles,errors,fetched}
  }
}
