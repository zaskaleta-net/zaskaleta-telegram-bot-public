import { spawn } from 'node:child_process';

function run(label, command, args) {
  console.log(`\n=== ${label} ===`);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio:'inherit', env:process.env });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`${label} exited with ${code}`)));
  });
}

try {
  console.log('FULL TELEGRAM RELEASE QA — production delivery remains disabled');
  await run('BOT-WIDE QA', process.execPath, ['scripts/full-bot-audit.mjs']);
  await run('LIVE HOUSING SOURCES — SCHLESWIG-HOLSTEIN 15/15', process.execPath, ['scripts/live-housing-source-audit.mjs']);
  console.log('\nFULL TELEGRAM RELEASE QA PASS');
  console.log('Bot tests + housing flows: PASS');
  console.log('Schleswig-Holstein live source reachability: 15/15 PASS');
  console.log('Stable baseline: PASS');
  console.log('Staging safety: PASS');
  console.log('Production delivery: NOT ENABLED');
} catch (error) {
  console.error('\nFULL TELEGRAM RELEASE QA FAIL:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
