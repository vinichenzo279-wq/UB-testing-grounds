'use strict';
const { execFileSync } = require('child_process');
const tests = [
  'test_A_sort_isolated.js',
  'test_B_floor_forced.js',
  'test_C_cas_concurrency.js',
  'test_D_multiworker_e2e.js',
  'test_E_absent_regression.js',
];
let allOk = true;
for(const t of tests){
  console.log('\n' + '='.repeat(90));
  console.log('RUNNING ' + t);
  console.log('='.repeat(90));
  try{
    const out = execFileSync('node', [t], {cwd:__dirname, encoding:'utf8'});
    process.stdout.write(out);
  }catch(e){
    allOk = false;
    process.stdout.write(e.stdout||'');
    console.log('*** ' + t + ' EXITED NON-ZERO ***');
  }
}
console.log('\n' + '='.repeat(90));
console.log(allOk ? 'ALL SUITES PASSED' : 'AT LEAST ONE SUITE FAILED');
