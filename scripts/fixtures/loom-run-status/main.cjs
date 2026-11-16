const assert=require('node:assert/strict');const {app,BrowserWindow}=require('electron');const fs=require('node:fs');const path=require('node:path');
const [renderer,userData,output]=process.argv.slice(2);
for(const item of [renderer,userData,output])assert(path.isAbsolute(item),'Isolated absolute paths required');
fs.mkdirSync(userData,{recursive:true});fs.mkdirSync(output,{recursive:true});app.setPath('userData',userData);app.setPath('sessionData',path.join(userData,'session'));
const cases=[],shots=[];let stage='startup';
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:true,width:1440,height:920,useContentSize:true,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
 const js=expr=>win.webContents.executeJavaScript(expr,true);const sleep=ms=>new Promise(r=>setTimeout(r,ms));
 const wait=async(expr)=>{const until=Date.now()+10000;while(Date.now()<until){if(await js(expr))return;await sleep(40)}throw new Error('Timeout '+expr)};
 const click=async(selector)=>{const point=await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw new Error('missing target');e.scrollIntoView({block:'center'});const b=e.getBoundingClientRect();const x=Math.round(b.x+b.width/2),y=Math.round(b.y+b.height/2);const hit=document.elementFromPoint(x,y);if(hit!==e&&!e.contains(hit))throw new Error('target covered');return{x,y}})()`);win.webContents.sendInputEvent({type:'mouseMove',...point});win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...point});win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...point});await sleep(100)};
 try{
 await win.loadFile(renderer);await wait('!!window.runStatusQA');await click('#open-runs');await wait("!!document.querySelector('.ln-run-panel')");
 assert(await js("document.querySelector('.ln-run-panel').innerText.includes('Hanzi')"));cases.push('actual click opens production React run dialog');
 assert(!(await js("document.body.innerText.includes('Loopback')||document.body.innerText.includes('当前真实 Provider 未核验')")));cases.push('no invented provider provenance');
 assert(await js("!document.querySelector('.ln-run-diagnostics').open"));cases.push('technical diagnosis starts collapsed');
 await click('.ln-run-file');assert.equal(await js('runStatusQA.selected()'),'A:artifact-A');cases.push('file click keeps exact mission and artifact identity');
 await js("runStatusQA.setMode('failure');runStatusQA.refresh()");await wait("document.body.innerText.includes('Fixture connection unavailable')");cases.push('read failure visible with local refresh action');
 await js("runStatusQA.setMode('success')");await click('[aria-label="刷新运行与成果"]');await wait("!document.body.innerText.includes('Fixture connection unavailable')");cases.push('same-view retry recovers');
 await js("runStatusQA.setMode('deferred');runStatusQA.refresh()");await wait("document.body.innerText.includes('正在更新')");assert(await js("!!document.querySelector('.ln-run-file')"));cases.push('same-work refresh preserves coherent content');
 await js("runStatusQA.switchWork('B')");await wait("!document.querySelector('[data-mission-id=\"A\"]')");cases.push('switching work hides old snapshot before reply');
 await js("runStatusQA.release('B')");await wait("!!document.querySelector('[data-mission-id=\"B\"]')");await js("runStatusQA.release('A')");await sleep(120);assert(await js("!!document.querySelector('[data-mission-id=\"B\"]')&&!document.querySelector('[data-mission-id=\"A\"]')"));cases.push('late reply cannot overwrite current work');
 await click('.ln-run-file');assert.equal(await js('runStatusQA.selected()'),'B:artifact-B');cases.push('new work artifact callback cannot use old scope');
 await js("runStatusQA.setMode('success')");
 for(const [width,height] of [[1440,920],[1040,780],[760,800],[390,844]])for(const theme of ['day','night']){
  stage=`capture ${width} ${theme}`;win.setContentSize(width,height);await js(`runStatusQA.setTheme('${theme}')`);await sleep(180);
  const geometry=await js(`(()=>{const e=document.querySelector('.ln-run-dialog'),r=e.getBoundingClientRect();return {left:r.left,right:r.right,width:innerWidth,overflow:e.scrollWidth>e.clientWidth+1||[...e.querySelectorAll('.ln-run-panel,.ln-run-artifact,.ln-run-task')].some(x=>x.scrollWidth>x.clientWidth+1)}})()`);
  assert(geometry.left>=-1&&geometry.right<=geometry.width+1&&!geometry.overflow,JSON.stringify(geometry));
  const file=path.join(output,`${width}-${theme}.png`);fs.writeFileSync(file,(await win.webContents.capturePage()).toPNG());shots.push({width,theme,path:file});
 }
 cases.push('four actual viewport sizes and both themes without horizontal overflow');
 await js('runStatusQA.setEmpty(true)');await wait("document.body.innerText.includes('选择一项工作')");assert(!(await js("!!document.querySelector('.ln-run-panel')")));cases.push('no-work empty state does not retain prior task');
 win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});await wait("!document.querySelector('[role=dialog]')");cases.push('Escape closes modal');await wait("document.activeElement?.id==='open-runs'");cases.push('closing returns keyboard focus to opener');
 // Parent polling cannot starve a slow same-work request or fan out writes.
  await js("runStatusQA.setEmpty(false);runStatusQA.setMode('success');runStatusQA.switchWork('P')");await click('#open-runs');await wait("!!document.querySelector('[data-mission-id=\"P\"]')");
  const countBefore=await js('runStatusQA.calls.length');await js("runStatusQA.setMode('deferred');runStatusQA.refresh()");await wait("document.body.innerText.includes('正在更新')");
  await js('runStatusQA.refresh()');await sleep(80);await js('runStatusQA.refresh()');await sleep(80);
  assert.equal(await js('runStatusQA.calls.length'),countBefore+1);
  await js("runStatusQA.setMode('success');runStatusQA.release('P')");await wait("!document.body.innerText.includes('正在更新')");
  assert.equal(await js('runStatusQA.calls.length'),countBefore+2);cases.push('same-work polling coalesces and cannot starve the Host read');
  await js("runStatusQA.setReadTimeoutMs(500);runStatusQA.setMode('deferred');runStatusQA.refresh()");await wait("document.body.innerText.includes('读取超时')");
  assert(await js("!!document.querySelector('[data-mission-id=\"P\"]')&&!document.querySelector('[aria-label=\"刷新运行与成果\"]').disabled"));
  await js("runStatusQA.setMode('success')");await click('[aria-label="刷新运行与成果"]');await wait("!document.body.innerText.includes('读取超时')&&document.body.innerText.includes('认领有效')");
  await js("runStatusQA.releaseExpired('P')");await sleep(120);assert(!(await js("document.querySelector('.ln-run-panel').innerText.includes('认领已过期')")));
  await js('runStatusQA.setReadTimeoutMs(15000)');cases.push('hung read times out, supports explicit retry, and rejects its late reply');

  win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});await wait("!document.querySelector('[role=dialog]')");
  // Initial failure has no retained snapshot, unlike the refresh failure above.
  stage='initial empty read failure';await js("runStatusQA.setEmpty(false);runStatusQA.setMode('failure');runStatusQA.switchWork('C')");await click('#open-runs');
  await wait("document.body.innerText.includes('Fixture connection unavailable')");assert(await js("!!document.querySelector('[data-mission-id=\"C\"]')&&!document.querySelector('[data-mission-id=\"P\"]')"));assert(!(await js("document.querySelector('[aria-label=\"刷新运行与成果\"]').disabled")));cases.push('initial claims-read failure preserves only current work and an explicit retry');
  await js("runStatusQA.setMode('success')");await click('[aria-label="刷新运行与成果"]');await wait("!!document.querySelector('[data-mission-id=\"C\"]')");cases.push('initial failure can retry without reopening');
  // Real pointer navigation through production ArtifactView; synthetic write receipts only.
  win.setContentSize(1440,920);await js("runStatusQA.setTheme('day');runStatusQA.setOpenArtifacts(true);runStatusQA.setReviewMode('lose-once')");
  await click('.ln-run-file');await wait("!!document.querySelector('.ln-artifact-dialog')&&!!document.querySelector('.ln-markdown')");
  assert.equal(await js('runStatusQA.writes.length'),0);assert(await js("document.querySelector('.ln-artifact-dialog').contains(document.activeElement)"));cases.push('opening actual artifact text never submits a review and owns keyboard focus');
  await click('.ln-artifact-review-composer .ln-artifact-accept');await click('.ln-artifact-review-criteria input[type=checkbox]');await click('#ln-artifact-reason');
  await win.webContents.insertText('Verified responsive fixture evidence.');
  await click('[aria-label="关闭成果正文"]');await wait("!document.querySelector('.ln-artifact-dialog')");await click('#open-runs');await wait("!!document.querySelector('.ln-run-file')");await click('.ln-run-file');await wait("!!document.querySelector('#ln-artifact-reason')");
  assert.equal(await js("document.querySelector('#ln-artifact-reason').value"),'Verified responsive fixture evidence.');assert(await js("document.querySelector('.ln-artifact-review-criteria input').checked"));assert.equal(await js('runStatusQA.writes.length'),0);cases.push('closing an unsent review preserves text and checks without submitting');
  await click('.ln-artifact-review-form button[type=submit]');
  await wait("document.body.innerText.includes('Fixture receipt lost after commit')");
  assert.equal(await js('runStatusQA.writes.length'),1);assert(await js("document.querySelector('#ln-artifact-reason').readOnly&&document.querySelector('.ln-artifact-review-criteria').disabled"));cases.push('lost write receipt freezes payload and never claims accepted');
  assert(!(await js("document.body.innerText.includes('验收已记录：')")));
  for(const [width,height,theme] of [[1440,920,'day'],[390,844,'night']]) {
    stage=`artifact unknown ${width} ${theme}`;win.setContentSize(width,height);await js(`runStatusQA.setTheme('${theme}')`);await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');await sleep(200);
    assert.equal(await js("document.querySelector('.ln-artifact-dialog').closest('.ln-portal').dataset.theme"),theme);
    const material=await js("(()=>{const e=document.querySelector('.ln-artifact-dialog');const s=getComputedStyle(e);return{background:s.backgroundColor,text:s.color,token:s.getPropertyValue('--ln-bg'),scheme:s.colorScheme}})()");assert.equal(material.scheme,theme==='night'?'dark':'light');console.log(JSON.stringify({artifactTheme:theme,material}));
    const geometry=await js("(()=>{const e=document.querySelector('.ln-artifact-dialog'),r=e.getBoundingClientRect();return {left:r.left,right:r.right,width:innerWidth,overflow:e.scrollWidth>e.clientWidth+1}})()");
    assert(geometry.left>=-1&&geometry.right<=geometry.width+1&&!geometry.overflow,JSON.stringify(geometry));
    if(width<801){const scroll=await js("(()=>{const b=document.querySelector('.ln-artifact-body'),d=document.querySelector('.ln-artifact-document'),c=document.querySelector('.ln-artifact-context');return{body:getComputedStyle(b).overflowY,document:getComputedStyle(d).overflowY,context:getComputedStyle(c).overflowY}})()");assert.equal(scroll.body,'auto');assert.equal(scroll.document,'visible');assert.equal(scroll.context,'visible');}
    const file=path.join(output,`artifact-unknown-${width}-${theme}.png`);fs.writeFileSync(file,(await win.webContents.capturePage()).toPNG());shots.push({width,theme,path:file,material});
  }
  cases.push('unknown review remains readable at desktop and mobile sizes');
  win.setContentSize(1440,920);
  await click('[aria-label="关闭成果正文"]');await wait("!document.querySelector('.ln-artifact-dialog')&&document.activeElement?.id==='open-runs'");cases.push('artifact close restores focus even when originating run dialog is gone');
  await click('#open-runs');await wait("!!document.querySelector('.ln-run-file')");await click('.ln-run-file');await wait("document.body.innerText.includes('此前的验收请求尚未确认')");
  assert.equal(await js('runStatusQA.writes.length'),1);assert.equal(await js("document.querySelector('#ln-artifact-reason').value"),'Verified responsive fixture evidence.');cases.push('reopening restores the same unknown review without automatic writes');
  await click('.ln-artifact-review-form button[type=submit]');await wait("document.body.innerText.includes('验收已记录：')");
  const sent=await js('runStatusQA.writes');assert.equal(sent.length,2);assert.deepEqual(sent[0],sent[1]);assert(!('reviewerId' in sent[0]));cases.push('explicit retry replays exact commandId and payload without claiming Owner identity');
  assert(!(await js("!!document.querySelector('.ln-artifact-review-composer')")));cases.push('confirmed receipt locks further review actions');
  await click('[aria-label="关闭成果正文"]');await js("runStatusQA.switchWork('D')");await click('#open-runs');await wait("!!document.querySelector('[data-mission-id=\"D\"]')");await click('.ln-run-file');await wait("!!document.querySelector('.ln-artifact-dialog')");
  await js('runStatusQA.invalidateArtifact()');await wait("document.body.innerText.includes('重新取得当前记录前不能提交验收')");
  assert(!(await js("!!document.querySelector('.ln-artifact-review-composer')")));assert.equal(await js('runStatusQA.writes.length'),2);cases.push('changed artifact identity keeps text read-only and blocks review');
  await click('[aria-label="关闭成果正文"]');
  const report={ok:true,scope:'production-react-with-fixture-transport',realCore:false,realModel:false,cases,shots};fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));win.destroy();app.exit(0);
 }catch(error){const report={ok:false,stage,error:String(error),stack:error.stack,cases,shots};fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));console.error(JSON.stringify(report));win.destroy();app.exit(1)}
});
