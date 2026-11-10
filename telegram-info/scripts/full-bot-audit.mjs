import { readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';

const required = Object.freeze({
  runtime: /runtime|worker-entry/u,
  telegram: /telegram|webhook|outbox|private-keyboard/u,
  housing: /housing/u,
  jobcenter: /jobcenter/u,
  security: /security|privacy|webhook/u,
  delivery: /delivery|outbox|transport|media/u
});

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio:'inherit', env:process.env });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`)));
  });
}

try {
  const files = (await readdir(new URL('../test/', import.meta.url)))
    .filter(name => name.endsWith('.test.mjs'))
    .sort();
  if (!files.length) throw new Error('No Telegram test files found');

  console.log(`BOT-WIDE AUDIT: discovered ${files.length} test files`);
  for (const [domain, pattern] of Object.entries(required)) {
    const matches = files.filter(name => pattern.test(name));
    if (!matches.length) throw new Error(`Missing QA coverage group: ${domain}`);
    console.log(`COVERAGE ${domain}: ${matches.length} files`);
  }

  console.log('PHASE 1/4 syntax');
  await run(process.execPath, ['scripts/check-syntax.mjs']);

  console.log('PHASE 2/4 complete Telegram test inventory');
  await run(process.execPath, ['--test', ...files.map(name => `test/${name}`)]);

  console.log('PHASE 3/4 stable baseline');
  await run(process.execPath, ['scripts/verify-stable-baseline.mjs']);

  console.log('PHASE 4/4 live staging release gate');
  await run(process.execPath, ['scripts/verify-live-staging.mjs']);

  console.log(`BOT-WIDE AUDIT PASS: ${files.length} test files + baseline + live staging release gate`);
} catch (error) {
  console.error('BOT-WIDE AUDIT FAIL:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
