const assert = require('node:assert/strict');
const puppeteer = require('puppeteer');
const cases=[];const test=(name,fn)=>cases.push([name,fn]);
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const demo=async p=>{await p.click('#btnDemo');await p.waitForFunction(()=>document.querySelector('#pageTotalDisplay').textContent.includes('10'),{timeout:20000});await p.waitForFunction(()=>document.querySelector('#viewerContainer canvas')?.width>0);};
const saved=async p=>p.evaluate(()=>new Promise((resolve,reject)=>{const r=indexedDB.open('darkpdf-session',1);r.onupgradeneeded=()=>r.result.createObjectStore('kv');r.onerror=()=>reject(r.error);r.onsuccess=()=>{const db=r.result;const t=db.transaction('kv');const q=t.objectStore('kv').get('bytes');q.onsuccess=()=>resolve(!!q.result);t.oncomplete=()=>db.close();};}));
test('Document storage requires opt-in and can be cleared without closing the PDF',async(p,url)=>{
 await p.goto(url);await demo(p);await pause(700);assert.equal(await saved(p),false,'PDF should not remain in IndexedDB');
 await p.click('#rememberDocument');await pause(500);assert.equal(await saved(p),true);
 await p.reload();await p.waitForFunction(()=>document.querySelector('#workspace').style.display==='flex' && !document.querySelector('#progressModal').classList.contains('visible'));
 assert.equal(await p.$eval('#rememberDocument',e=>e.checked),true);
 await p.click('#rememberDocument');await pause(300);assert.equal(await saved(p),false,'PDF should not remain in IndexedDB');
 await p.reload();assert.equal(await p.$eval('#uploadSection',e=>getComputedStyle(e).display!=='none'),true);
});
test('Split comparison is keyboard adjustable',async(p,url)=>{
 await p.goto(url);await demo(p);await p.focus('#splitSlider');await p.keyboard.press('ArrowRight');
 assert.equal(await p.$eval('#splitSlider',e=>e.getAttribute('aria-valuenow')),'55');
 await p.keyboard.press('Home');assert.equal(await p.$eval('#splitSlider',e=>e.getAttribute('aria-valuenow')),'0');
 await p.keyboard.press('End');assert.equal(await p.$eval('#splitSlider',e=>e.getAttribute('aria-valuenow')),'100');
});
test('Sample navigation and customization fit phone, tablet and desktop',async(p,url)=>{
 await p.goto(url);await demo(p);
 await p.click('#btnNextPage');assert.equal(await p.$eval('#pageInput',e=>e.value),'2');
 for(const width of [320,390,768,1024,1440]){
  await p.setViewport({width,height:900});await pause(250);
  assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'workspace overflow at '+width);
  await p.click('#btnToggleStudio');await pause(300);
  assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'drawer overflow at '+width);
  if(process.env.AUDIT_SCREENSHOTS){require('fs').mkdirSync(process.env.AUDIT_SCREENSHOTS,{recursive:true});await p.screenshot({path:require('path').join(process.env.AUDIT_SCREENSHOTS,'darkpdf-'+width+'.png')});}
  await p.click('#btnCloseStudio');await pause(250);
 }
});
test('Invalid PDF returns to upload and a valid sample still opens',async(p,url)=>{
 await p.goto(url);await p.evaluate(()=>{const d=new DataTransfer();d.items.add(new File(['%PDF-1.7\nnot a document'],'invalid.pdf',{type:'application/pdf'}));const e=document.querySelector('#fileInput');e.files=d.files;e.dispatchEvent(new Event('change'));});
 await p.waitForFunction(()=>document.querySelector('.toast.error')?.textContent.includes('Error loading PDF'));
 assert.equal(await p.$eval('#uploadSection',e=>getComputedStyle(e).display!=='none'),true);await demo(p);
});
(async()=>{
 const server=await require('./server.cjs').start();const browser=await puppeteer.launch({headless:true,args:['--no-sandbox']});let failures=0;
 try{for(const [name,fn] of cases){const ctx=await browser.createBrowserContext();const p=await ctx.newPage();const errors=[];p.on('pageerror',e=>errors.push(e.message));await p.setViewport({width:1440,height:900});
  try{await fn(p,process.env.DARKPDF_URL||server.url);assert.deepEqual(errors,[]);console.log('PASS',name);}catch(e){failures++;console.error('FAIL',name,e.stack);}finally{await ctx.close();}
 }}finally{await browser.close();server.close();}console.log(`${cases.length-failures}/${cases.length} passed`);process.exitCode=failures?1:0;
})().catch(e=>{console.error(e);process.exit(1);});
