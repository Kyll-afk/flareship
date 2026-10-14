import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { after, beforeEach, test } from 'node:test';
import { parseArgs } from '../src/cli.js';
import { Fail } from '../src/errors.js';
import { createCli, makeRepo, startMock, tempDir } from '../support/mock.js';

const mock = await startMock();
const flareship = createCli(mock);
after(() => mock.close());
beforeEach(() => mock.reset());

const version = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

test('parseArgs separates the command, its arguments and the options', () => {
  assert.deepEqual(parseArgs(['import', '--name', 'x', '--build=npm run build', '--out', 'dist', '-y', '--no-previews']), {
    command: 'import',
    args: [],
    flags: { name: 'x', build: 'npm run build', out: 'dist', yes: true, 'no-previews': true },
  });
  assert.deepEqual(parseArgs(['logs', 'abc123', '-f']), { command: 'logs', args: ['abc123'], flags: { follow: true } });
  assert.deepEqual(parseArgs([]), { command: undefined, args: [], flags: {} });
  assert.deepEqual(parseArgs(['import', '--build', '']).flags, { build: '' });
  assert.deepEqual(parseArgs(['login', '--token', '--workers', '--pages']).flags, { token: true, workers: true, pages: true });
  assert.deepEqual(parseArgs(['logs', '--', '--weird-id', '-f']), { command: 'logs', args: ['--weird-id', '-f'], flags: {} });
  assert.deepEqual(parseArgs(['-h', '-v']).flags, { help: true, version: true });
  assert.throws(() => parseArgs(['import', '--nope']), Fail);
  assert.throws(() => parseArgs(['import', '-x']), Fail);
  assert.throws(() => parseArgs(['import', '--name']), Fail);
});

test('help is shown for no command, the help command and the help options', async () => {
  for (const argv of [[], ['help'], ['--help'], ['-h'], ['status', '--help']]) {
    const { code, output } = await flareship(os.tmpdir(), argv);
    assert.equal(code, 0);
    assert.match(output, /flareship import\s+connect this repository/);
    assert.match(output, /--workers\s+treat the project as a Worker/);
  }
  assert.equal(mock.state.requests.length, 0);
});

test('the version is the one in package.json', async () => {
  for (const argv of [['--version'], ['-v'], ['status', '-v']]) {
    const { code, output } = await flareship(os.tmpdir(), argv);
    assert.equal(code, 0);
    assert.equal(output, version);
  }
});

test('guide prints the walkthrough without touching the network', async () => {
  const { code, output } = await flareship(os.tmpdir(), ['guide']);
  assert.equal(code, 0);
  assert.match(output, /1\. Put the project on GitHub/);
  assert.match(output, /flareship login --token/);
  assert.match(output, /Workers Builds Configuration/);
  assert.match(output, /github\.com\/settings\/installations/);
  assert.match(output, /workers-and-pages\/create\/pages/);
  assert.equal(mock.state.requests.length, 0);
});

test('mistyped commands and options are refused with a pointer to help', async () => {
  const cases = [
    [['publish'], /Unknown command "publish"\. Run "flareship help"/],
    [['status', '--nope'], /Unknown option --nope/],
    [['status', '-x'], /Unknown option -x/],
    [['import', '--name'], /--name needs a value/],
  ];
  for (const [argv, message] of cases) {
    const { code, output } = await flareship(os.tmpdir(), argv);
    assert.equal(code, 1);
    assert.match(output, message);
  }
  assert.equal(mock.state.requests.length, 0);
});

test('with no command in a terminal, flareship starts an import', async () => {
  const { code, output } = await flareship(tempDir(), [], { interactive: true });
  assert.equal(code, 1);
  assert.match(output, /1\/4\s+Repository/);
  assert.match(output, /This folder is not inside a Git repository/);
});

test('an error with instructions keeps its first line on the mark and indents the rest', async () => {
  const { code, output } = await flareship(makeRepo('locked', { 'public/index.html': '<html>' }), ['import', '--yes']);
  assert.equal(code, 1);
  assert.match(output, /\n {2}\S Cloudflare cannot see github\.com\/Acme\/locked[^\n]*\n {4}Nothing was created\.\n/);
});

test('an unexpected failure is not swallowed', async () => {
  const boom = async () => {
    throw new TypeError('boom');
  };
  await assert.rejects(() => flareship(os.tmpdir(), ['list'], { env: { CLOUDFLARE_API_TOKEN: '' }, deps: { wranglerToken: boom } }), /boom/);
});

test('an unreachable API is reported as a connection problem', async () => {
  const { code, output } = await flareship(os.tmpdir(), ['list'], { env: { FLARESHIP_API_BASE: 'http://127.0.0.1:9/v4' } });
  assert.equal(code, 1);
  assert.match(output, /Could not reach Cloudflare/);
});
