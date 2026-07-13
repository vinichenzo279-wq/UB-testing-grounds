'use strict';
// ==========================================================================================
// TEST E) sharedFloor/rootSlotIdx ABSENT -- regression check on the untouched default path.
// Every call site that doesn't opt in (serial solves, bench/manager, completeOOP, non-worker
// fallback) passes sharedFloor:undefined. This confirms that path still returns the true
// optimum against the independent brute-force oracle across all 11 synthetic regimes -- i.e.
// item 7's new params didn't perturb the code every OTHER caller still depends on.
// ==========================================================================================
const { generate, REGIMES } = require('./fuzz_gen.js');
const { bruteForce } = require('./indep_brute.js');
const { scoreXI, solveBest } = require('./prod_solver.js');

function runTest(trials){
  let checked=0, mismatches=0;
  const perRegime = {};
  for(let t=0;t<trials;t++){
    const draft = generate(t);
    perRegime[draft.regime] = perRegime[draft.regime] || {checked:0, mismatches:0};
    let combos=1, bad=false;
    for(const slot of draft.form.slots){
      const n = draft.cards.filter(c=>c.pos.includes(slot)).length;
      if(n===0){bad=true;break;}
      combos*=n;
    }
    if(bad || combos>300000) continue;
    const oracle = bruteForce(draft.form, draft.cards, scoreXI, {});
    if(oracle.infeasible) continue;
    const r = solveBest(draft.form, draft.cards, 5_000_000, 99, undefined, undefined, false, undefined, undefined, undefined, undefined, undefined);
    checked++; perRegime[draft.regime].checked++;
    if(r.best !== oracle.best){
      mismatches++; perRegime[draft.regime].mismatches++;
      console.log(`  MISMATCH seed ${t} regime ${draft.regime}: solver=${r.best} brute=${oracle.best}`);
    }
  }
  return {checked, mismatches, perRegime};
}

if(require.main===module){
  const r = runTest(3000);
  console.log('=== E) sharedFloor-absent regression, all synthetic regimes ===');
  for(const reg of REGIMES){
    const p = r.perRegime[reg];
    if(p) console.log(`  ${reg.padEnd(12)} checked=${p.checked}  mismatches=${p.mismatches}`);
  }
  console.log(`TOTAL checked: ${r.checked}  mismatches: ${r.mismatches} (expect 0)`);
  console.log(r.mismatches===0 ? 'PASS' : 'FAIL');
  if(r.mismatches>0) process.exitCode=1;
}
module.exports = { runTest };
