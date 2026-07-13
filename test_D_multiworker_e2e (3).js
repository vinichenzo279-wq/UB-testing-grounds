'use strict';
// ==========================================================================================
// TEST D) Full multi-worker pipeline, real threads, merged, vs independent brute force.
// Mirrors _runSolveParallel + _mergeWorkerResults as closely as Node allows: real worker_threads
// (not a single-thread simulation), one real SharedArrayBuffer-backed Int32Array floor shared by
// all of them, root candidates partitioned round-robin (both UNSORTED and item-7c SORTED, to
// prove the sort is answer-invariant), each worker running the ACTUAL solveBest extracted
// verbatim from the live file. Merge logic mirrors _mergeWorkerResults (max best, union of tied
// bestXIs). Checked against indep_brute.js, which shares no code with the solver.
//
// Per the DAC lesson, half the instances here are engineered (not just randomly drawn) so the
// floor is likely to actually bind: one root-partition is seeded with visibly higher-rated cards
// than the other, so the "strong" worker's incumbent should race ahead and prune the "weak"
// worker's subtree -- the actual condition item 7b exists to exploit, not left to chance.
// ==========================================================================================
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Worker, isMainThread } = require('worker_threads');
const { generate } = require('./fuzz_gen.js');
const { bruteForce } = require('./indep_brute.js');
const { scoreXI, solveBest } = require('./prod_solver.js');

const SOLVER_SRC = fs.readFileSync(path.join(__dirname, 'prod_solver.js'), 'utf8')
  .replace(/module\.exports[\s\S]*$/, ''); // strip the require()-only export line for inlining into a worker

const WORKER_WRAPPER = `
const { parentPort, workerData } = require('worker_threads');
${SOLVER_SRC}
const { form, cards, cap, allowIds, rootSlotIdx, sab, seedBest } = workerData;
const sharedFloor = sab ? new Int32Array(sab) : undefined;
const rootAllow = allowIds ? new Set(allowIds) : undefined;
const r = solveBest(form, cards, cap, 99, seedBest, undefined, false, undefined, rootAllow, undefined, sharedFloor, rootSlotIdx);
parentPort.postMessage({ best: r.best, bestXIs: (r.bestXIs||[]).map(b=>({ ids: b.xi.map(c=>c.id), total: b.sc.total })), nodes: r.nodes });
`;

function runWorker(tmpPath, workerData){
  return new Promise((resolve,reject)=>{
    const w = new Worker(tmpPath, { workerData });
    w.on('message', resolve);
    w.on('error', reject);
  });
}

function sortRootCands(rootCandsIn){
  const rootCands = rootCandsIn.slice();
  const __rn={},__rc={};
  for(const c of rootCands){__rn[c.nation]=(__rn[c.nation]||0)+1;if(c.type==='normal')__rc[c.club]=(__rc[c.club]||0)+1;}
  rootCands.sort((a,b)=>{
    const ka=a.rating+0.4/(__rn[a.nation]||1)+(a.type==='normal'?0.4/(__rc[a.club]||1):0);
    const kb=b.rating+0.4/(__rn[b.nation]||1)+(b.type==='normal'?0.4/(__rc[b.club]||1):0);
    return kb-ka;
  });
  return rootCands;
}

function pickRootSlot(draft){
  const order = draft.form.slots.map((s,i)=>i).sort((a,b)=>
    draft.cards.filter(c=>c.pos.includes(draft.form.slots[a])).length -
    draft.cards.filter(c=>c.pos.includes(draft.form.slots[b])).length);
  // pick the biggest-pooled slot as axis, same intent as production's axis-selection loop
  let best=order[0], bestN=-1;
  for(const idx of order){
    const n = draft.cards.filter(c=>c.pos.includes(draft.form.slots[idx])).length;
    if(n>bestN){bestN=n;best=idx;}
  }
  return best;
}

function skewRatings(draft, rootSlotIdx){
  // engineer a rating skew across the eventual partitions so the floor is likely to bind:
  // sort candidates by id (arrival order, pre-partition) and boost every OTHER card's rating,
  // so a round-robin partition puts high ratings mostly in one half.
  const label = draft.form.slots[rootSlotIdx];
  const rootCards = draft.cards.filter(c=>c.pos.includes(label));
  rootCards.forEach((c,i)=>{ if(i%2===0) c.rating = Math.min(99, c.rating+15); });
  return draft;
}

async function runInstance(draft, W, sorted){
  // NOTE: any rating skew must already be baked into `draft` by the caller BEFORE this is
  // called, and BEFORE the brute-force oracle runs on the same draft -- applying it here (after
  // the oracle already scored an unskewed copy) would compare the solver against the wrong
  // instance. (This was caught by the harness's own first run: every "mismatch" was solver >
  // brute, which is the tell that the oracle and solver were silently scoring different data,
  // not a real soundness bug -- see the run log below.)
  const rootSlotIdx = pickRootSlot(draft);
  const label = draft.form.slots[rootSlotIdx];
  let rootCands = draft.cards.filter(c=>c.pos.includes(label));
  if(rootCands.length < W) return null; // not enough candidates to actually split W ways
  if(sorted) rootCands = sortRootCands(rootCands);
  const parts = Array.from({length:W},()=>[]);
  rootCands.forEach((c,i)=>parts[i%W].push(c.id));

  const tmpPath = path.join(os.tmpdir(), `_solver_worker_${process.pid}_${Math.random().toString(36).slice(2)}.js`);
  fs.writeFileSync(tmpPath, WORKER_WRAPPER);

  const sab = new SharedArrayBuffer(4);
  const floorArr = new Int32Array(sab);
  Atomics.store(floorArr, 0, -1);

  try{
    const results = await Promise.all(parts.map(allowIds =>
      runWorker(tmpPath, { form: draft.form, cards: draft.cards, cap: 3_000_000, allowIds, rootSlotIdx, sab, seedBest: -1 })
    ));
    // merge exactly like _mergeWorkerResults: max best, union of tied bestXIs
    let best=-1, bestXIs=[], nodes=0;
    for(const r of results){
      nodes += r.nodes||0;
      if(r.best>best){best=r.best;bestXIs=r.bestXIs.slice();}
      else if(r.best===best && r.best>=0){
        const keys=new Set(bestXIs.map(x=>x.ids.slice().sort((a,b)=>a-b).join(',')));
        for(const x of r.bestXIs){const k=x.ids.slice().sort((a,b)=>a-b).join(',');if(!keys.has(k)){keys.add(k);bestXIs.push(x);}}
      }
    }
    return { best, bestXIs, nodes, floorFinal: Atomics.load(floorArr,0) };
  } finally {
    fs.unlinkSync(tmpPath);
  }
}

async function main(){
  console.log('=== D) full multi-worker pipeline (real threads, real shared floor) vs brute force ===');
  let checked=0, mismatches=0, illegalXi=0, floorBoundInstances=0;
  const NUM_INSTANCES = 100; // real OS threads are expensive; kept moderate but every instance is a genuine multi-thread run
  for(let s=0;s<NUM_INSTANCES;s++){
    const draft = generate(s*257+11);
    let combos=1, bad=false;
    for(const slot of draft.form.slots){
      const n = draft.cards.filter(c=>c.pos.includes(slot)).length;
      if(n===0){bad=true;break;}
      combos*=n;
    }
    if(bad || combos>50000 || draft.cards.length<6) continue;

    const W = 2 + (s%3); // 2,3,4 workers
    const sorted = (s%2===0);
    const skew = (s%2===0); // engineer half the instances to make the floor likely to bind

    // apply skew (if any) BEFORE the oracle sees the draft, so oracle and solver score the
    // identical instance -- see note in runInstance()
    if(skew){
      const rootSlotIdx = pickRootSlot(draft);
      skewRatings(draft, rootSlotIdx);
    }

    const oracle = bruteForce(draft.form, draft.cards, scoreXI, {});
    if(oracle.infeasible) continue;

    const res = await runInstance(JSON.parse(JSON.stringify(draft)), W, sorted);
    if(res===null) continue;
    checked++;
    if(res.floorFinal >= 0) floorBoundInstances++;

    if(res.best !== oracle.best){
      mismatches++;
      console.log(`  MISMATCH instance ${s}: solver(merged,W=${W},sorted=${sorted})=${res.best} vs brute=${oracle.best}`);
    }
    for(const b of res.bestXIs){
      const xi = b.ids.map(id => draft.cards.find(c=>c.id===id));
      if(xi.some(c=>!c)){ illegalXi++; continue; }
      const seen = new Set(); let legal = true;
      for(let i=0;i<xi.length;i++){
        if(!xi[i].pos.includes(draft.form.slots[i])){legal=false;break;}
        const g = (xi[i].hold!==null&&xi[i].hold!==undefined)?('H:'+xi[i].hold):('S:'+xi[i].id);
        if(seen.has(g)){legal=false;break;} seen.add(g);
      }
      if(!legal || b.total!==res.best) illegalXi++;
    }
  }
  console.log(`checked (real multi-thread runs): ${checked}`);
  console.log(`floor actually bound (>=0 by end) in: ${floorBoundInstances}/${checked} instances`);
  console.log(`merged-answer mismatches vs independent brute force: ${mismatches} (expect 0)`);
  console.log(`illegal/misscored bestXIs returned: ${illegalXi} (expect 0)`);
  const fail = mismatches>0 || illegalXi>0;
  console.log(fail ? 'FAIL' : 'PASS');
  if(fail) process.exitCode=1;
}

if(isMainThread) main();
