import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

function run(command, args) {
  execFileSync(command, args, { stdio: 'inherit', env: process.env });
}

const proofPath = resolve('src/build-qa-proof.mjs');
const sha = String(
  process.env.WORKERS_CI_COMMIT_SHA ||
  process.env.CF_PAGES_COMMIT_SHA ||
  process.env.GITHUB_SHA ||
  process.env.COMMIT_SHA ||
  'build-environment',
).trim();

// Cloudflare build QA must be deterministic and self-contained. Network-backed
// statewide source/provenance audits remain separate diagnostics and must not
// make a deploy depend on third-party availability.
writeFileSync(
  proofPath,
  `// Build QA gate; phone acceptance remains separate.\nexport const BUILD_QA_PROOF=Object.freeze({passed:false,statewideRouting:1104,sha:${JSON.stringify(sha)}});\n`,
  'utf8',
);

run(process.execPath, ['scripts/check-syntax.mjs']);
run(process.execPath, ['--test', 'test/*.test.mjs']);

console.log(`CLOUDFLARE_TELEGRAM_BUILD_QA_PASS sha=${sha} proof=false`);
