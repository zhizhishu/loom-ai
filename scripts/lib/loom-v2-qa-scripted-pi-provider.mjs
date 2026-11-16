// Fixture ONLY. An isolated 127.0.0.1 OpenAI-compatible scripted provider
// asks a REAL managed Pi Worker to use its guarded write tool exactly once.
// It is not a commercial model and deliberately stores no prompt/auth headers.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

export async function startQaGuardedWriteProvider({botId,relativePath,text}) {
 assert.equal(typeof botId,'string')
 assert.ok(/^[a-zA-Z0-9_-]{1,80}$/.test(botId))
 assert.ok(typeof relativePath==='string' && /^[a-zA-Z0-9_.-]{1,100}$/.test(relativePath))
 assert.ok(typeof text==='string' && text.length>0)
 const requests=[]
 const sockets=new Set()
 let sequence=0
 const server=createServer((req,res)=>{
  if(req.method!=='POST' || !req.url?.endsWith('/chat/completions')){
   res.writeHead(404,{'content-type':'application/json'});res.end('{}');return
  }
  let parts=[],size=0
  req.on('data',part=>{size+=part.length;if(size<=1024*1024)parts.push(part)})
  req.on('end',()=>{
   if(size>1024*1024){res.writeHead(413);res.end();return}
   let body
   try{body=JSON.parse(Buffer.concat(parts).toString('utf8'))}
   catch{res.writeHead(400);res.end('{}');return}
   requests.push({tools:(body.tools??[]).map(t=>t?.function?.name??t?.name)})
   res.writeHead(200,{'content-type':'text/event-stream; charset=utf-8',
    'cache-control':'no-store','x-loom-qa-mock':'true'})
   const turn=sequence++
   const base={id:'chatcmpl-isolated-'+botId+'-'+turn,object:'chat.completion.chunk',
    created:1,model:body.model}
   const emit=value=>res.write('data: '+JSON.stringify(value)+'\n\n')
   if(turn===0){
    emit({...base,choices:[{index:0,delta:{role:'assistant',tool_calls:[{
     index:0,id:'write-'+botId,type:'function',
     function:{name:'write',arguments:JSON.stringify({path:relativePath,content:text})}
    }]},finish_reason:null}]})
    emit({...base,choices:[{index:0,delta:{},finish_reason:'tool_calls'}],
     usage:{prompt_tokens:8,completion_tokens:4,total_tokens:12}})
   }else{
    emit({...base,choices:[{index:0,delta:{role:'assistant',content:'scripted completion'},
     finish_reason:null}]})
    emit({...base,choices:[{index:0,delta:{},finish_reason:'stop'}],
     usage:{prompt_tokens:8,completion_tokens:4,total_tokens:12}})
   }
   res.end('data: [DONE]\n\n')
  })
 })
 server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket))})
 await new Promise((ok,fail)=>{server.once('error',fail);server.listen(0,'127.0.0.1',ok)})
 return {port:server.address().port,requests,
  close:async()=>{
   for(const socket of sockets)socket.destroy()
   await new Promise(done=>server.close(done))
  }}
}
