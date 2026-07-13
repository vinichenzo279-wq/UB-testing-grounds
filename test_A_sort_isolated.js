'use strict';
// ==========================================================================================
// TEST A) Root-candidate sort (item 7c), in isolation.
// Verbatim copy of the sort block from _runSolveParallel (index.html lines ~8466-8472), lifted
// out so it can be checked against its own precondition directly, the same "don't infer
// soundness of a component from an aggregate end-to-end pass rate" discipline solver_bound_
// tests_v2.js used for the DAC branch.
// ==========================================================================================
const { generate } = require('./fuzz_gen.js');

function sortRootCands(rootCandsIn){
  const rootCands = rootCandsIn.slice(); // don't mutate caller's array for this isolated test
  const __rn={},__rc={};
  for(const c of rootCands){__rn[c.nation]=(__rn[c.nation]||0)+1;if(c.type==='normal')__rc[c.club]=(__rc[c.club]||0)+1;}
  rootCands.sort((a,b)=>{
    const ka=a.rating+0.4/(__rn[a.nation]||1)+(a.type==='normal'?0.4/(__rc[a.club]||1):0);
    const kb=b.rating+0.4/(__rn[b.nation]||1)+(b.type==='normal'?0.4/(__rc[b.club]||1):0);
    return kb-ka;
  });
  return rootCands;
}

function keyOf(c, rn, rc){
  return c.rating+0.4/(rn[c.nation]||1)+(c.type==='normal'?0.4/(rc[c.club]||1):0);
}

function runTest(trials){
  let checked=0, notPermutation=0, notDescending=0;
  for(let t=0;t<trials;t++){
    const draft = generate(t*7+1);
    if(draft.cards.length < 2) continue;
    const before = draft.cards.slice();
    const after = sortRootCands(before);
    checked++;

    // (1) LOSSLESSNESS: sort must be a pure permutation -- same multiset of ids, nothing
    // dropped, nothing duplicated. A partitioning scheme built on a lossy sort would silently
    // shrink the search space and could never be caught by an end-to-end score comparison if
    // the dropped card was never going to be optimal anyway -- exactly the "generator never
    // exercises the actual precondition" trap the DAC lesson describes, so this is checked
    // directly rather than inferred.
    const beforeIds = before.map(c=>c.id).sort((x,y)=>x-y);
    const afterIds = after.map(c=>c.id).sort((x,y)=>x-y);
    const sameSet = beforeIds.length===afterIds.length && beforeIds.every((v,i)=>v===afterIds[i]);
    if(!sameSet) notPermutation++;

    // (2) ORDERING: recompute the key independently (not by re-running the function under
    // test) and confirm strictly-non-increasing order.
    const __rn={},__rc={};
    for(const c of before){__rn[c.nation]=(__rn[c.nation]||0)+1;if(c.type==='normal')__rc[c.club]=(__rc[c.club]||0)+1;}
    let ok=true;
    for(let i=1;i<after.length;i++){
      if(keyOf(after[i],__rn,__rc) > keyOf(after[i-1],__rn,__rc) + 1e-9){ ok=false; break; }
    }
    if(!ok) notDescending++;
  }
  return {checked, notPermutation, notDescending};
}

if(require.main===module){
  const r = runTest(2000);
  console.log('=== A) root-candidate sort, isolated ===');
  console.log(`checked: ${r.checked}  lossy-permutation failures: ${r.notPermutation} (expect 0)  ordering failures: ${r.notDescending} (expect 0)`);
  if(r.notPermutation>0 || r.notDescending>0){ console.log('FAIL'); process.exitCode=1; }
  else console.log('PASS');
}
module.exports = { sortRootCands };
