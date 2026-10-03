import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
const A="0x1111111111111111111111111111111111111111",B="0x2222222222222222222222222222222222222222",K="0x3333333333333333333333333333333333333333";
function harness() {
  const reads=[];
  const events=Array.from({length:51},(_,i)=>({args:{callId:BigInt(i+1),marketId:1n,user:i===0?A:B,side:true,amount:50000000n,entryPrice:500000000000000000n,text:`Call ${i+1}`},blockNumber:BigInt(i+1),logIndex:i,transactionHash:`0x${String(i).padStart(64,"0")}`}));
  const client={
    getBlockNumber:async()=>100n,
    getBlock:async()=>({timestamp:1000n}),
    getContractEvents:async({eventName,args,fromBlock,toBlock})=>eventName!=="CallPosted"?[]:events.filter(e=>e.blockNumber>=fromBlock&&e.blockNumber<=toBlock&&(!args.user||(Array.isArray(args.user)?args.user:[args.user]).includes(e.args.user))),
    readContract:async(params)=>{
      reads.push(params);
      if(params.functionName==="reputation")return{r:params.args[0]===A?16n*10n**18n:0n};
      if(params.functionName==="getMarket")return{state:3,voided:false,outcome:true,question:"Recorded question"};
      if(params.functionName==="namesOf")return params.args[0].map(()=>"");
      throw new Error(`Unexpected ${params.functionName}`);
    }
  };
  const stubs={"next/server":{connection:async()=>{}},"./abi":{kleosAbi:[],kleosSocialAbi:[]},"./chain":{HAS_LOGS_RPC:true,KLEOS_ADDRESS:K,SOCIAL_ADDRESS:K,chain:{id:31337},logsClient:client,publicClient:client},"./hypersync":{HAS_HYPERSYNC:false},"./bettors":{},"./data":{liveStatus:()=>{throw new Error("Unexpected market-status read in feed tests");}}};
  const source=readFileSync(new URL("../src/lib/onchain.ts",import.meta.url),"utf8");
  const output=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText;
  const loadedModule={exports:{}};
  runInNewContext(output,{module:loadedModule,exports:loadedModule.exports,require:n=>{if(!(n in stubs))throw new Error(n);return stubs[n];},process:{env:{NEXT_PUBLIC_KLEOS_DEPLOY_BLOCK:"1"}},Date,setTimeout,clearTimeout});
  return{...loadedModule.exports,reads};
}
test("sharp filtering precedes the fifty-call page boundary",async()=>{
  const h=harness();
  const rows=await h.readFeed(50,undefined,{minR:16n*10n**18n});
  assert.equal(rows.length,1);
  assert.equal(rows[0].id,1,"older qualifying call survives fifty newer nonqualifying calls");
  assert.equal(rows[0].rawR,(16n*10n**18n).toString());
  assert.equal(rows[0].rBlock,"100");
  assert.equal(rows[0].result,"right");
  assert.ok(h.reads.every(r=>r.blockNumber===100n),"reputation, outcomes and names share the pinned block");
});
test("following selects authors before paging and pins to the follow snapshot",async()=>{
  const h=harness();
  const rows=await h.readFeed(50,undefined,{authors:[A],blockNumber:80n});
  assert.equal(rows.length,1);
  assert.equal(rows[0].address,A);
  assert.ok(h.reads.every(r=>r.blockNumber===80n));
  assert.equal((await h.readFeed(50,undefined,{authors:[]})).length,0);
});
test("bounded feed requests reject excessive subjects and invalid page sizes",async()=>{
  const h=harness();
  await assert.rejects(h.readFeed(101),/Invalid call page/);
  await assert.rejects(h.readFeed(50,undefined,{authors:Array(101).fill(A)}),/read budget/);
});
