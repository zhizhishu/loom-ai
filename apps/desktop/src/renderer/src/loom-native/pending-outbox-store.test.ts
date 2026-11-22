import { beforeEach,expect,it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { deleteOutbox,enqueueOutbox,readOutbox,updateOutbox,type PendingRecord } from './pending-outbox-store'
import { PendingInboxList } from './PendingInbox'

it('rechecks durable state before deleting a stale pending card',()=>{
 const r=row();enqueueOutbox(r,storage);updateOutbox(r,'sending',undefined,storage);updateOutbox(r,'accepted',undefined,storage)
 expect(()=>deleteOutbox(r,storage)).toThrow('检查')
 expect(readOutbox('t',storage)[0]?.state).toBe('accepted')
})
it('rejects reused identities with a different fingerprint and never loads a partial ledger',()=>{
 const r=row();enqueueOutbox(r,storage)
 expect(()=>enqueueOutbox({...r,fingerprint:'different'},storage)).toThrow('身份重复')
 data.set('loom.pending-outbox.v1:t',JSON.stringify([r,{...r,id:'two',fingerprint:'other'}]))
 expect(()=>readOutbox('t',storage)).toThrow('损坏')
 data.set('loom.pending-outbox.v1:t','not json')
 expect(()=>readOutbox('t',storage)).toThrow()
})
let data:Map<string,string>
beforeEach(()=>{data=new Map()})
const storage={getItem:(k:string)=>data.get(k)??null,setItem:(k:string,v:string)=>{data.set(k,v)},removeItem:(k:string)=>{data.delete(k)}}
const row=():PendingRecord=>({id:'one',threadId:'t',text:'hello',fingerprint:'f',commandId:'c',params:{threadId:'t',commandId:'c',sourceAttachments:[]},state:'pending',createdAt:'now'})
it('handles empty ledgers and deduplicates fingerprints',()=>{
 expect(readOutbox('t',storage)).toEqual([])
 enqueueOutbox(row(),storage);enqueueOutbox({...row(),id:'two'},storage)
 expect(readOutbox('t',storage)).toHaveLength(1)
})
it('keeps delivery uncertainty and never rolls accepted back',()=>{
 const r=row();enqueueOutbox(r,storage);updateOutbox(r,'sending',undefined,storage)
 expect(readOutbox('t',storage)[0]?.state).toBe('unconfirmed')
 updateOutbox(r,'accepted',undefined,storage)
 expect(()=>updateOutbox(r,'pending',undefined,storage)).toThrow()
 expect(()=>deleteOutbox({...r,state:'unconfirmed'},storage)).toThrow()
})
it('rejects malformed or attachment-bearing ledgers as a whole',()=>{
 data.set('loom.pending-outbox.v1:t','[{}]')
 expect(()=>readOutbox('t',storage)).toThrow('损坏')
 data.clear()
 expect(()=>enqueueOutbox({...row(),params:{...row().params,sourceAttachments:[{}]}},storage)).toThrow()
})
it('reports storage failures without pretending success',()=>{
 expect(()=>enqueueOutbox(row(),{...storage,setItem:()=>{throw new Error('blocked')}})).toThrow('blocked')
})
it('renders plain-language states, explicit actions and a collapsed completed list',()=>{
 const rows=(['pending','sending','unconfirmed','rejected','accepted'] as const).map(state=>({...row(),id:state,state}))
 const html=renderToStaticMarkup(createElement(PendingInboxList,{rows,onAction:()=>{}}))
 for(const label of ['还没发出','正在发送…','可能已送达，待确认','发送失败','已送达','检查是否送达','再检查一次'])expect(html).toContain(label)
 expect(html).toContain('<details>');expect(html).not.toContain('<details open')
 const empty=renderToStaticMarkup(createElement(PendingInboxList,{rows:[],onAction:()=>{}}))
 expect(empty).toContain('没有待发送的消息')
 expect(empty).toContain('不会自动重发')
 const broken=renderToStaticMarkup(createElement(PendingInboxList,{rows:[],loadError:'记录损坏',onAction:()=>{}}))
 expect(broken).toContain('role="alert"');expect(broken).not.toContain('没有待发送的消息')
})
