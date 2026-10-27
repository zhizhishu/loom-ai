import type { AdapterKind, RuntimeModelCatalogTarget, RuntimeModelCatalogView, RovaiApi } from '@contracts'
import { desktopThreadClient } from './desktop-camp-client'

export type ProductRuntimeCheckResult = {
  scheduled: true
  completed: true
  ready: boolean
  outcome: 'ready' | 'stable_failure' | 'deferred'
  status: 'ready' | 'stable_failure' | 'deferred'
  runtimeKind: AdapterKind
}

export async function requestProductRuntimeCheck(runtimeKind: AdapterKind, request: RovaiApi['request'] = desktopThreadClient.request): Promise<ProductRuntimeCheckResult> {
  // Checks reuse valid discovery inputs; Core refreshes them when the entry is missing.
  return request<ProductRuntimeCheckResult>('runtime.product.check', { runtimeKind })
}

export function openRuntimeModelCatalog(runtimeKind: AdapterKind, request: RovaiApi['request'] = desktopThreadClient.request, waitForRefresh = false, target?: RuntimeModelCatalogTarget): Promise<RuntimeModelCatalogView> {
  return request<RuntimeModelCatalogView>('runtime.modelCatalog.open', {
    runtimeKind,
    ...(waitForRefresh ? { waitForRefresh: true } : {}),
    ...(runtimeKind === 'deepseek-harness' && target ? target : {})
  })
}

// One local read in flight, with one trailing read for invalidations received
// during it. The same rule applies while the trailing read is in progress.
export function createRuntimeRefresh<T>(read: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | null = null
  let again = false
  return () => {
    again = true
    if (pending) return pending
    pending = Promise.resolve().then(async () => {
      try {
        while (true) {
          again = false
          try {
            const result = await read()
            if (!again) return result
          } catch (error) { if (!again) throw error }
        }
      } finally { pending = null }
    })
    return pending
  }
}
