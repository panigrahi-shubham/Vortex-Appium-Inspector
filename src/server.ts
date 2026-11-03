import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Application, problem } from './application.ts';
import { checkLocalRequest } from './http-guard.js';
import { acquireRecorderOwner } from './recorder-owner.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const opt = (name: string, fallback: string) => args.includes(`--${name}`) ? args[args.indexOf(`--${name}`)+1] ?? fallback : fallback;
const port = Number(opt('port', process.env.PORT || '4701'));
if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('Invalid --port');
const app = new Application(root, path.resolve(root,opt('out','generated')), path.resolve(root,opt('state-dir','.vortex')));
const json = (res: http.ServerResponse, code: number, data: unknown) => { res.writeHead(code, { 'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store' }); res.end(JSON.stringify(data)); };
async function readBody(req: http.IncomingMessage): Promise<Record<string,unknown>> {
  let text = ''; for await (const chunk of req) { text += chunk; if (Buffer.byteLength(text)>2_000_000) throw problem('Request is too large.','TOO_LARGE',413); }
  const value: unknown = JSON.parse(text || '{}'); if (!value || Array.isArray(value) || typeof value !== 'object') throw problem('Expected a JSON object.'); return value as Record<string,unknown>;
}
let mock: {close(): Promise<void>} | null = null;
let owner: Awaited<ReturnType<typeof acquireRecorderOwner>> | null = null;
let ready = false;
const server = http.createServer(async (req,res) => {
  try {
    const denied = checkLocalRequest(req,port); if (denied) return json(res,403,{error:denied});
    if (!ready) return json(res,503,{error:'Recorder is starting. Retry shortly.'});
    const url = new URL(req.url || '/', `http://127.0.0.1:${port}`), p = url.pathname;
    if (req.method === 'GET' && p === '/api/health') return json(res,200,{name:'vortex-appium-recorder',ready:true});
    if (req.method === 'GET' && p === '/api/status') return json(res,200,await app.exclusive(()=>app.status()));
    if (req.method === 'GET' && p === '/api/devices') return json(res,200,args.includes('--mock') ? [{serial:'mock-device',model:'TradeHub simulated phone',state:'device'}] : await app.devices.list());
    if (req.method === 'GET' && p === '/api/python') return json(res,200,await app.python());
    if (req.method === 'GET' && /^\/api\/runs\/[\w-]+$/.test(p)) return json(res,200,app.runner.get(p.split('/').pop()!));
    if (req.method === 'POST' && p.startsWith('/api/')) {
      const body = await readBody(req);
      const out = await app.exclusive(async () => {
        if (p === '/api/server/start') return app.manager.start({host:'127.0.0.1',port:Number(body.port || 4723)});
        if (p === '/api/server/connect') return app.manager.connectExisting({host:'127.0.0.1',port:Number(body.port || 4723)});
        if (p === '/api/server/settings') return app.manager.updateSettings({chromedriverExecutable:String(body.chromedriverExecutable || ''),chromedriverExecutableDir:String(body.chromedriverExecutableDir || '')});
        if (p === '/api/server/stop') { await app.inspector.stop(); app.snapshot=null; return app.manager.stop(); }
        if (p === '/api/session/start') {
          if (!args.includes('--mock') && !owner) owner=await acquireRecorderOwner();
          return app.start(String(body.serial || ''),String(body.pkg || ''));
        }
        if (p === '/api/session/stop') { app.snapshot=null; return app.inspector.stop(); }
        if (p === '/api/screen') return app.capture(body.autoWeb !== false,body.context ? String(body.context):undefined);
        if (p === '/api/inspect') return app.inspect(body);
        if (p === '/api/action') return app.action(body);
        if (p === '/api/recording/undo') { app.steps.pop(); return {steps:app.steps}; }
        if (p === '/api/recording/clear') { app.steps=[]; app.recordingId=crypto.randomUUID(); return {steps:[]}; }
        if (p === '/api/generate') return app.build(body);
        if (p === '/api/save') return app.save(body);
        if (p === '/api/load') return app.load({module:body.module,case:body.case});
        if (p === '/api/run') return app.run({module:body.module,case:body.case});
        if (p === '/api/cancel') return app.runner.cancel(String(body.id));
        throw problem('Unknown endpoint.','NOT_FOUND',404);
      });
      return json(res,200,out);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') throw problem('Method not allowed.','METHOD',405);
    const asset = ({'/':'index.html','/app.js':'app.js','/style.css':'style.css'} as Record<string,string>)[p];
    if (!asset) throw problem('Not found.','NOT_FOUND',404);
    res.writeHead(200,{'Content-Type':asset.endsWith('.html')?'text/html; charset=utf-8':asset.endsWith('.js')?'text/javascript; charset=utf-8':'text/css; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'"});
    res.end(req.method==='HEAD'?undefined:fs.readFileSync(path.join(root,'public',asset)));
  } catch (e) {
    const err=e as Error & {httpStatus?:number;code?:string;hint?:string;issues?:unknown;steps?:unknown;applied?:boolean};
    json(res,err.httpStatus || 500,{error:err.message,code:err.code,hint:err.hint,issues:err.issues,steps:err.steps,applied:err.applied});
  }
});
try {
  // Bind before recovering state, so duplicate starts cannot disturb the live instance.
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  await app.init();
  if (args.includes('--mock')) {
    const {MockAppium}=await import('../test/fixtures/mock-appium.ts');
    const fake=new MockAppium(); await fake.listen(0); mock=fake;
    app.pkg='com.yourname.tradehub';
    await app.manager.connectExisting({host:'127.0.0.1',port:fake.port});
    console.log('[vortex] SIMULATED TradeHub device. No phone is controlled.');
  }
  ready=true;
  console.log(`[vortex] Appium Inspector: http://127.0.0.1:${port}`);
} catch (e) {
  const err=e as NodeJS.ErrnoException;
  console.error(err.code==='EADDRINUSE'?`[vortex] Port ${port} is occupied. Open the existing recorder or use --port 4702.`:err.message);
  server.close(); app.manager.stopWatchdog(); process.exitCode=1;
}
let closing=false;
async function close() { if(closing)return; closing=true; ready=false; server.close(); await app.exclusive(()=>app.shutdown()).catch(console.error); await mock?.close(); owner?.close(); }
process.once('SIGINT',()=>{void close();}); process.once('SIGTERM',()=>{void close();});
