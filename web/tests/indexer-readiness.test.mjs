import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const A="0x1111111111111111111111111111111111111111",K="0x3333333333333333333333333333333333333333";
const wad=10n**18n, now=Math.floor(Date.now()/1000);
const event={blockNumber:100,logIndex:2,contractAddress:K,timestamp:now,txHash:"0x"+"44".repeat(32)};
const snapshot={r:16,rawR:(16n*wad).toString(),pending:0,resolvedBets:10,flagged:false,vestAt:now+300,asOfBlock:"100",activationMin:10,multiplier:3};
const market={id:1,question:"Actual chain question",history:[],sharps:{yes:0,no:0},live:{block:"100",chainId:10143,contract:K,state:3,voided:false,outcome:true,sharpsAvailable:false,yesMoney:"1000000",noMoney:"0",yesEff:"3000000",noEff:"0"}};
const call={...event,id:"1",side:true,amount:"1000000",entryPrice:(wad/2n).toString(),text:"Indexed call",market:{id:"1"},trader:{id:A}};
const marketRow={id:"1",yesMoney:"1000000",noMoney:"0",yesEff:"3000000",noEff:"0",betCount:1,sharpYes:1,sharpNo:0,pricePoints:[{blockNumber:100,logIndex:1,priceRepYes:wad.toString(),priceMoneyYes:wad.toString()}]};
const dataModule={exports:{}};
const dataSource=ts.transpileModule(readFileSync(new URL("../src/lib/data.ts",import.meta.url),"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText;
const unexpected=()=>{throw new Error("Unexpected fixture dependency");};
runInNewContext(dataSource,{module:dataModule,exports:dataModule.exports,Date,require:name=>{
 if(name==="./math")return{multiplier:unexpected,reputationDelta:unexpected};
 if(name==="./tiers")return{tierOf:unexpected};
 throw new Error(name);
}});
function harness(options={}){
 const requests=[], reads=[], warnings=[]; let cancellations=0, released=0;
 const data={_meta:[{chainId:10143,startBlock:1,progressBlock:100,progressBlockTime:new Date(now*1000).toISOString(),isReady:true}],ContractConfiguration:[{id:K,source:"DirectCreation",nMin:"10",vestPeriod:"300"}],Market:[marketRow],Bet:[],Position:[],Call:[call],Trader:[{id:A,r:snapshot.rawR,wins:2,losses:1,resolvedBets:null,resolvedBetsSource:"Unknown"}],ReputationChange:[],Vesting:[],...options.data};
 const client={getBlockNumber:async()=>options.head??100n,getBlock:async p=>{reads.push(p);return{timestamp:BigInt(options.time??now)};},readContract:async p=>{reads.push(p);if(p.functionName==="N_MIN")return 10n;if(p.functionName==="VEST_PERIOD")return 300n;if(p.functionName==="following")return options.following??[A];
 if(p.functionName==="getMarket")return{question:`Actual chain market ${p.args[0]}`,state:3,outcome:true,voided:false,closeTime:BigInt(now-10)};
 if(p.functionName==="positions")return[options.positionMoney??(p.args[2]?1_000_000n:0n),0n,0n,false];
 if(p.functionName==="settled")return options.settled??true;
 return{r:16n*wad};}};
 const stubs={"./data":dataModule.exports,"server-only":{},"next/server":{connection:async()=>{}},"./abi":{kleosAbi:[],kleosSocialAbi:[]},"./chain":{IS_LIVE:true,IS_LOCAL_CHAIN:false,KLEOS_ADDRESS:K,SOCIAL_ADDRESS:K,chain:{id:10143},publicClient:client},"./onchain":{
  readExtraMarkets:async(_from,_limit,block)=>{reads.push({blockNumber:block});return[market];},
  readLiveMarket:async(_id,block)=>{reads.push({blockNumber:block});return market;},
  readNames:async(_addresses,block)=>{reads.push({blockNumber:block});return new Map([[A,"actual_name"]]);},
  readProfileSnapshot:async(_address,block)=>{reads.push({blockNumber:block});return options.snapshot??snapshot;}
 }};
 const source=readFileSync(new URL("../src/lib/indexer.ts",import.meta.url),"utf8");
 const output=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText;
 const loaded={exports:{}};
 runInNewContext(output,{module:loaded,exports:loaded.exports,require:n=>{if(!(n in stubs))throw new Error(n);return stubs[n];},process:{env:{INDEXER_URL:"https://indexer.invalid/graphql",NEXT_PUBLIC_KLEOS_DEPLOY_BLOCK:"1"}},Date,setTimeout,clearTimeout,AbortSignal,TextEncoder,TextDecoder,console:{error:(...args)=>warnings.push(args)},fetch:async(_url,init)=>{
  requests.push(JSON.parse(init.body));
  const chunks=options.chunks??[new TextEncoder().encode(JSON.stringify(options.response??{data}))];let cursor=0;
  return{ok:true,headers:{get:()=>null},body:{getReader:()=>({read:async()=>cursor<chunks.length?{done:false,value:chunks[cursor++]}:{done:true},cancel:async()=>{cancellations++;},releaseLock:()=>{released++;}})}};
 }});
 return{...loaded.exports,requests,reads,warnings,get cancellations(){return cancellations;},get released(){return released;}};
}
test("indexed feed uses verified checkpoint, exact raw R and chain outcome/name",async()=>{
 const h=harness();const rows=await h.readFeed();
 assert.equal(rows[0].question,"Actual chain question");assert.equal(rows[0].name,"actual_name");assert.equal(rows[0].rawR,snapshot.rawR);assert.equal(rows[0].rBlock,"100");assert.equal(rows[0].result,"right");
 assert.ok(h.reads.every(p=>p.blockNumber===100n));assert.match(h.requests[0].query,/_meta/);assert.match(h.requests[0].query,/blockNumber: desc/);
});
test("unsupported hosted schema falls back to authoritative chain, never samples",async()=>{
 const h=harness({response:{errors:[{message:"field ContractConfiguration not found"}]}});
 const authoritative={from:"chain"};assert.equal(await h.preferIndexer(h.readFeed,async()=>authoritative),authoritative);assert.equal(h.warnings.length,1);
});
test("missing data and unready checkpoints are rejected",async()=>{
 await assert.rejects(harness({response:{}}).readFeed(),/checkpoint\/schema/);
 await assert.rejects(harness({data:{_meta:[{chainId:10143,startBlock:1,progressBlock:100,isReady:false}]}}).readFeed(),/not ready/);
});
test("wrong chain, wrong deployment and incomplete replay are rejected",async()=>{
 await assert.rejects(harness({data:{_meta:[{chainId:1,isReady:true}]}}).readFeed(),/not ready/);
 await assert.rejects(harness({data:{ContractConfiguration:[{id:A}]}}).readFeed(),/not ready/);
 await assert.rejects(harness({data:{_meta:[{chainId:10143,startBlock:2,progressBlock:100,isReady:true}]}}).readFeed(),/cover the deployment/);
});
test("stale, future and incorrect checkpoint timestamps are rejected",async()=>{
 await assert.rejects(harness({head:401n}).readFeed(),/stale or ahead/);
 await assert.rejects(harness({head:99n}).readFeed(),/stale or ahead/);
 await assert.rejects(harness({time:now-121,data:{_meta:[{chainId:10143,startBlock:1,progressBlock:100,progressBlockTime:new Date((now-121)*1000).toISOString(),isReady:true}]}}).readFeed(),/time.*stale/);
 await assert.rejects(harness({time:now-10}).readFeed(),/time.*stale/);
});
test("event source and checkpoint violations do not become valid feed rows",async()=>{
 await assert.rejects(harness({data:{Call:[{...call,contractAddress:A}]}}).readFeed(),/invalid source/);
 await assert.rejects(harness({data:{Call:[{...call,blockNumber:101}]}}).readFeed(),/invalid source/);
});
test("indexed market pools must match the pinned direct state",async()=>{
 await assert.rejects(harness({data:{Market:[{...marketRow,yesMoney:"2000000"}]}}).readMarkets(),/pools do not match/);
 const h=harness();const rows=await h.readMarkets();assert.equal(rows[0].live.sharpsAvailable,true);assert.equal(rows[0].history.length,1);assert.match(rows[0].historyCoverage,/block 100/);
});
test("profile preserves nullable index history, uses exact activation, and includes vest/slash provenance",async()=>{
 const h=harness({data:{ReputationChange:[{...event,kind:"Admin",adminAction:"Slash",delta:(-wad).toString(),newR:snapshot.rawR,entryPrice:"0",side:false,outcome:false,market:null}],Vesting:[{...event,logIndex:3,amount:wad.toString(),newR:snapshot.rawR}]}});
 const {profile}=await h.readProfilePage(A);assert.equal(profile.resolvedBets,10);assert.equal(profile.activationMin,10);assert.equal(profile.multiplier,3);assert.equal(profile.rawR,snapshot.rawR);assert.equal(profile.history[0].kind,"vest");assert.equal(profile.history[1].question,"Admin slash");assert.equal(profile.history[1].isBet,false);
 assert.ok(h.reads.every(p=>p.blockNumber===100n));
});
test("profile history cap is explicit and missing/inconsistent trader states fail",async()=>{
 const adjustments=Array.from({length:201},(_,i)=>({...event,logIndex:i,kind:"Admin",adminAction:"Unknown",delta:"0",newR:snapshot.rawR,entryPrice:"0",side:false,outcome:false,market:null}));
 const {profile}=await harness({data:{ReputationChange:adjustments}}).readProfilePage(A);
 assert.equal(profile.history.length,200);assert.equal(profile.historyComplete,false);assert.match(profile.historyCoverage,/earlier changes omitted/);
 await assert.rejects(harness({data:{Trader:[]}}).readProfilePage(A),/missing or inconsistent/);
 await assert.rejects(harness({data:{Trader:[{id:A,r:"0",wins:0,losses:0}]}}).readProfilePage(A),/missing or inconsistent/);
});
test("leaderboard exact R is checked, candidate coverage is bounded and activation boost comes from chain",async()=>{
 const h=harness();const result=await h.readLeaderboard();assert.equal(result.traders[0].rawR,snapshot.rawR);assert.equal(result.traders[0].multiplier,3);assert.match(result.coverage,/Up to 100/);assert.equal(result.asOfBlock,"100");
 await assert.rejects(harness({data:{Trader:[{id:A,r:"0",wins:0,losses:0}]}}).readLeaderboard(),/R does not match/);
});
test("invalid indexed limits reject before any query",async()=>{
 const h=harness();await assert.rejects(h.readFeed(101),/page size/);await assert.rejects(h.readLeaderboard(0),/page size/);assert.equal(h.requests.length,0);
});

test("unknown or mismatched deployment configuration cannot enable indexed reads",async()=>{
 await assert.rejects(harness({data:{ContractConfiguration:[{id:K,source:"Unknown",nMin:null,vestPeriod:null}]}}).readFeed(),/unknown provenance/);
 await assert.rejects(harness({data:{ContractConfiguration:[{id:K,source:"DirectCreation",nMin:"9",vestPeriod:"300"}]}}).readFeed(),/configuration does not match/);
});
test("chunked responses are capped while reading and cancelled before oversized JSON allocation",async()=>{
 const h=harness({chunks:Array.from({length:5},()=>new Uint8Array(1024*1024))});
 await assert.rejects(h.readFeed(),/response exceeds/);assert.equal(h.cancellations,1);assert.equal(h.released,1);assert.equal(h.reads.length,0);
});
test("indexed Sharps filtering occurs in SQL before pagination and checks the actual authors",async()=>{
 const h=harness();const rows=await h.readFilteredFeed({minR:16n*wad});assert.equal(rows.length,1);assert.match(h.requests[0].query,/where:.*trader:.*_gte: "16000000000000000000"/);
 await assert.rejects(harness().readFilteredFeed({minR:17n*wad}),/sharp authors/);
});
test("indexed Following filters before pagination and validates the complete bounded roster at its checkpoint",async()=>{
 const h=harness({data:{Follow:[{followee_id:A}]}});const rows=await h.readFilteredFeed({follower:A});assert.equal(rows.length,1);assert.match(h.requests[0].query,/followers:.*follower_id/);assert.ok(h.reads.every(p=>p.blockNumber===100n));
 await assert.rejects(harness({data:{Follow:[]}}).readFilteredFeed({follower:A}),/follows do not match/);
 await assert.rejects(harness({following:Array(101).fill(A),data:{Follow:Array(101).fill({followee_id:A})}}).readFilteredFeed({follower:A}),/read budget/);
});

const position={market_id:"1",yesMoney:"1000000",noMoney:"0",settled:true,payout:"1500000"};
test("profile holdings verify both positions and settlement at the checkpoint, with numeric newest-first ordering",async()=>{
 const h=harness({data:{Position:[{...position,market_id:"2"},{...position,market_id:"10"}]}});
 const {holdings}=await h.readProfilePage(A);
 assert.deepEqual(Array.from(holdings,row=>({...row})),[
  {marketId:10,question:"Actual chain market 10",yes:1,no:0,status:"won",payout:1.5},
  {marketId:2,question:"Actual chain market 2",yes:1,no:0,status:"won",payout:1.5},
 ]);
 assert.ok(h.reads.every(read=>read.blockNumber===100n));
 assert.equal(h.reads.filter(read=>read.functionName==="positions").length,4);
 assert.match(h.requests[0].query,/Position\(where:.*trader_id:.*limit: 101/);
});
test("profile holdings reject mismatched stakes or settlement instead of displaying stale amounts",async()=>{
 await assert.rejects(harness({data:{Position:[{...position,yesMoney:"2000000"}]}}).readProfilePage(A),/holding does not match/);
 await assert.rejects(harness({settled:false,data:{Position:[position]}}).readProfilePage(A),/holding does not match/);
 const {holdings}=await harness({settled:false,data:{Position:[{...position,settled:false}]}}).readProfilePage(A);
 assert.equal(holdings[0].payout,undefined);
});
test("profile holdings reject over-budget results before reading positions",async()=>{
 const h=harness({data:{Position:Array.from({length:101},(_,i)=>({...position,market_id:String(i+1)}))}});
 await assert.rejects(h.readProfilePage(A),/indexed profile read budget/);
 assert.equal(h.reads.filter(read=>read.functionName==="positions").length,0);
});
test("profile holdings reject duplicate and unsupported market identifiers",async()=>{
 await assert.rejects(harness({data:{Position:[position,position]}}).readProfilePage(A),/duplicate markets/);
 await assert.rejects(harness({data:{Position:[{...position,market_id:"9007199254740992"}]}}).readProfilePage(A),/market id is unsupported/);
});
