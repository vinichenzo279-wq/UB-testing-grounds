'use strict';
// fuzz_run_wide.js — wide-scale / long-running variant of fuzz_run_rcsens.js.
//
// Differences from fuzz_run_rcsens.js:
//   1. TIERED BUDGETS: drafts are classified by estimated combo count into tiers (tiny/small/
//      medium/large/huge), each with its own brute-force time budget AND leaf (node) cap. Bigger
//      drafts get proportionally more brute-force effort instead of a single fixed budget.
//   2. COMPLEXITY INFLATION: ~1 in 3 generated drafts gets its candidate pool duplicated (unique
//      ids, no inherited holds) 2-4x to push per-slot candidate counts and total combos higher,
//      specifically to stress the solver's pruning/UB math on bigger search trees than
//      fuzz_gen.js's own dials produce alone.
//   3. PARTIAL-BRUTE LOWER BOUND: when brute force times out / hits its leaf cap before finishing,
//      it still returns the best it found so far (bt.best), which is a valid LOWER BOUND on the
//      true optimum (brute never overcounts, it just may not finish). Instead of discarding these
//      drafts, we check solver_best < bt.best_partial -- if the solver ever returns LESS than a
//      lower bound the brute force already confirmed reachable, that's a definite soundness
//      violation regardless of whether brute ever found the true max. Cases where solver_best >=
//      bt.best_partial are inconclusive (not proof of correctness) and are counted separately,
//      never reported as findings.
//   4. PERIODIC CHECKPOINTING: state is flushed to disk every CHECKPOINT_SECS (default 30s) or
//      CHECKPOINT_EVERY drafts, whichever comes first -- not just at the end -- so progress
//      survives being killed/interrupted at any point, and can be inspected while still running.
//
// Usage: node fuzz_run_wide.js [totalSeconds] [checkpointSecs]
//   totalSeconds defaults to a very large number (effectively "run until stopped").
const fs = require('fs');
const P = require('./prod_solver.js');
const B = require('./indep_brute.js');
const G = require('./fuzz_gen.js');

const TOTAL_SECONDS = parseInt(process.argv[2] || '21600', 10); // default 6h
const CHECKPOINT_SECS = parseInt(process.argv[3] || '30', 10);
const STATE = '/home/claude/fuzz_wide_state.json';
const FINDINGS = '/home/claude/fuzz_wide_findings.jsonl';
const LOG = '/home/claude/fuzz_wide_log.txt';

function log(line) {
  const msg = `[${new Date().toISOString()}] ${line}`;
  console.log(msg);
  fs.appendFileSync(LOG, msg + '\n');
}

// --- tier table: [maxCombos, bruteTimeMs, bruteLeafCap] ---
const TIERS = [
  { name: 'tiny',   maxCombos: 1e5,  timeMs: 3000,   leafCap: 5e6 },
  { name: 'small',  maxCombos: 1e7,  timeMs: 15000,  leafCap: 4e7 },
  { name: 'medium', maxCombos: 1e9,  timeMs: 60000,  leafCap: 1.5e8 },
  { name: 'large',  maxCombos: 1e11, timeMs: 240000, leafCap: 4e8 },
  { name: 'huge',   maxCombos: Infinity, timeMs: 600000, leafCap: 8e8 },
];
function tierFor(est) {
  for (const t of TIERS) if (est <= t.maxCombos) return t;
  return TIERS[TIERS.length - 1];
}

// --- complexity inflation: duplicate the candidate pool to raise per-slot counts ---
function inflate(draft, factor) {
  const cards = draft.cards.slice();
  let nextId = Math.max(...cards.map(c => c.id)) + 1;
  const base = draft.cards;
  for (let f = 1; f < factor; f++) {
    for (const c of base) {
      const clone = Object.assign({}, c, { id: nextId++, hold: null, label: c.label + '_dup' + f });
      cards.push(clone);
    }
  }
  return Object.assign({}, draft, { cards, inflated: factor });
}

let state = {
  seed: 1, tested: 0, skippedInfeasible: 0,
  findings: 0,                    // confirmed soundness violations (complete brute OR partial-lower-bound breach)
  completeBrute: 0,               // drafts where brute finished (true optimum known)
  partialBrute: 0,                // drafts where brute capped out (only a lower bound known)
  partialInconclusive: 0,         // partial-brute cases where solver >= partial best (no evidence either way)
  rcm1_scorePreserved: 0, rcm1_scoreDropped: 0, rcm1_tested: 0,
  rcm2_misses: 0, rcm2_matches: 0, rcm2_tested: 0,
  byTier: {}, byRegime: {}, inflatedTested: 0,
  startedAt: new Date().toISOString(),
};
try {
  const loaded = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  state = Object.assign(state, loaded);
  log(`Resumed from checkpoint: seed=${state.seed} tested=${state.tested} findings=${state.findings}`);
} catch (e) {
  log('No prior checkpoint found, starting fresh.');
}

const deadline = Date.now() + TOTAL_SECONDS * 1000;
let lastCheckpoint = Date.now();

function checkpoint(force) {
  if (force || Date.now() - lastCheckpoint > CHECKPOINT_SECS * 1000) {
    fs.writeFileSync(STATE, JSON.stringify(state, null, 2));
    lastCheckpoint = Date.now();
    log(`checkpoint: tested=${state.tested} findings=${state.findings} complete=${state.completeBrute} partial=${state.partialBrute} partialInconclusive=${state.partialInconclusive} byTier=${JSON.stringify(state.byTier)}`);
  }
}

log(`Starting wide fuzz run: totalSeconds=${TOTAL_SECONDS} checkpointSecs=${CHECKPOINT_SECS}`);

while (Date.now() < deadline) {
  const seed = state.seed++;
  let d = G.generate(seed);

  // ~1/3 of drafts get complexity inflation (2-4x pool duplication)
  let inflated = false;
  if (seed % 3 === 0) {
    const factor = 2 + (seed % 3); // 2,3,4
    d = inflate(d, factor);
    inflated = true;
  }

  const est = B.estimateCombos(d.form, d.cards);
  if (est === 0) { state.skippedInfeasible++; continue; }

  const tier = tierFor(est);
  state.byTier[tier.name] = (state.byTier[tier.name] || 0) + 1;
  state.byRegime[d.regime] = (state.byRegime[d.regime] || 0) + 1;
  if (inflated) state.inflatedTested++;

  let rc = null;
  try { rc = P.maxPossibleRating(d.cards, d.form); } catch (e) { rc = null; }
  const rcUsed = rc === null ? 96 : rc;

  const rs = P.solveBest(d.form, d.cards, 1e9, rcUsed);
  const rs103 = P.solveBest(d.form, d.cards, 1e9, 103);
  const solverBest = rs.error ? -1 : rs.best;
  const solver103 = rs103.error ? -1 : rs103.best;

  const bt = B.bruteForce(d.form, d.cards, P.scoreXI, { timeBudgetMs: tier.timeMs, leafCap: tier.leafCap });
  state.tested++;

  const baseFinding = {
    seed, regime: d.regime, formName: d.formName, est, tier: tier.name, inflated,
    rcAuto: rcUsed, solverBestAtAutoRC: solverBest, solverBestAtRC103: solver103,
  };

  if (bt.complete) {
    state.completeBrute++;
    if (bt.best !== solverBest || bt.best !== solver103) {
      state.findings++;
      const finding = Object.assign({}, baseFinding, {
        kind: 'SOUNDNESS_COMPLETE', bruteBest: bt.best,
        diagnosis: bt.best > solverBest
          ? (bt.best > solver103 ? 'UB-UNSOUND (missed even at RC 103)' : 'RC-RELATED (auto RC pruned it; RC 103 finds it)')
          : 'SOLVER-ABOVE-BRUTE (invalid-squad bug or brute legality bug)',
        form: d.form, cards: d.cards,
      });
      fs.appendFileSync(FINDINGS, JSON.stringify(finding) + '\n');
      log(`!!! SOUNDNESS FINDING (complete brute) seed=${seed} tier=${tier.name} -> ${finding.diagnosis}`);
    }

    // RC-1 / RC-2 probes only meaningful against a confirmed true optimum
    const rcm1 = rcUsed - 1;
    const rsM1 = P.solveBest(d.form, d.cards, 1e9, rcm1);
    const solverM1 = rsM1.error ? -1 : rsM1.best;
    state.rcm1_tested++;
    if (solverM1 === bt.best) {
      state.rcm1_scorePreserved++;
    } else if (solverM1 < bt.best) {
      state.rcm1_scoreDropped++;
      const finding = Object.assign({}, baseFinding, {
        kind: 'RC-1_SCORE_DROPPED', rcMinus1: rcm1, solverAtRcMinus1: solverM1, bruteBest: bt.best,
        form: d.form, cards: d.cards,
      });
      fs.appendFileSync(FINDINGS, JSON.stringify(finding) + '\n');
      log(`!!! RC-1 SCORE DROPPED seed=${seed} tier=${tier.name} solverAtRC-1=${solverM1} brute=${bt.best}`);
    } else {
      state.rcm1_scoreDropped++;
      log(`!!! RC-1 SOLVER ABOVE BRUTE seed=${seed} solverAtRC-1=${solverM1} brute=${bt.best}`);
    }

    const rcm2 = rcUsed - 2;
    const rsM2 = P.solveBest(d.form, d.cards, 1e9, rcm2);
    const solverM2 = rsM2.error ? -1 : rsM2.best;
    state.rcm2_tested++;
    if (solverM2 < bt.best) state.rcm2_misses++; else state.rcm2_matches++;

  } else {
    // Brute capped out -- bt.best is still a valid LOWER BOUND on the true optimum (0 if no
    // legal assignment was found before capping, which we treat as "no evidence" rather than a
    // bound of 0 -- only compare when bt.best > -1, i.e. at least one legal squad was scored).
    state.partialBrute++;
    if (bt.best > -1 && (solverBest < bt.best || solver103 < bt.best)) {
      state.findings++;
      const finding = Object.assign({}, baseFinding, {
        kind: 'SOUNDNESS_PARTIAL_LOWER_BOUND', brutePartialBest: bt.best,
        bruteLeavesChecked: bt.leaves, bruteNodesChecked: bt.checked,
        diagnosis: 'Solver returned below a CONFIRMED-REACHABLE score brute force already found ' +
                   'before capping out -- definite violation regardless of the true optimum.',
        form: d.form, cards: d.cards,
      });
      fs.appendFileSync(FINDINGS, JSON.stringify(finding) + '\n');
      log(`!!! SOUNDNESS FINDING (partial brute lower bound) seed=${seed} tier=${tier.name} solverBest=${solverBest} solver103=${solver103} vs partialBrute=${bt.best}`);
    } else {
      state.partialInconclusive++;
    }
  }

  checkpoint(false);
}

checkpoint(true);
log(`DONE. tested=${state.tested} findings=${state.findings} completeBrute=${state.completeBrute} partialBrute=${state.partialBrute} partialInconclusive=${state.partialInconclusive}`);
log(`byTier: ${JSON.stringify(state.byTier)}`);
log(`byRegime: ${JSON.stringify(state.byRegime)}`);
