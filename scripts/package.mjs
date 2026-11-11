import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash,randomUUID } from 'node:crypto';
const root=path.resolve(import.meta.dirname,'..');
const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
const dist=path.join(root,'dist');fs.mkdirSync(dist,{recursive:true});
const stem=`${pkg.name}-${pkg.version}-windows`;
const zip=path.join(dist,stem+'.zip');
const stage=path.resolve(root,'.package-staging-'+randomUUID());
if(!stage.startsWith(root+path.sep+'.package-staging-')||path.dirname(stage)!==root)throw Error('Unsafe staging directory');
const folder=path.join(stage,stem);fs.mkdirSync(folder,{recursive:true});
const include=['src','public','docs','samples','scripts','test','package.json','package-lock.json','tsconfig.json','requirements-appium.txt','README.md','CHANGELOG.md','LICENSE','START-VORTEX.cmd','.gitignore','.github'];
try{
  for(const rel of include)fs.cpSync(path.join(root,rel),path.join(folder,rel),{recursive:true,filter:p=>!p.endsWith('appium-only.mjs')});
  // Ship the runtime packages (xpath, @xmldom/xmldom) so the extracted ZIP works without an install step.
  execFileSync(process.platform==='win32'?'npm.cmd':'npm',['ci','--omit=dev','--ignore-scripts','--no-audit','--no-fund'],{cwd:folder,stdio:'inherit',shell:process.platform==='win32'});
  const files=[];
  function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const f=path.join(dir,e.name);if(e.isDirectory())walk(f);else files.push({path:path.relative(folder,f).split(path.sep).join('/'),sha256:createHash('sha256').update(fs.readFileSync(f)).digest('hex')});}}
  walk(folder);fs.writeFileSync(path.join(folder,'PACKAGE-MANIFEST.json'),JSON.stringify({name:pkg.name,version:pkg.version,files},null,2)+'\n');
  // The output path is fixed inside this replica's dist folder. Replace only this version's archive.
  if(fs.existsSync(zip))fs.unlinkSync(zip);
  execFileSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(root,'scripts','zip.ps1'),'-Source',stage,'-Destination',zip],{windowsHide:true,stdio:'inherit'});
  const hash=createHash('sha256').update(fs.readFileSync(zip)).digest('hex');fs.writeFileSync(zip+'.sha256',`${hash}  ${path.basename(zip)}\n`);
  console.log(JSON.stringify({zip,bytes:fs.statSync(zip).size,files:files.length+1,sha256:hash},null,2));
}finally{if(path.dirname(stage)===root&&path.basename(stage).startsWith('.package-staging-'))fs.rmSync(stage,{recursive:true,force:true});}
