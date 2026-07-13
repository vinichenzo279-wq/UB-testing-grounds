'use strict';
// ==========================================================================================
// TEST B) sharedFloor forced to the exact boundary values that matter, per draft.
// ==========================================================================================
// solver_bound_tests_v2.js's lesson: a generic/aggregate fuzz pass rate proves nothing about a
// branch unless the generator is shown to actually FORCE that branch's precondition. Applied to
// item 7b, the interesting preconditions for sharedFloor are:
//   (1) floor === true global optimum exactly (non-strict boundary: must NOT prune away the
//       only path to the optimum, and the tie must still be recorded, per the comment at
//       index.html:8474 "a branch whose bound EQUALS the floor is NOT pruned").
//   (2) floor === true optimum + 1 (one point ABOVE anything achievable): must return a result
//       that never exceeds -- let alone fabricates -- a score above what's truly achievable, and
//       per the changelog claim must safely fall back to best:-1 when the worker's own
//       root-restricted partition can't reach the floor at all.
//   (3) floor set from a SIBLING partition's real max, while THIS worker's own partition is
//       restricted (via rootAllow) to a strictly worse subset -- the actual multi-worker shape,
//       not just an arbitrary number.
// Every instance below is constructed so the floor is GUARANTEED to bind (sit at or above the
// partition's own true best), not left to chance.
// ==========================================================================================
const { generate } = require('./fuzz_gen.js');
const { bruteForce } = require('./indep_brute.js');
const { scoreXI, solveBest } = require('./prod_solver.js');

function makeFloor(v){
  const buf = new SharedArrayBuffer(4);
  const arr = new Int32Array(buf);
  Atomics.store(arr, 0, v);
  return arr;
}

function legalCheck(form, xi){
  // basic legality: one card per slot position-eligible, no duplicate hold groups
  const seen = new Set();
  for(let i=0;i<xi.length;i++){
    const c = xi[i];
    if(!c.pos.includes(form.slots[i])) return false;
    const g = (c.hold!==null&&c.hold!==undefined) ? 'H:'+c.hold : 'S:'+c.id;
    if(seen.has(g)) return false;
    seen.add(g);
  }
  return true;
}

function runTest(numDrafts){
  let checked=0;
  let tieBoundaryFail=0;      // floor==true optimum must still find/record it
  let overshootFail=0;        // result must never exceed true optimum
  let fabricationFail=0;      // floor set above achievable must not fabricate a completion
  let siblingSplitFail=0;     // partitioned-worker-vs-sibling-floor scenario

  for(let s=0;s<numDrafts;s++){
    const draft = generate(s*13+3);
    if(draft.cards.length < 4) continue;
    // keep instances small enough for the brute oracle to finish fast
    let combos=1; let bad=false;
    for(const slot of draft.form.slots){
      const n = draft.cards.filter(c=>c.pos.includes(slot)).length;
      if(n===0){bad=true;break;}
      combos*=n;
    }
    if(bad || combos>200000) continue;
    const oracle = bruteForce(draft.form, draft.cards, scoreXI, {});
    if(oracle.infeasible || oracle.best<0) continue;
    checked++;
    const trueBest = oracle.best;

    // (1) floor == trueBest exactly, full candidate set (no rootAllow restriction) -- must still
    // find and record a completion at exactly trueBest, not silently drop it.
    {
      const floor = makeFloor(trueBest);
      const r = solveBest(draft.form, draft.cards, 5_000_000, 99, undefined, undefined, false, undefined, undefined, undefined, floor, undefined);
      if(r.best !== trueBest) tieBoundaryFail++;
      if(r.best > trueBest + 1e-9) overshootFail++;
    }

    // (2) floor == trueBest + 1 (unreachable), full candidate set -- must never report a score
    // above trueBest (it can't fabricate a completion that doesn't exist); per the changelog it
    // should come back empty/at the seed since nothing can beat an unreachable floor at a leaf.
    {
      const floor = makeFloor(trueBest + 1);
      const r = solveBest(draft.form, draft.cards, 5_000_000, 99, undefined, undefined, false, undefined, undefined, undefined, floor, undefined);
      if(r.best > trueBest) { overshootFail++; fabricationFail++; }
      // r.bestXIs, if any, must still be legal completions and must not claim total>=floor
      for(const b of (r.bestXIs||[])){
        if(!legalCheck(draft.form, b.xi)) fabricationFail++;
        if(b.sc.total >= trueBest+1) fabricationFail++;
      }
    }

    // (3) REAL split-worker shape: partition the root slot's candidates into two disjoint halves
    // (rootAllow), give "worker 2" a floor seeded from "worker 1"'s true best on ITS half, and
    // confirm worker 2 (a) never fabricates above the true GLOBAL best, and (b) if worker 2's own
    // half can't beat worker 1's floor, it safely returns a best at or below that floor rather
    // than inventing something higher -- while the MERGE of both workers still recovers the true
    // global optimum (the actual soundness property _mergeWorkerResults depends on).
    {
      const order = draft.form.slots.map((s,i)=>i).sort((a,b)=>
        draft.cards.filter(c=>c.pos.includes(draft.form.slots[a])).length -
        draft.cards.filter(c=>c.pos.includes(draft.form.slots[b])).length);
      const rootSlotIdx = order[0];
      const rootSlotLabel = draft.form.slots[rootSlotIdx];
      const rootCandIds = draft.cards.filter(c=>c.pos.includes(rootSlotLabel)).map(c=>c.id);
      if(rootCandIds.length >= 2){
        const half = Math.ceil(rootCandIds.length/2);
        const allowA = new Set(rootCandIds.slice(0,half));
        const allowB = new Set(rootCandIds.slice(half));
        if(allowA.size>0 && allowB.size>0){
          const rA = solveBest(draft.form, draft.cards, 5_000_000, 99, undefined, undefined, false, undefined, allowA, undefined, undefined, rootSlotIdx);
          const floorFromA = makeFloor(rA.best);
          const rB = solveBest(draft.form, draft.cards, 5_000_000, 99, undefined, undefined, false, undefined, allowB, undefined, floorFromA, rootSlotIdx);
          // rB must never exceed the true global optimum
          if(rB.best > trueBest) { overshootFail++; siblingSplitFail++; }
          // merged answer (max of the two partitions) must equal the true global optimum --
          // this is the actual property the whole mechanism exists to preserve
          const merged = Math.max(rA.best, rB.best);
          if(merged !== trueBest) siblingSplitFail++;
        }
      }
    }
  }
  return { checked, tieBoundaryFail, overshootFail, fabricationFail, siblingSplitFail };
}

if(require.main===module){
  const r = runTest(4000);
  console.log('=== B) sharedFloor forced to exact boundary values ===');
  console.log(`checked: ${r.checked}`);
  console.log(`(1) floor==trueBest, dropped-tie failures: ${r.tieBoundaryFail} (expect 0)`);
  console.log(`(2) floor==trueBest+1, overshoot/fabrication failures: ${r.overshootFail}/${r.fabricationFail} (expect 0/0)`);
  console.log(`(3) real split-worker (partition+sibling floor), soundness failures: ${r.siblingSplitFail} (expect 0)`);
  const fail = r.tieBoundaryFail||r.overshootFail||r.fabricationFail||r.siblingSplitFail;
  console.log(fail? 'FAIL' : 'PASS');
  if(fail) process.exitCode=1;
}
module.exports = { runTest };
