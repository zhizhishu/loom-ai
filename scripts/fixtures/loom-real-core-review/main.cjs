// Isolated Electron pointer driver for real Core owner-review transport.
// No daily profile or production bootstrap. A short-lived authenticated 127.0.0.1
// fixture proxy relays to the real Core; no external network or user credentials.
//
// One production renderer, two isolated pointer flows:
//   (default)                 explicit Owner acceptance of one pending candidate
//   release-stage-review      the Owner's 退回重做 on a stage-review BLOCKED delivery
// Both click real DOM nodes through `sendInputEvent`; neither writes anything else.
const assert=require('node:assert/strict')
const {app,BrowserWindow,ipcMain}=require('electron')
const fs=require('node:fs')
const path=require('node:path')
const [renderer,userData,output,missionId,artifactId,portString,modeArgument]=process.argv.slice(2)
for(const p of [renderer,userData,output]) assert(path.isAbsolute(p),'Isolated absolute paths required')
const port=Number(portString)
const token=process.env.LOOM_QA_TOKEN
assert(missionId&&artifactId&&Number.isInteger(port)&&port>0&&port<65536&&token)
// An unknown mode is a fixture bug: silently accepting would run the wrong pointer flow.
const mode=modeArgument??'accept'
assert(['accept','release-stage-review'].includes(mode),'Unknown fixture mode: '+mode)
const methods=new Set(['preferences.tasks.get','loom.tasks.list','loom.candidates.list',
 'loom.artifacts.list','loom.reviews.list','loom.artifact.preview','loom.review.record'])
// The release flow adds the one write a stage review block offers; the accept flow cannot reach it.
if(mode==='release-stage-review')methods.add('loom.task.release')
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
 // The selected Core task as the UI would read it: the projection, never a hard-coded id.
 const taskOf=async selectedArtifact=>(await coreRequest('loom.tasks.list',{missionId}))
  .find(row=>row.taskId===selectedArtifact.taskId)??null

 // Default flow, unchanged: explicit pointer acceptance of one pending candidate.
 const acceptFlow=async selectedArtifact=>{
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
  return{reviews:1,accepted:1,pending:1}
 }

 // Release flow: the one write a stage review block offers. The pointer presses the button the
 // production `ArtifactReviewBlockedNotice` renders; the projection is re-read afterwards, so this
 // flow proves the notice disappears because Core moved, not because anything was cached.
 const releaseFlow=async selectedArtifact=>{
  stage='blocked projection'
  const before=await taskOf(selectedArtifact)
  assert.ok(before,'Core must project the blocked task of the selected artifact')
  assert.equal(before.status,'blocked','the release button only exists for a BLOCKED task, not '+before.status)
  const reason=String(before.blockedReason??'')
  assert.ok(reason.startsWith('stage review: '),'a stage review block carries its own reason prefix: '+reason)
  assert.deepEqual(await coreRequest('loom.reviews.list',{missionId}),[],
   'no Owner acceptance may exist before the redo')
  stage='opening blocked artifact'
  await click('#open-review')
  await wait("!!document.querySelector('.ln-artifact-dialog')&&!!document.querySelector('[data-action=\"release-stage-review\"]')")
  await wait(`document.body.innerText.includes(${JSON.stringify(visibleMarker)})`)
  // The reason the button is offered for is the reason the User reads.
  await wait("document.body.innerText.includes('stage review: ')")
  assert.deepEqual(await coreRequest('loom.reviews.list',{missionId}),[],
   'opening the blocked artifact must stay read-only')
  cases.push('real pointer opens the BLOCKED delivery and renders the stage review reason')
  stage='explicit release'
  await click('[data-action="release-stage-review"]')
  // A second press is sent on purpose: the renderer must keep exactly ONE write in flight (the
  // button disables itself and the service reuses its pending promise). The Node test counts the
  // requests that actually reached Core, so this records intent, not a claim.
  await sleep(160)
  const probe=await js(`(()=>{const e=document.querySelector('[data-action="release-stage-review"]');
   if(!e)return 'gone';
   if(e.disabled)return 'disabled';
   const b=e.getBoundingClientRect(),x=Math.round(b.x+b.width/2),y=Math.round(b.y+b.height/2);
   const hit=document.elementFromPoint(x,y);
   if(hit!==e&&!e.contains(hit))return 'covered';
   return 'point:'+x+','+y})()`)
  let secondPress=probe
  if(typeof probe==='string'&&probe.startsWith('point:')){
   const [x,y]=probe.slice('point:'.length).split(',').map(Number)
   win.webContents.sendInputEvent({type:'mouseMove',x,y})
   win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,x,y})
   win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,x,y})
   secondPress='pressed'
  }
  // The notice can only vanish because `onRefresh()` re-read the projection after the write.
  await wait("!document.querySelector('[data-action=\"release-stage-review\"]')")
  const after=await taskOf(selectedArtifact)
  assert.ok(after,'Core must still project the released task')
  assert.notEqual(after.status,'blocked',
   'the release must return the delivery to work, not leave it parked: '+JSON.stringify(after))
  assert.equal(String(after.blockedReason??''),'','the release clears the park reason it lifted')
  assert.deepEqual(await coreRequest('loom.reviews.list',{missionId}),[],
   '退回重做 is not an acceptance: no Owner review may exist yet')
  cases.push('Electron pointer press -> production ArtifactView -> real Core loom.task.release')
  cases.push('the refreshed projection left BLOCKED and dropped the stage review reason')
  if(secondPress!=='gone')cases.push('the second press was refused by the in-flight guard ('+secondPress+')')
  return{taskId:selectedArtifact.taskId,blockedReason:reason,taskStatusBefore:before.status,
   taskStatusAfter:after.status,secondPress,pointerPresses:secondPress==='pressed'?2:1}
 }

 let visibleMarker=''
 try{
  const archive=await coreRequest('loom.artifacts.list',{missionId})
  const selectedArtifact=archive?.artifacts?.find(row=>row.artifactId===artifactId)
  assert.ok(selectedArtifact?.taskId,'Core must own the selected archived artifact')
  const archivedPreview=await coreRequest('loom.artifact.preview',{missionId,artifactId})
  assert.equal(archivedPreview.artifactId,artifactId)
  assert.ok(typeof archivedPreview.text==='string'&&archivedPreview.text.trim(),
   'Do not claim a UI preview without readable Core archive bytes')
  visibleMarker=archivedPreview.text.split(/\r?\n/).find(line=>line.trim())
   .replace(/^#{1,6}\s+/,'').trim()
  await win.loadFile(renderer,{query:{missionId,artifactId}})
  await wait("document.querySelector('#fixture-status')?.textContent==='real-core-ready'")
  assert.deepEqual(await coreRequest('loom.reviews.list',{missionId}),[])
  cases.push('production renderer loaded real Core candidate without any review')
  const flowFacts=mode==='release-stage-review'
   ?await releaseFlow(selectedArtifact)
   :await acceptFlow(selectedArtifact)
  const screenshot=path.join(output,mode==='release-stage-review'
   ?'real-core-after-release.png':'real-core-after-review.png')
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
  const report={ok:true,scope:'E3-isolated-Electron-production-React-real-Core',mode,
    realCore:true,realPiExecutedInThisScenario:false,commercialProvider:false,
    actualElectronPointerInput:true,actualHumanUserClick:false,
    port64851Touched:false,userDailyDatabaseTouched:false,
    E4:'NOT_VERIFIED',E5:'NOT_RUN',E6:'NOT_VERIFIED',E7:'NOT_RUN',
    ...flowFacts,cases,
    screenshotCaptured,screenshotFailure,
    screenshot:screenshotCaptured?screenshot:null}
  fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2))
  console.log(JSON.stringify(report))
  win.destroy();app.exit(0)
 }catch(error){
  const rendererStatus=await js("document.querySelector('#fixture-status')?.textContent||'missing'").catch(e=>'cannot-evaluate:'+String(e))
  const report={ok:false,mode,stage,rendererStatus,error:String(error),stack:error?.stack,cases}
  fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2))
  console.error(JSON.stringify(report))
  win.destroy();app.exit(1)
 }
}).catch(error=>{console.error(error);app.exit(1)})
