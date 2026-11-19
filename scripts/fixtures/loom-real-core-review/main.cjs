// Isolated Electron pointer driver for real Core owner-review transport.
// No daily profile or production bootstrap. A short-lived authenticated 127.0.0.1
// fixture proxy relays to the real Core; no external network or user credentials.
const assert=require('node:assert/strict')
const {app,BrowserWindow,ipcMain}=require('electron')
const fs=require('node:fs')
const path=require('node:path')
const [renderer,userData,output,missionId,artifactId,portString]=process.argv.slice(2)
for(const p of [renderer,userData,output]) assert(path.isAbsolute(p),'Isolated absolute paths required')
const port=Number(portString)
const token=process.env.LOOM_QA_TOKEN
assert(missionId&&artifactId&&Number.isInteger(port)&&port>0&&port<65536&&token)
const methods=new Set(['preferences.tasks.get','loom.tasks.list','loom.candidates.list',
 'loom.artifacts.list','loom.reviews.list','loom.artifact.preview','loom.review.record'])
async function coreRequest(method,params){
 if(!methods.has(method))throw new Error('Fixture RPC method not allowlisted: '+method)
 const response=await fetch('http://127.0.0.1:'+port+'/',{
  method:'POST',headers:{'content-type':'application/json','x-loom-qa-token':token},
  body:JSON.stringify({method,params}),signal:AbortSignal.timeout(30000)
 })
 const message=await response.json()
 if(!response.ok||!message.ok){
  const error=new Error(message.error?.message||'Isolated Core RPC rejected')
  error.kind=message.error?.kind;error.code=message.error?.code;throw error
 }
 return message.result
}
ipcMain.handle('loomqa:core-request',(_event,input)=>{
 if(!input||typeof input.method!=='string')throw new Error('Invalid fixture request')
 return coreRequest(input.method,input.params)
})
fs.mkdirSync(userData,{recursive:true})
fs.mkdirSync(output,{recursive:true})
app.setPath('userData',userData)
app.setPath('sessionData',path.join(userData,'session'))
const cases=[]
let stage='startup'
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:true,width:1160,height:820,
  webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,
    preload:path.join(__dirname,'preload.cjs'),backgroundThrottling:false}})
 const sleep=ms=>new Promise(r=>setTimeout(r,ms))
 const js=expr=>win.webContents.executeJavaScript(expr,true)
 const wait=async expr=>{const end=Date.now()+15000;while(Date.now()<end){
  if(await js(expr))return;await sleep(60)}throw new Error('Timeout: '+expr)}
 const click=async selector=>{
  const point=await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});
   if(!e)throw new Error('missing target ${selector}');
   e.scrollIntoView({block:'center'});
   const b=e.getBoundingClientRect(),x=Math.round(b.x+b.width/2),y=Math.round(b.y+b.height/2);
   const hit=document.elementFromPoint(x,y);if(hit!==e&&!e.contains(hit))throw new Error('target covered');
   return{x,y}})()`)
  win.webContents.sendInputEvent({type:'mouseMove',...point})
  win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...point})
  win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...point})
  await sleep(120)
 }
 try{
  const archive=await coreRequest('loom.artifacts.list',{missionId})
  const selectedArtifact=archive?.artifacts?.find(row=>row.artifactId===artifactId)
  assert.ok(selectedArtifact?.taskId,'Core must own the selected archived artifact')
  const archivedPreview=await coreRequest('loom.artifact.preview',{missionId,artifactId})
  assert.equal(archivedPreview.artifactId,artifactId)
  assert.ok(typeof archivedPreview.text==='string'&&archivedPreview.text.trim(),
   'Do not claim a UI preview without readable Core archive bytes')
  const visibleMarker=archivedPreview.text.split(/\r?\n/).find(line=>line.trim())
   .replace(/^#{1,6}\s+/,'').trim()
  await win.loadFile(renderer,{query:{missionId,artifactId}})
  await wait("document.querySelector('#fixture-status')?.textContent==='real-core-ready'")
  assert.deepEqual(await coreRequest('loom.reviews.list',{missionId}),[])
  cases.push('production renderer loaded real Core candidate without any review')
  stage='opening artifact'
  await click('#open-review')
  await wait("!!document.querySelector('.ln-artifact-dialog')&&!!document.querySelector('.ln-artifact-review-composer')")
  await wait(`document.body.innerText.includes(${JSON.stringify(visibleMarker)})`)
  assert.deepEqual(await coreRequest('loom.reviews.list',{missionId}),[],
   'preview must be read-only even through actual Electron pointer navigation')
  cases.push('real pointer opens actual archived Core text with zero writes')
  stage='explicit review'
  await click('.ln-artifact-review-composer .ln-artifact-accept')
  await click('.ln-artifact-review-criteria input[type=checkbox]')
  await click('#ln-artifact-reason')
  await win.webContents.insertText('Explicit isolated test pointer approval, after reading Core archive.')
  assert.deepEqual(await coreRequest('loom.reviews.list',{missionId}),[])
  await click('.ln-artifact-review-form button[type=submit]')
  await wait("document.body.innerText.includes('验收已记录：')")
  const reviews=await coreRequest('loom.reviews.list',{missionId})
  const candidates=await coreRequest('loom.candidates.list',{missionId})
  assert.equal(reviews.length,1)
  assert.equal(reviews[0].reviewerId,'local_user','Core injects authenticated local test identity')
  assert.equal(reviews[0].verdict,'accepted')
  assert.equal(candidates.filter(c=>c.acceptanceStatus==='accepted').length,1)
  assert.equal(candidates.filter(c=>c.acceptanceStatus==='pending').length,1)
  assert.equal(candidates.find(c=>c.acceptanceStatus==='accepted').taskId,selectedArtifact.taskId,
   'UI must accept exactly the selected Core artifact task, not a hard-coded fixture id')
  cases.push('Electron pointer submit -> production ArtifactView -> real Core persistent Review')
  cases.push('second independent candidate remains pending')
  const screenshot=path.join(output,'real-core-after-review.png')
  let screenshotCaptured=false,screenshotFailure=null
  try{
   const png=(await win.webContents.capturePage()).toPNG()
   if(png.length===0)throw new Error('empty_capture')
   fs.writeFileSync(screenshot,png)
   screenshotCaptured=true
  }catch(error){
   // Some unattended Windows display sessions reject capturePage after real
   // pointer/review assertions already passed. Preserve this missing visual
   // evidence explicitly; never claim a screenshot was captured.
   screenshotFailure='display_capture_unavailable'
  }
  const report={ok:true,scope:'E3-isolated-Electron-production-React-real-Core',
    realCore:true,realPiExecutedInThisScenario:false,commercialProvider:false,
    actualElectronPointerInput:true,actualHumanUserClick:false,
    reviews:1,accepted:1,pending:1,port64851Touched:false,
    userDailyDatabaseTouched:false,E4:'NOT_VERIFIED',E5:'NOT_RUN',
    E6:'NOT_VERIFIED',E7:'NOT_RUN',cases,
    screenshotCaptured,screenshotFailure,
    screenshot:screenshotCaptured?screenshot:null}
  fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2))
  console.log(JSON.stringify(report))
  win.destroy();app.exit(0)
 }catch(error){
  const rendererStatus=await js("document.querySelector('#fixture-status')?.textContent||'missing'").catch(e=>'cannot-evaluate:'+String(e))
  const report={ok:false,stage,rendererStatus,error:String(error),stack:error?.stack,cases}
  fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2))
  console.error(JSON.stringify(report))
  win.destroy();app.exit(1)
 }
}).catch(error=>{console.error(error);app.exit(1)})
