import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

export function validateStableBaseline({ release, wrangler, fileExists = fs.existsSync, root = ROOT }) {
  const errors = [];

  if (!release || release.status !== 'verified') {
    errors.push('STABLE_RELEASE.json must declare status=verified');
  }

  if (!release?.baseline || !/^v\d+$/u.test(release.baseline)) {
    errors.push('STABLE_RELEASE.json must declare a versioned baseline such as v21');
  }

  if (!release?.entrypoint) {
    errors.push('STABLE_RELEASE.json must declare entrypoint');
  }

  if (!/^[0-9a-f]{40}$/u.test(String(release?.verified_commit || ''))) {
    errors.push('STABLE_RELEASE.json must pin a full 40-character verified_commit');
  }

  if (release?.promotion_policy !== 'fail-closed') {
    errors.push('Stable promotion policy must remain fail-closed');
  }

  if (release?.entrypoint && wrangler?.main !== release.entrypoint) {
    errors.push(`Wrangler main (${wrangler?.main || 'missing'}) must match verified entrypoint (${release.entrypoint})`);
  }

  if (release?.entrypoint && !fileExists(path.join(root, release.entrypoint))) {
    errors.push(`Verified entrypoint does not exist: ${release.entrypoint}`);
  }

  if (release?.worker && wrangler?.name !== release.worker) {
    errors.push(`Wrangler worker (${wrangler?.name || 'missing'}) must match verified worker (${release.worker})`);
  }

  return errors;
}

export function verifyStableBaseline(root = ROOT) {
  const release = JSON.parse(fs.readFileSync(path.join(root, 'STABLE_RELEASE.json'), 'utf8'));
  const wrangler = JSON.parse(fs.readFileSync(path.join(root, 'wrangler.jsonc'), 'utf8'));
  const errors = validateStableBaseline({ release, wrangler, root });

  if (errors.length) {
    const message = `Stable baseline guard failed:\n- ${errors.join('\n- ')}`;
    throw new Error(message);
  }

  return { baseline: release.baseline, entrypoint: release.entrypoint, worker: release.worker };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = verifyStableBaseline();
    console.log(`Stable baseline OK: ${result.baseline} -> ${result.entrypoint} (${result.worker})`);
  } catch (error) {
    console.error(error?.message || error);
    process.exitCode = 1;
  }
}
