/**
 * Exit codes, exercised through the real CLI.
 *
 * Asserted end to end rather than by calling the classifier directly, because the code is
 * the contract: whatever runs this on a schedule sees a number and nothing else. A unit
 * test that proves the mapping is correct while the CLI swallows it would be worse than
 * no test at all.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { EXIT } from '../harness/types.js';

const CLI = fileURLToPath(new URL('../cli.ts', import.meta.url));
const TIMEOUT = 120_000;

function run(args: string[]): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['tsx', CLI, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (d) => (output += String(d)));
    child.stderr.on('data', (d) => (output += String(d)));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, output }));
  });
}

describe('exit codes', () => {
  it(`returns ${EXIT.pass} when every check passes`, { timeout: TIMEOUT }, async () => {
    const { code } = await run(['--brain', 'oracle']);
    assert.equal(code, EXIT.pass);
  });

  it(`returns ${EXIT.qualityFail} when the brain is bad`, { timeout: TIMEOUT }, async () => {
    const { code, output } = await run(['--brain', 'flat']);
    assert.equal(code, EXIT.qualityFail);
    assert.match(output, /VERDICT: FAIL/);
  });

  it(`returns ${EXIT.usage} for an unknown brain`, { timeout: TIMEOUT }, async () => {
    const { code } = await run(['--brain', 'nonesuch']);
    assert.equal(code, EXIT.usage);
  });

  it(`returns ${EXIT.usage} rather than spending without consent`, { timeout: TIMEOUT }, async () => {
    const { code, output } = await run(['--brain', 'remote']);
    assert.equal(code, EXIT.usage);
    assert.match(output, /--yes-spend/);
  });

  it(
    `returns ${EXIT.serviceUnavailable} when the brain cannot be reached`,
    { timeout: TIMEOUT },
    async () => {
      // Port 1 is reserved and never listening, so this is an outage and not an opinion.
      const { code, output } = await run(['--brain', 'adapter', '--endpoint', 'http://127.0.0.1:1']);
      assert.equal(code, EXIT.serviceUnavailable);
      assert.doesNotMatch(output, /VERDICT/);
    },
  );

  it(
    `returns ${EXIT.invalidHoldout} when the window cannot be trusted`,
    { timeout: TIMEOUT },
    async () => {
      const { code } = await run(['--brain', 'flat', '--window', 'not-a-window']);
      assert.equal(code, EXIT.invalidHoldout);
    },
  );
});
