const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const context = {window:{}};
vm.runInNewContext(fs.readFileSync(require('path').join(__dirname,'../js/retention.js'),'utf8'), context);
const check = context.window.RetentionCheck;
(async () => {
 let destroyed=false;
 const lib={getDocument:()=>({promise:Promise.resolve({numPages:1,getPage:async()=>{throw Error('Unreadable page')},destroy:async()=>{destroyed=true}})})};
 await assert.rejects(check.analyze(lib,new Uint8Array([1])),/Unreadable page/);
 assert.equal(destroyed,true,'failed analysis releases the PDF worker');
 const before={total:1,pagesChecked:[1],imgPagesChecked:1,textLen:4,links:1,widgets:1,images:1,outline:1,perPageText:{1:'text'},size:100};
 assert.equal(check.compare(before,{...before,links:2}).criticalPass,false,'unexpected link is a preservation change');
 assert.equal(check.compare(before,{...before,widgets:2}).criticalPass,false,'unexpected form field is a preservation change');
 assert.equal(check.compare(before,{...before}).criticalPass,true);
 console.log('PASS retention failures release resources and do not report changed annotations as preserved');
})().catch(e=>{console.error(e);process.exitCode=1});
