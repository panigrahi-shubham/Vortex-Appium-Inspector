import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Application } from '../../src/application.ts';
import { MockAppium } from '../fixtures/mock-appium.ts';
import { detectPython } from '../../src/engines/appium/python-env.ts';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
async function setup(t: {after(fn:()=>Promise<void>):void}, options = {}) {
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'vortex-appium-test-'));
  const mock=new MockAppium(options); await mock.listen(0);
  const app=new Application(root,path.join(temp,'generated'),path.join(temp,'state'));
  await app.init(); await app.manager.connectExisting({host:'127.0.0.1',port:mock.port});
  t.after(async()=>{await app.shutdown();await mock.close();fs.rmSync(temp,{recursive:true,force:true});});
  await app.start('mock-device','com.yourname.tradehub');
  return {app,mock,temp};
}
const byId=(app:Application,suffix:string)=>app.snapshot!.nodes.find(n=>n.resourceId.endsWith(suffix))!.index;
const act=(app:Application,type:string,extra:Record<string,unknown>={})=>app.action({token:app.snapshot!.token,type,...extra});

test('full screenshot pixels map point taps even when the app window excludes Android system bars', async t => {
  const { app } = await setup(t);
  const session = app.inspector.session();
  const xml = (await session.pageSource()).replace(/ width="1080" height="2400"/, '');
  session.pageSource = async () => xml;
  session.windowRect = async () => ({ x: 0, y: 90, width: 1080, height: 2175 });
  const capture = await app.capture(false);
  assert.equal(capture.width, 1080);
  assert.equal(capture.height, 2400, 'the displayed screenshot and coordinate validation share full-screen pixels');
  await act(app, 'tap', { coordinate: true, x: 500, y: 2300 });
  assert.equal(app.steps.at(-1)!.y, 2300);
  assert.deepEqual(app.recordedSize, { width: 1080, height: 2400 });
});
test('Appium recording: fill, assert, navigate, coordinates, Plain/POM save and real pytest replay', {timeout:120_000}, async t=>{
  const {app,mock}=await setup(t);
  assert.equal(mock.sessions.size,1);
  const stale=app.snapshot!.token;
  await act(app,'launch_app');
  assert.equal(app.steps.length,1);
  await assert.rejects(()=>app.action({token:stale,type:'tap',index:0}),/screen changed/i);
  await act(app,'type',{index:byId(app,'home_search_input'),args:{text:'steel pipes'}});
  await act(app,'assert',{index:byId(app,'home_search_input'),args:{assertion:'text',expected:'steel pipes'}});
  await act(app,'tap',{index:byId(app,'home_my_products_button')});
  await act(app,'assert',{index:byId(app,'myproducts_title_text'),args:{assertion:'visible'}});
  const rowCount=app.snapshot!.nodes.filter(n=>n.resourceId.endsWith('myproduct_row_card')).length;
  await act(app,'assert',{index:byId(app,'myproduct_row_card'),args:{assertion:'count',expected:rowCount}});
  const button=app.snapshot!.nodes.find(n=>n.resourceId.endsWith('myproduct_edit_button'))!;
  const bounds=button.bounds!;
  await act(app,'tap',{coordinate:true,x:bounds.x+bounds.w/2,y:bounds.y+bounds.h/2});
  await act(app,'close_app');
  const built=app.save({name:'appium smoke',module:'general',mode:'both'});
  assert.equal(built.issues.length,0);
  assert.equal(built.saved.conflicts.length,0);
  assert.ok(built.files.some(f=>f.path.includes('/pom/')));
  assert.ok(built.files.every(f=>f.framework==='appium'));
  const code=built.files.find(f=>f.path.endsWith('test_general_appium_smoke.py'))!.content;
  assert.equal((code.match(/drv\.activate_app/g)||[]).length,0,'explicit launch step avoids duplicate fixture launch');
  const python=await detectPython();
  if(!python.ok){t.diagnostic('Python replay unavailable: '+python.problems.join(' '));return;}
  const running=await app.run(built.ref);
  assert.equal(app.inspector.status().open,false);
  const result=await app.runner.wait(running.id);
  assert.equal(result.status,'passed',JSON.stringify(result));
  assert.equal(result.tests?.total,1);
  assert.equal(mock.sessions.size,0,'pytest and inspector sessions are closed');
  // Save POM as the only discoverable target and execute it as well.
  app.save({name:'appium smoke',module:'general',mode:'pom'});
  const pom=await app.run(built.ref);
  const pomResult=await app.runner.wait(pom.id);
  assert.equal(pomResult.status,'passed',JSON.stringify(pomResult));
  assert.equal(mock.sessions.size,0);
});
test('failed refresh invalidates old targets; editing generated code never silently overwrites it',async t=>{
  const {app}=await setup(t);
  const token=app.snapshot!.token;
  const source=app.inspector.source.bind(app.inspector);
  app.inspector.source=async()=>{throw Error('instrumentation unavailable');};
  await assert.rejects(()=>app.capture(),/instrumentation/);
  assert.equal(app.snapshot,null);
  await assert.rejects(()=>app.action({token,type:'tap',coordinate:true,x:20,y:20}),/screen changed/i);
  app.inspector.source=source;await app.capture();
  await act(app,'launch_app');
  const saved=app.save({name:'preserve edits'});
  const file=path.join(saved.saved.caseDir,saved.files[0].path);
  fs.appendFileSync(file,'\n# edited by a person\n');
  await act(app,'press',{args:{key:'BACK'}});
  const next=app.save({name:'preserve edits'});
  assert.equal(next.saved.conflicts.length,1);
  assert.match(fs.readFileSync(file,'utf8'),/edited by a person/);
  await assert.rejects(()=>app.run(next.ref),/awaiting review/);
});
test('release WebView keeps native text and coordinate inspection available',async t=>{
  const {app}=await setup(t,{webviewDebuggable:false});
  await act(app,'tap',{index:byId(app,'home_market_card')});
  assert.ok(app.snapshot!.nodes.some(n=>n.className==='android.webkit.WebView'));
  assert.equal(app.snapshot!.web,null);
  assert.match(app.snapshot!.webMessage,/DOM is not exposed/);
  const node=app.snapshot!.nodes.find(n=>n.text && n.className!=='android.webkit.WebView')!;
  const inspected=await app.inspect({token:app.snapshot!.token,index:node.index});
  assert.ok(inspected.candidates.length>0);
});
test('debug WebView exposes CSS and XPath and records a real DOM fill', {timeout:120_000},async t=>{
  const {app}=await setup(t);
  await act(app,'tap',{index:byId(app,'home_market_card')});
  assert.ok(app.snapshot!.web,app.snapshot!.webMessage);
  const input=app.snapshot!.web!.nodes.find(n=>n.tag==='input')!;
  assert.ok(input,'sample WebView input exists');
  const inspected=await app.inspect({token:app.snapshot!.token,index:input.i,context:'WEBVIEW'});
  const css=inspected.candidates.find(c=>c.using==='css selector')!;
  await act(app,'type',{index:input.i,context:'WEBVIEW',using:css.using,value:css.value,args:{text:'steel'}});
  assert.equal(app.steps.at(-1)!.context,'WEBVIEW');
  assert.equal(app.steps.at(-1)!.target!.parts!.by,'css');
  const built=app.build({name:'webview',mode:'both'});
  assert.equal(built.issues.length,0);
  assert.ok(built.files.some(f=>f.content.includes('CSS_SELECTOR')));
});
