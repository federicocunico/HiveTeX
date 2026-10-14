#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function diagnosticMessage(name, outcome, report) {
  if (outcome !== 'success') return `${name} diagnostics did not pass (${outcome || 'not run'}). See the diagnostic artifact; required checks remain independent.`;
  const failed = report?.stats?.unexpected ?? 0;
  const flaky = report?.stats?.flaky ?? 0;
  if (failed || flaky) return `${name} diagnostics: ${failed} failures, ${flaky} tests passed only on retry. See the diagnostic artifact.`;
  return null;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [name = 'UI', outcome, path] = process.argv.slice(2);
  let report;
  if (path) { try { report = JSON.parse(readFileSync(path, 'utf8')); } catch { /* a setup failure may have no report */ } }
  const warning = diagnosticMessage(name, outcome, report);
  if (warning) console.log(`::warning::${warning.replaceAll('\n', ' ')}`);
  const line = warning ? `⚠ ${warning}` : `${name} diagnostics passed without retries.`;
  console.log(line);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, line + '\n');
}
