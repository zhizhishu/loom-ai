import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

export async function openMinimaxAcp(fixture, bootstrapFile) {
  const child=spawn(process.execPath,[process.env.ROVAI_MINIMAX_NATIVE_SCRIPT,'acp','--append-system-prompt-file',bootstrapFile],{
    cwd:fixture.project,env:fixture.environment,windowsHide:true,stdio:['pipe','pipe','pipe']})
  const pending=new Map(),events=[];let id=0,stderr=''
  const closed=new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal})))
  child.stderr.on('data',part=>{stderr=(stderr+part).slice(-16000)})
  const rejectAll=error=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(error)}pending.clear()}
  child.once('error',rejectAll);child.once('exit',code=>rejectAll(new Error(`Native ACP exited: ${code}`)))
  createInterface({input:child.stdout}).on('line',line=>{
    let message;try{message=JSON.parse(line)}catch{return}
    events.push(message)
    if(message.method && message.id!==undefined){
      child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:message.id,...(message.method==='session/request_permission'?{result:{outcome:{outcome:'cancelled'}}}:{error:{code:-32601,message:'Unsupported verification client method'}})})+'\n');return
    }
    const p=pending.get(message.id);if(!p)return;pending.delete(message.id);clearTimeout(p.timer)
    message.error?p.reject(Object.assign(new Error(message.error.message),{rpcError:message.error})):p.resolve(message.result)
  })
  const client={events,child,get stderr(){return stderr},request(method,params={},timeout=180000){return new Promise((resolve,reject)=>{
    const next=++id,timer=setTimeout(()=>{pending.delete(next);reject(new Error('Native ACP timeout: '+method))},timeout)
    pending.set(next,{resolve,reject,timer});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:next,method,params})+'\n')
  })},notify(method,params){child.stdin.write(JSON.stringify({jsonrpc:'2.0',method,params})+'\n')},async close(){child.stdin.end();const timer=setTimeout(()=>child.kill(),8000);const result=await closed;clearTimeout(timer);return result}}
  await client.request('initialize',{protocolVersion:1,clientCapabilities:{},clientInfo:{name:'rovai-windows-qualification',version:'1'}})
  return client
}
