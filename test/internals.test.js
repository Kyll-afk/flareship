import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { ApiError, createClient, isAuthError } from '../src/api.js';
import { clearConfig, clearSession, configPath, loadConfig, loadSession, saveConfig, saveSession } from '../src/config.js';
import { Fail } from '../src/errors.js';
import { readRepo } from '../src/git.js';
import { openInBrowser } from '../src/commands.js';
import { detect } from '../src/detect.js';
import { githubRepo, localToken, run } from '../src/github.js';
import { ask, askSecret, busy, columns, confirm, fields, pad, spinner, table, truncate, width } from '../src/ui.js';
import { parseToken, wrangler, wranglerLogin, wranglerToken } from '../src/wrangler.js';
import { makeRepo, tempDir, writeFiles } from '../support/mock.js';

const reply = (status, body) => ({ ok: status < 400, status, json: async () => body });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function terminal() {
  const input = new PassThrough();
  const output = new PassThrough();
  let written = '';
  output.on('data', (chunk) => {
    written += chunk;
  });
  const type = async (text) => {
    await sleep(15);
    input.write(text);
  };
  return { streams: { input, output }, type, written: () => written };
}

test('ask returns the typed answer or the default', async () => {
  const t = terminal();
  const typed = ask('Project name', 'demo', t.streams);
  await t.type('my-shop\n');
  assert.equal(await typed, 'my-shop');
  assert.match(t.written(), /Project name \(demo\): /);

  const empty = ask('Project name', 'demo', t.streams);
  await t.type('\n');
  assert.equal(await empty, 'demo');

  const padded = ask('Branch', '', t.streams);
  await t.type('  main  \n');
  assert.equal(await padded, 'main');
});

test('confirm understands yes, no and the default', async () => {
  const t = terminal();
  for (const [typed, fallback, expected] of [['y\n', false, true], ['YES\n', false, true], ['n\n', true, false], ['nope\n', true, false], ['\n', true, true], ['\n', false, false]]) {
    const answer = confirm('Create this project?', fallback, t.streams);
    await t.type(typed);
    assert.equal(await answer, expected, `${JSON.stringify(typed)} with default ${fallback}`);
  }
  assert.match(t.written(), /Create this project\? \(Y\/n\)/);
  assert.match(t.written(), /Create this project\? \(y\/N\)/);
});

test('askSecret shows its prompt but never the typed token', async () => {
  const t = terminal();
  const secret = askSecret('Paste the token (hidden)', t.streams);
  await t.type('cfut_supersecret\n');
  assert.equal(await secret, 'cfut_supersecret');
  assert.match(t.written(), /Paste the token \(hidden\): /);
  assert.doesNotMatch(t.written(), /supersecret/);
});

test('the spinner animates only on a terminal and cleans up after itself', async () => {
  const writes = [];
  const tty = { isTTY: true, write: (text) => writes.push(text) };

  const result = await busy('Loading your projects', () => sleep(220).then(() => 'done'), { stream: tty, env: {} });
  assert.equal(result, 'done');
  assert.ok(writes.filter((w) => w.includes('Loading your projects')).length >= 2);
  assert.equal(writes.at(-1), '\r\x1b[2K');

  writes.length = 0;
  const progress = spinner('First', { stream: tty, env: {} });
  progress.text('Second');
  await sleep(120);
  progress.clear();
  progress.stop();
  assert.ok(writes.some((w) => w.includes('Second')));
  const settled = writes.length;
  await sleep(120);
  assert.equal(writes.length, settled);

  writes.length = 0;
  await assert.rejects(() => busy('Failing', () => Promise.reject(new Error('nope')), { stream: tty, env: {} }), /nope/);
  assert.equal(writes.at(-1), '\r\x1b[2K');

  for (const options of [{ stream: { isTTY: false, write: (t) => writes.push(t) }, env: {} }, { stream: tty, env: { CI: '1' } }, { stream: tty, env: { FLARESHIP_NO_SPINNER: '1' } }]) {
    writes.length = 0;
    const quiet = spinner('Quiet', options);
    quiet.text('Still quiet');
    quiet.clear();
    quiet.stop();
    assert.deepEqual(writes, []);
  }
});

test('the spinner shows elapsed seconds once a wait gets long', async () => {
  const writes = [];
  await busy('Slow', () => sleep(2150), { stream: { isTTY: true, write: (text) => writes.push(text) }, env: {} });
  assert.ok(writes.some((w) => /Slow {2}2s$/.test(w)));
  assert.ok(!writes[0].includes('0s'));
});

test('layout helpers align text and ignore colour codes', () => {
  assert.equal(width('\x1b[32mok\x1b[0m'), 2);
  assert.equal(pad('\x1b[1mab\x1b[0m', 5), '\x1b[1mab\x1b[0m   ');
  assert.equal(pad('abcdef', 3), 'abcdef');
  assert.equal(truncate('short', 10), 'short');
  assert.ok(truncate('a very long message indeed', 10).length <= 10);
  assert.match(truncate('a very long message indeed', 10), /^a very( lo…|\.\.\.)$/);
  assert.ok(columns() > 0);

  assert.deepEqual(fields([['Branch', 'main'], null, ['Repository', 'x/y']]), ['  Branch       main', '  Repository   x/y']);
  assert.deepEqual(fields([['A', '1']], 4), ['    A   1']);

  const lines = table(
    [
      ['a', 'long-value', 'z'],
      ['bbb', 'c', ''],
    ],
    { header: ['one', 'two', 'three'] },
  );
  assert.deepEqual(lines, ['  ONE  TWO         THREE', '  a    long-value  z', '  bbb  c']);
  assert.deepEqual(table([['x', 'y']], { indent: 0, gap: 1 }), ['x y']);
});

test('the config lives where the environment says, and survives a round trip', () => {
  assert.equal(configPath({ FLARESHIP_CONFIG: '/tmp/custom.json' }), '/tmp/custom.json');
  assert.equal(configPath({ XDG_CONFIG_HOME: '/xdg' }), path.join('/xdg', 'flareship', 'config.json'));
  const fallback = configPath({ APPDATA: 'C:\\Users\\me\\AppData\\Roaming' });
  assert.ok(fallback.endsWith(path.join('flareship', 'config.json')));
  assert.ok(fallback.startsWith(process.platform === 'win32' ? 'C:\\Users\\me\\AppData\\Roaming' : path.join(os.homedir(), '.config')));

  const env = { FLARESHIP_CONFIG: path.join(tempDir(), 'nested', 'config.json') };
  assert.deepEqual(loadConfig(env), {});
  assert.equal(clearConfig(env), false);
  assert.equal(saveConfig({ token: 't', accountId: 'a' }, env), env.FLARESHIP_CONFIG);
  assert.deepEqual(loadConfig(env), { token: 't', accountId: 'a' });

  assert.deepEqual(loadSession(env), {});
  saveSession({ token: 's', savedAt: 5 }, env);
  assert.deepEqual(loadSession(env), { token: 's', savedAt: 5 });
  assert.ok(fs.existsSync(path.join(path.dirname(env.FLARESHIP_CONFIG), 'session.json')));
  clearSession(env);
  clearSession(env);
  assert.deepEqual(loadSession(env), {});

  assert.equal(clearConfig(env), true);
  assert.deepEqual(loadConfig(env), {});

  fs.writeFileSync(env.FLARESHIP_CONFIG, 'not json');
  assert.deepEqual(loadConfig(env), {});
});

test('the wrangler session is read from its JSON output', async () => {
  assert.equal(parseToken('{"type":"oauth","token":"abc"}\n'), 'abc');
  assert.equal(parseToken('some banner\n{"type":"oauth","token":"abc"}\ntrailing'), 'abc');
  assert.equal(parseToken('{"type":"oauth"}'), null);
  assert.equal(parseToken('not logged in'), null);
  assert.equal(parseToken('{broken'), null);
  assert.equal(parseToken('{broken}'), null);
  assert.equal(parseToken(''), null);
  assert.equal(parseToken(undefined), null);

  const calls = [];
  const exec = (result) => async (args, options) => {
    calls.push({ args, options });
    return result;
  };
  assert.equal(await wranglerToken({ A: '1' }, exec({ status: 0, stdout: '{"token":"tok"}' })), 'tok');
  assert.deepEqual(calls[0].args, ['auth', 'token', '--json']);
  assert.deepEqual(calls[0].options.env, { A: '1' });
  assert.equal(await wranglerToken({}, exec({ status: 1, stdout: '{"token":"tok"}' })), null);
  assert.equal(await wranglerToken({}, exec({ status: 0, stdout: '' })), null);

  assert.equal(await wranglerLogin({}, exec({ status: 0, stdout: '' })), true);
  assert.equal(await wranglerLogin({}, exec({ status: 1, stdout: '' })), false);
  assert.deepEqual(calls.at(-1).args, ['login']);
  assert.equal(calls.at(-1).options.inherit, true);
});

test('a GitHub token is taken from the environment, then gh, then the Git credential store', async () => {
  const never = async () => {
    throw new Error('should not run');
  };
  assert.equal(await localToken({ GH_TOKEN: 'a', GITHUB_TOKEN: 'b' }, '.', never), 'a');
  assert.equal(await localToken({ GITHUB_TOKEN: 'b' }, '.', never), 'b');
  assert.equal(await localToken({ FLARESHIP_NO_GIT_CREDENTIALS: '1' }, '.', never), null);

  const calls = [];
  const exec = (answers) => async (command, args, options) => {
    calls.push({ command, args, options });
    return answers[command];
  };
  assert.equal(await localToken({}, '.', exec({ gh: 'gho_fromgh\n' })), 'gho_fromgh');
  assert.equal(calls.length, 1);

  calls.length = 0;
  assert.equal(await localToken({ X: '1' }, '/repo', exec({ gh: null, git: 'protocol=https\nhost=github.com\nusername=me\npassword=gho_fromgit\n' })), 'gho_fromgit');
  assert.deepEqual(calls.map((c) => c.command), ['gh', 'git']);
  assert.deepEqual(calls[1].args, ['credential', 'fill']);
  assert.equal(calls[1].options.env.GIT_TERMINAL_PROMPT, '0');
  assert.equal(calls[1].options.env.X, '1');
  assert.match(calls[1].options.input, /host=github\.com/);

  assert.equal(await localToken({}, '.', exec({ gh: '  \n', git: null })), null);
  assert.equal(await localToken({}, '.', exec({ gh: null, git: 'username=me\n' })), null);
});

test('a repository is looked up on GitHub, with a sign-in only when it is needed', async () => {
  const remote = { type: 'github', owner: 'Acme', repo: 'edge-api' };
  const body = { id: 777, name: 'edge-api', owner: { id: 42, login: 'Acme' } };
  const seen = [];
  const publicFetch = async (url, init) => {
    seen.push({ url, headers: init.headers });
    return reply(200, body);
  };
  const env = { FLARESHIP_NO_GIT_CREDENTIALS: '1' };

  assert.deepEqual(await githubRepo(remote, { env, fetchImpl: publicFetch }), { repoId: '777', repoName: 'edge-api', ownerId: '42', ownerName: 'Acme' });
  assert.equal(seen[0].url, 'https://api.github.com/repos/Acme/edge-api');
  assert.equal(seen[0].headers.Authorization, undefined);
  assert.equal(seen[0].headers['User-Agent'], 'flareship');

  seen.length = 0;
  const privateFetch = async (url, init) => {
    seen.push({ url, headers: init.headers });
    return init.headers.Authorization === 'Bearer gh-secret' ? reply(200, body) : reply(404, { message: 'Not Found' });
  };
  const viaGh = await githubRepo(remote, { env: { FLARESHIP_GITHUB_API: 'https://ghe.example/api/v3/' }, fetchImpl: privateFetch, exec: async (command) => (command === 'gh' ? 'gh-secret\n' : null) });
  assert.equal(viaGh.repoId, '777');
  assert.equal(seen.length, 2);
  assert.equal(seen[0].url, 'https://ghe.example/api/v3/repos/Acme/edge-api');
  assert.equal(seen[1].headers.Authorization, 'Bearer gh-secret');

  await assert.rejects(
    () => githubRepo(remote, { env, fetchImpl: privateFetch }),
    (error) => error instanceof Fail && /Could not read github\.com\/Acme\/edge-api from GitHub \(HTTP 404\)/.test(error.message) && /gh auth login/.test(error.message),
  );
  await assert.rejects(
    () => githubRepo(remote, { env: { GH_TOKEN: 'wrong' }, fetchImpl: privateFetch }),
    (error) => error instanceof Fail && /HTTP 404/.test(error.message),
  );
  const offline = async () => {
    throw new Error('getaddrinfo ENOTFOUND api.github.com');
  };
  await assert.rejects(() => githubRepo(remote, { env, fetchImpl: offline }), (error) => error instanceof Fail && /Could not reach GitHub: getaddrinfo/.test(error.message));
});

test('readRepo describes the repository, its branches and what is not pushed', () => {
  assert.equal(readRepo(tempDir()), null);

  const fresh = readRepo(makeRepo('demo', {}, { branch: 'develop' }));
  assert.equal(fresh.branch, 'develop');
  assert.equal(fresh.upstream, null);
  assert.equal(fresh.ahead, 0);
  assert.equal(fresh.defaultBranch, null);
  assert.deepEqual(fresh.remote, { type: 'github', owner: 'Acme', repo: 'demo' });

  const ahead = readRepo(makeRepo('demo', {}, { ahead: 3 }));
  assert.equal(ahead.upstream, 'origin/main');
  assert.equal(ahead.ahead, 3);
  assert.equal(readRepo(makeRepo('demo', {}, { pushed: true })).ahead, 0);
  assert.equal(readRepo(makeRepo('demo', {}, { defaultBranch: 'trunk' })).defaultBranch, 'trunk');

  const bare = readRepo(makeRepo('demo', {}, { remote: false }));
  assert.equal(bare.remoteUrl, null);
  assert.equal(bare.remote, null);

  const nested = makeRepo('demo', { 'apps/web/index.html': '<html>' });
  assert.equal(path.basename(readRepo(path.join(nested, 'apps', 'web')).root), path.basename(nested));
});

test('isAuthError tells a rejected sign-in from other failures', () => {
  assert.equal(isAuthError(new ApiError('x', { status: 401 })), true);
  assert.equal(isAuthError(new ApiError('x', { status: 403, codes: [10000] })), true);
  assert.equal(isAuthError(new ApiError('x', { status: 400, codes: [9109] })), true);
  assert.equal(isAuthError(new ApiError('x', { status: 401, codes: [8000012] })), false);
  assert.equal(isAuthError(new ApiError('x', { status: 400, codes: [8000011] })), false);
  assert.equal(isAuthError(new ApiError('x', { status: 404, codes: [8000007] })), false);
  assert.equal(isAuthError(new ApiError('offline')), false);
  assert.equal(isAuthError(new Error('x')), false);
});

test('the API client walks every page of projects', async () => {
  const pages = { 1: [{ name: 'a' }], 2: [{ name: 'b' }], 3: [{ name: 'c' }] };
  const asked = [];
  const client = createClient({
    token: 't',
    fetchImpl: async (url) => {
      const page = Number(url.searchParams.get('page'));
      asked.push(page);
      return reply(200, { success: true, result: pages[page], result_info: { total_pages: 3 } });
    },
  });
  assert.deepEqual((await client.listProjects('acc')).map((p) => p.name), ['a', 'b', 'c']);
  assert.deepEqual(asked, [1, 2, 3]);

  const single = createClient({ token: 't', fetchImpl: async () => reply(200, { success: true, result: [{ name: 'only' }] }) });
  assert.equal((await single.listProjects('acc')).length, 1);

  const runaway = createClient({ token: 't', fetchImpl: async () => reply(200, { success: true, result: [], result_info: { total_pages: 99 } }) });
  assert.deepEqual(await runaway.listProjects('acc'), []);
});

test('the API client follows a truncated build log and reads both line formats', async () => {
  const cursors = [];
  const client = createClient({
    token: 't',
    fetchImpl: async (url) => {
      const cursor = url.searchParams.get('cursor');
      cursors.push(cursor);
      if (!cursor) return reply(200, { success: true, result: { lines: [[1, 'one']], truncated: true, cursor: 'c2' } });
      if (cursor === 'c2') return reply(200, { success: true, result: { lines: ['two', [3]], truncated: true, cursor: 'c3' } });
      return reply(200, { success: true, result: { lines: [[4, 'four']], truncated: true, cursor: 'c3' } });
    },
  });
  assert.deepEqual(await client.buildLogs('acc', 'b1'), [{ line: 'one' }, { line: 'two' }, { line: '' }, { line: 'four' }]);
  assert.deepEqual(cursors, [null, 'c2', 'c3']);

  const empty = createClient({ token: 't', fetchImpl: async () => reply(200, { success: true, result: null }) });
  assert.deepEqual(await empty.buildLogs('acc', 'b1'), []);
});

test('a Worker without a build configuration reads as not connected, other errors surface', async () => {
  const answer = (status, code) => createClient({ token: 't', fetchImpl: async () => reply(status, { success: false, errors: [{ code, message: 'm' }] }) });
  assert.equal(await answer(404, 12040).getWorkerBuildConfig('acc', 'tag'), null);
  assert.equal(await answer(404, 7003).getWorkerBuildConfig('acc', 'tag'), null);
  await assert.rejects(() => answer(500, 1).getWorkerBuildConfig('acc', 'tag'), ApiError);
  await assert.rejects(() => answer(403, 10000).getWorkerBuildConfig('acc', 'tag'), (error) => isAuthError(error));
});

test('the API client shapes its requests the way Cloudflare expects', async () => {
  const seen = [];
  const client = createClient({
    token: 't',
    fetchImpl: async (url, init) => {
      seen.push({ url: String(url), init });
      return reply(200, { success: true, result: { subdomain: 'acme', builds: [{ build_uuid: 'b' }], id: 'x', token: 1 } });
    },
  });

  await client.createPlaceholderWorker('acc', 'my worker');
  assert.equal(seen[0].init.method, 'PUT');
  assert.equal(seen[0].url, 'https://api.cloudflare.com/client/v4/accounts/acc/workers/scripts/my%20worker');
  assert.deepEqual(JSON.parse(seen[0].init.body.get('metadata')), { main_module: 'index.js', compatibility_date: '2025-01-01' });
  assert.equal(seen[0].init.body.get('index.js').type, 'application/javascript+module');
  assert.equal(seen[0].init.headers['Content-Type'], undefined);

  await client.startBuild('acc', 'trg', 'main');
  assert.equal(seen[1].url, 'https://api.cloudflare.com/client/v4/accounts/acc/builds/triggers/trg/builds');
  assert.deepEqual(JSON.parse(seen[1].init.body), { branch: 'main' });

  assert.equal(await client.workersSubdomain('acc'), 'acme');
  assert.deepEqual(await client.listWorkerBuilds('acc', 'tag', 5), [{ build_uuid: 'b' }]);
  assert.match(seen.at(-1).url, /\/builds\/workers\/tag\/builds\?per_page=5$/);

  await client.createDeployment('acc', 'demo');
  assert.equal(seen.at(-1).init.body.get('branch'), null);

  await client.request('GET', '/x', { query: { a: 1, skip: undefined } });
  assert.equal(seen.at(-1).url, 'https://api.cloudflare.com/client/v4/x?a=1');
  assert.equal(seen.at(-1).init.body, undefined);
});

test('the API client explains a reply it cannot read', async () => {
  const html = createClient({
    token: 't',
    fetchImpl: async () => ({
      ok: false,
      status: 502,
      json: async () => {
        throw new SyntaxError('Unexpected token <');
      },
    }),
  });
  await assert.rejects(() => html.listAccounts(), (error) => error instanceof ApiError && error.status === 502 && /Cloudflare answered HTTP 502/.test(error.message));

  const several = createClient({ token: 't', fetchImpl: async () => reply(400, { success: false, errors: [{ code: 1, message: 'first' }, { code: 2, message: 'second' }] }) });
  await assert.rejects(() => several.listAccounts(), (error) => error.message === 'first; second' && error.has(2) && !error.has(3));

  const flagged = createClient({ token: 't', fetchImpl: async () => reply(200, { success: false, errors: [] }) });
  await assert.rejects(() => flagged.listAccounts(), /Cloudflare answered HTTP 200/);
});

test('helper programs are run for real: output, failure, stdin and a missing program', async () => {
  const node = process.execPath;
  assert.equal(await run(node, ['-e', "process.stdout.write('hello')"]), 'hello');
  assert.equal(await run(node, ['-e', 'process.exit(3)']), null);
  assert.equal(await run(node, ['-e', "process.stdin.on('data', (d) => process.stdout.write(String(d).toUpperCase()))"], { input: 'abc' }), 'ABC');
  assert.equal(await run(node, ['-e', 'process.stdout.write(process.env.MARK)'], { env: { ...process.env, MARK: 'from-env' } }), 'from-env');
  assert.equal(await run('flareship-no-such-program-xyz', ['--version']), null);
  assert.equal(await run(undefined, []), null);
});

test('wrangler is launched as a real process and its answers are read back', async () => {
  const dir = writeFiles(tempDir(), {
    'fake-wrangler.js': `
      const args = process.argv.slice(2).join(' ');
      if (args === 'auth token --json') console.log(JSON.stringify({ type: 'oauth', token: process.env.FAKE_TOKEN || '' }));
      else if (args === 'login') process.exit(process.env.FAKE_LOGIN === 'ok' ? 0 : 1);
      else if (args === 'hang') setTimeout(() => {}, 60000);
      else process.exit(2);
    `,
  });
  const command = `"${process.execPath}" "${path.join(dir, 'fake-wrangler.js')}"`;
  const env = (extra) => ({ ...process.env, FLARESHIP_WRANGLER: command, ...extra });

  assert.equal(await wranglerToken(env({ FAKE_TOKEN: 'real-process-token' })), 'real-process-token');
  assert.equal(await wranglerToken(env({ FAKE_TOKEN: '' })), null);
  assert.deepEqual(await wrangler(['unknown'], { env: env({}) }), { status: 2, stdout: '' });
  assert.equal(await wranglerLogin(env({ FAKE_LOGIN: 'ok' })), true);
  assert.equal(await wranglerLogin(env({ FAKE_LOGIN: 'no' })), false);

  const started = Date.now();
  const hung = await wrangler(['hang'], { env: env({}), timeout: 300 });
  assert.deepEqual(hung, { status: 1, stdout: '' });
  assert.ok(Date.now() - started < 5000, 'a hung wrangler must not keep flareship waiting');

  const missing = await wrangler(['auth', 'token', '--json'], { env: env({ FLARESHIP_WRANGLER: 'flareship-no-such-program-xyz' }) });
  assert.notEqual(missing.status, 0);
});

test('the browser is opened with the right program for each system', () => {
  const calls = [];
  const spawnImpl = (command, args, options) => {
    calls.push({ command, args, options });
    return { on() {}, unref() {} };
  };
  const url = 'https://demo.pages.dev';
  openInBrowser(url, { platform: 'win32', release: '10.0', spawnImpl });
  openInBrowser(url, { platform: 'linux', release: '6.6.87.2-microsoft-standard-WSL2', spawnImpl });
  openInBrowser(url, { platform: 'darwin', release: '24.0', spawnImpl });
  openInBrowser(url, { platform: 'linux', release: '6.8.0-generic', spawnImpl });
  assert.deepEqual(calls.map((c) => [c.command, ...c.args]), [
    ['cmd', '/c', 'start', '""', url],
    ['cmd.exe', '/c', 'start', '""', url],
    ['open', url],
    ['xdg-open', url],
  ]);
  assert.ok(calls.every((c) => c.options.detached && c.options.stdio === 'ignore'));

  assert.doesNotThrow(() =>
    openInBrowser(url, {
      platform: 'linux',
      release: 'x',
      spawnImpl: () => {
        throw new Error('no such program');
      },
    }),
  );
});

test('detect survives a broken package.json', () => {
  const dir = writeFiles(tempDir(), { 'package.json': '{ broken', 'public/index.html': '<html>' });
  assert.deepEqual([detect(dir).name, detect(dir).out], ['Static site', 'public']);
});
