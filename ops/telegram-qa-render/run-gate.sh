#!/usr/bin/env sh
set -eu

run_step() {
  name="$1"
  shift
  log="/tmp/qa-${name}.log"
  echo "QA_STEP_BEGIN ${name}"
  if "$@" >"$log" 2>&1; then
    echo "QA_STEP_PASS ${name}"
    grep -E '(_PASS|Stable baseline OK|# tests|# pass|# fail|Syntax OK)' "$log" | tail -n 12 || true
  else
    code=$?
    echo "QA_STEP_FAIL ${name} exit=${code}"
    echo "QA_FAILURE_INDEX_BEGIN ${name}"
    grep -n -E 'not ok|failureType|AssertionError|ERR_ASSERTION|expected:|actual:' "$log" | head -n 240 || true
    echo "QA_FAILURE_INDEX_END ${name}"
    tail -n 160 "$log" || true
    exit "$code"
  fi
}

run_step syntax npm --prefix telegram-info run check
run_step fuzz node .github/qa/telegram-full-fuzz-x64.mjs
run_step full-suite sh -c 'node --test --test-concurrency=8 telegram-info/test/*.test.mjs'
run_step baseline npm --prefix telegram-info run verify:baseline
run_step statewide-runtime node .github/qa/telegram-statewide-runtime-audit-x64.mjs
run_step statewide-authoritative node telegram-info/scripts/audit-sh-municipality-routing.mjs
run_step forensic node telegram-info/scripts/telegram-forensic-audit.mjs
run_step staging-contract npm --prefix telegram-info run verify:staging
run_step control-validate npm --prefix telegram-control run validate

echo "QA_GATE_PASS"
exec node ops/telegram-qa-render/server.mjs
