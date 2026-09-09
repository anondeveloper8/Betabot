import fs from 'node:fs';
import crypto from 'node:crypto';
import { adaptDataset, buildTimeframeAlignment, h4VisibleAtM15Close } from './src/research/dataset.js';
import { createCandidateDetector } from './src/strategy/candidate-detector.js';
import { DEFAULT_ENTRY_STOP_CONFIG, modelNextOpenEntry, calculateAtrBuffer, calculateStructuralStop } from './src/strategy/entry-stop.js';
import { getConfirmedSwings } from './engine/swings.js';
import { getH4Zones, DEFAULT_ZONE_CONFIG } from './engine/zones.js';
import { evaluateH4Context } from './engine/context.js';
import { replayChronologically } from './src/research/replay.js';

const raw=JSON.parse(fs.readFileSync('./data.json','utf8'));
const dataset=adaptDataset({instrument:'EURUSD',priceScale:5,m15:raw.m15,h4:raw.h4});
const alignment=buildTimeframeAlignment(dataset,{requireCompleteH4Buckets:false});
if(!alignment.valid) throw new Error('alignment invalid: '+JSON.stringify(alignment.issues.slice(0,5)));
const detector=createCandidateDetector({dataset,alignment});
const candidates=[];
for(let i=0;i<dataset.m15Candles.length;i++){
 const m=dataset.m15Candles[i]; const vis=h4VisibleAtM15Close(dataset.h4Candles,m); const sw=getConfirmedSwings(vis,vis.length-1); const ctx=evaluateH4Context(sw,m.timestampClose); const c=detector({m15Index:i,m15Candle:m,h4Context:ctx});
 for(const x of c) candidates.push(x);
}
console.log('candidates',candidates.length);
const threshold=7.414282863913105;
const pre=[];
for(const candidate of candidates){
 const i=candidate.bos.confirmationIndex;
 const entry=modelNextOpenEntry({direction:candidate.direction,candles:dataset.m15Candles,confirmationIndex:i,spreadPriceTicks:0n,slippagePriceTicks:0n,requireNextCandleComplete:true});
 if(!entry.valid) continue;
 const buffer=calculateAtrBuffer(dataset.m15Candles,i,DEFAULT_ENTRY_STOP_CONFIG.atrPeriod,DEFAULT_ENTRY_STOP_CONFIG.slBufferAtr);
 if(!buffer.valid) continue;
 const stop=calculateStructuralStop({direction:candidate.direction,reactionSwing:candidate.reactionSwing,zone:candidate.zone,bufferPriceTicks:buffer.bufferPriceTicks});
 if(!stop.valid) continue;
 const atr=candidate.atrPriceUnits;
 const riskATR=atr>0?Number(stop.stopPrice>entry.entryPrice?stop.stopPrice-entry.entryPrice:entry.entryPrice-stop.stopPrice)/atr:null;
 pre.push({...candidate, riskATR});
}
const eligible=pre.filter(c=>c.riskATR!==null && c.riskATR<=threshold);
console.log('pre candidates with geometry',pre.length,'risk filter',eligible.length);
const frozen=eligible.sort((a,b)=>a.bos.confirmationTimestamp-b.bos.confirmationTimestamp);
for (const c of frozen) { c.upstream.context = { ...c.upstream.context, state: c.upstream.context?.direction ?? 'UNCLEAR', directionalBias: c.upstream.context?.direction ?? 'UNCLEAR' }; c.zone = { ...c.zone, valid: true }; c.upstream.location = { ...c.upstream.location, atZone: true }; c.upstream.pullback = { ...c.upstream.pullback, confirmed: c.upstream.pullback?.state === 'CONFIRMED' }; c.upstream.reaction = { ...c.upstream.reaction, confirmed: c.upstream.reaction?.state === 'CONFIRMED' }; }
// Build target-zone snapshots at each candidate timestamp; freeze zones to information visible then.
for(const c of frozen){
 const visible=h4VisibleAtM15Close(dataset.h4Candles,dataset.m15Candles[c.bos.confirmationIndex]);
 const swings=getConfirmedSwings(visible,visible.length-1);
 c.h4Zones=getH4Zones(dataset.h4Candles,swings,visible.length-1,DEFAULT_ZONE_CONFIG);
}
// Runner expects h4Zones globally; use candidate-specific target selection by running one at a time with its snapshot.
const { runHistoricalTrade } = await import('./src/backtest-runner.js');
let equity=10000, results=[], openUntil=-1;
for(const [n,c] of frozen.entries()){
 const already=openUntil>=c.bos.confirmationIndex;
 const result=runHistoricalTrade({candidate:c,m15Candles:dataset.m15Candles,h4Zones:c.h4Zones,equity,priceScale:5,moneyPerPriceUnitPerUnit:1,managementVariant:'M0_NO_MANAGEMENT',managementConfig:{},spreadPriceTicks:0n,slippagePriceTicks:0n,entryStopConfig:DEFAULT_ENTRY_STOP_CONFIG,setupId:c.setupId,strategyVersion:'FROZEN-V1-STAGE119',instrument:'EURUSD',onePositionOnly:true,existingPosition:already});
 results.push({setupId:c.setupId,direction:c.direction,detectorIndex:c.bos.confirmationIndex,riskATR:c.riskATR,decision:result.decision,reasons:result.reasons,result:result.result??null,exit:result.exit??null});
 if(result.decision==='TRADE_COMPLETED'){openUntil=result.exit.index; equity += result.result.netMoney;}
}
const completed=results.filter(r=>r.decision==='TRADE_COMPLETED');
const rejected=results.filter(r=>r.decision==='NO_TRADE');
const rs=completed.map(r=>r.result.R);
const wins=rs.filter(x=>x>0), losses=rs.filter(x=>x<=0);
const totalR=rs.reduce((a,b)=>a+b,0);
const pf=losses.length?wins.reduce((a,b)=>a+b,0)/Math.abs(losses.reduce((a,b)=>a+b,0)):null;
const report={stage:119,status:'FROZEN_INDEPENDENT_REPLAY_COMPLETED',source:{instrument:'EURUSD',priceSide:'BID',timeframe:'M1',period:'2026-01-01 through 2026-05-31',rowsM1:151907},dataset:{m15:dataset.m15Candles.length,m15Complete:dataset.m15Candles.filter(x=>x.isComplete).length,h4:dataset.h4Candles.length,h4Complete:dataset.h4Candles.filter(x=>x.isComplete).length},frozen:{thresholdATR:threshold,management:'M0_NO_MANAGEMENT',minRR:2,antiChaseATR:0.25,slBufferATR:0.25},discovery:{candidates:candidates.length,geometryEligible:pre.length,riskFiltered:eligible.length},results:{completed:completed.length,rejected:rejected.length,totalR,avgR:completed.length?totalR/completed.length:0,wins:wins.length,losses:losses.length,winRate:completed.length?wins.length/completed.length:null,profitFactor:pf,endingEquity:equity},trades:results,hash:null};
report.hash=crypto.createHash('sha256').update(JSON.stringify(report)).digest('hex');
fs.writeFileSync('./stage119-report.json',JSON.stringify(report,null,2));
console.log(JSON.stringify(report.results,null,2));
console.log('hash',report.hash);
