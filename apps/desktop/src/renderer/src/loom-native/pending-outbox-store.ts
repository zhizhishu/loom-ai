// Adapted from PiBot pending-store.js: one client ledger, no automatic flush.
export type PendingState = 'pending' | 'sending' | 'unconfirmed' | 'rejected' | 'accepted'
export type PendingRecord = { id:string; threadId:string; text:string; fingerprint:string; commandId:string;
  params:Record<string,unknown>; state:PendingState; createdAt:string; error?:string }
type OutboxStorage = Pick<Storage,'getItem'|'setItem'|'removeItem'>
const prefix='loom.pending-outbox.v1:'
const states:PendingState[]=['pending','sending','unconfirmed','rejected','accepted']
const transitions:Record<PendingState,PendingState[]>={
  pending:['sending'],sending:['unconfirmed','accepted','rejected'],unconfirmed:['pending','accepted','rejected'],
  rejected:['pending','accepted'],accepted:[]
}
function valid(value:unknown,threadId:string):value is PendingRecord {
  if(!value||typeof value!=='object')return false
  const r=value as PendingRecord
  return ['id','threadId','text','fingerprint','commandId','createdAt'].every(k=>typeof (r as unknown as Record<string,unknown>)[k]==='string') &&
    r.threadId===threadId && states.includes(r.state) && !!r.params && typeof r.params==='object' &&
    r.params.commandId===r.commandId && r.params.threadId===r.threadId &&
    Array.isArray(r.params.sourceAttachments) && r.params.sourceAttachments.length===0
}
export function readOutbox(threadId:string,storage:OutboxStorage=window.localStorage):PendingRecord[] {
  const raw=storage.getItem(prefix+threadId)
  if(raw===null)return []
  let rows:unknown
  try{rows=JSON.parse(raw)}catch{throw new Error('待发送记录损坏；未加载任何消息。')}
  if(!Array.isArray(rows)||!rows.every(r=>valid(r,threadId))||
    new Set(rows.map(r=>r.id)).size!==rows.length || new Set(rows.map(r=>r.commandId)).size!==rows.length ||
    new Set(rows.map(r=>r.fingerprint)).size!==rows.length)
    throw new Error('待发送记录损坏；未加载任何消息。')
  return rows.map(r=>r.state==='sending'?{...r,state:'unconfirmed'}:r)
}
function write(threadId:string,rows:PendingRecord[],storage:OutboxStorage) {
  const value=JSON.stringify(rows)
  storage.setItem(prefix+threadId,value)
  if(storage.getItem(prefix+threadId)!==value)throw new Error('待发送记录未能保存。')
  if(typeof window!=='undefined' && typeof window.dispatchEvent==='function')window.dispatchEvent(new Event('loom-outbox-changed'))
}
export function enqueueOutbox(record:PendingRecord,storage:OutboxStorage=window.localStorage) {
  const rows=readOutbox(record.threadId,storage)
  if(!valid(record,record.threadId))throw new Error('待发送消息格式无效。')
  if(rows.some(r=>r.fingerprint===record.fingerprint))return
  if(rows.some(r=>r.id===record.id||r.commandId===record.commandId))throw new Error('待发送消息身份重复。')
  write(record.threadId,[record,...rows],storage)
}
export function updateOutbox(record:PendingRecord,state:PendingState,error?:string,storage:OutboxStorage=window.localStorage) {
  const rows=readOutbox(record.threadId,storage)
  const prior=rows.find(r=>r.id===record.id)
  if(!prior)throw new Error('消息已不存在。')
  if(prior.state!==state&&!transitions[prior.state].includes(state))throw new Error('消息状态不可回退。')
  write(record.threadId,rows.map(r=>r.id===record.id?{...r,state,error}:r),storage)
}
export function deleteOutbox(record:PendingRecord,storage:OutboxStorage=window.localStorage) {
  const rows=readOutbox(record.threadId,storage)
  const prior=rows.find(r=>r.id===record.id)
  if(!prior||prior.state!=='pending')throw new Error('请先检查消息是否送达。')
  write(record.threadId,rows.filter(r=>r.id!==record.id),storage)
}
