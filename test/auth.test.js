import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { ACCOUNT, OTHER_ACCOUNT, createCli, startMock, tempDir } from '../support/mock.js';

const mock = await startMock();
const flareship = createCli(mock);
after(() => mock.close());
beforeEach(() => mock.reset());

const NO_ENV = { CLOUDFLARE_API_TOKEN: '', CLOUDFLARE_ACCOUNT_ID: '' };
const here = os.tmpdir();

function store() {
  const file = path.join(tempDir('flareship-store-'), 'config.json');
  const sessionFile = path.join(path.dirname(file), 'session.json');
  const read = (target) => (fs.existsSync(target) ? JSON.parse(fs.readFileSync(target, 'utf8')) : null);
  return {
    env: { ...NO_ENV, FLARESHIP_CONFIG: file },
    config: () => read(file),
    session: () => read(sessionFile),
    writeConfig: (value) => fs.writeFileSync(file, JSON.stringify(value)),
    writeSession: (value) => fs.writeFileSync(sessionFile, JSON.stringify(value)),
  };
}

function wrangler(...tokens) {
  const calls = { token: 0, login: 0 };
  return {
    calls,
    deps: {
      wranglerToken: async () => {
        calls.token += 1;
        return tokens.length > 1 ? tokens.shift() : tokens[0];
      },
      wranglerLogin: async () => {
        calls.login += 1;
        return true;
      },
    },
  };
}

test('the browser session is fetched once, kept, and fetched again after it expires', async () => {
  const s = store();
  const w = wrangler('good-token');

  assert.equal((await flareship(here, ['list'], { env: s.env, deps: w.deps })).code, 0);
  assert.equal(w.calls.token, 1);
  assert.equal(s.session().token, 'good-token');
  assert.deepEqual(s.config(), { accountId: ACCOUNT });

  assert.equal((await flareship(here, ['list'], { env: s.env, deps: w.deps })).code, 0);
  assert.equal(w.calls.token, 1);

  s.writeSession({ token: 'good-token', savedAt: Date.now() - 51 * 60 * 1000 });
  assert.equal((await flareship(here, ['list'], { env: s.env, deps: w.deps })).code, 0);
  assert.equal(w.calls.token, 2);
});

test('a kept session that Cloudflare rejects is replaced once and the command retried', async () => {
  const s = store();
  s.writeConfig({ accountId: ACCOUNT });
  s.writeSession({ token: 'stale', savedAt: Date.now() });
  const w = wrangler('good-token');

  const { code, output } = await flareship(here, ['whoami'], { env: s.env, deps: w.deps });
  assert.equal(code, 0, output);
  assert.match(output, /Cloudflare browser sign-in/);
  assert.equal(w.calls.token, 1);
  assert.equal(s.session().token, 'good-token');

  s.writeSession({ token: 'stale', savedAt: Date.now() });
  const stuck = await flareship(here, ['list'], { env: s.env, deps: wrangler('stale').deps });
  assert.equal(stuck.code, 1);
  assert.match(stuck.output, /Authentication error/);
});

test('without any sign-in, a script gets a clear error', async () => {
  const w = wrangler(null);
  const plain = await flareship(here, ['list'], { env: NO_ENV, deps: w.deps });
  assert.equal(plain.code, 1);
  assert.match(plain.output, /Not signed in to Cloudflare\. Run "flareship login" or set CLOUDFLARE_API_TOKEN/);
  assert.equal(w.calls.token, 1);

  const off = wrangler('good-token');
  const disabled = await flareship(here, ['list'], { env: { ...NO_ENV, FLARESHIP_NO_WRANGLER: '1' }, deps: off.deps });
  assert.equal(disabled.code, 1);
  assert.match(disabled.output, /Not signed in to Cloudflare/);
  assert.equal(off.calls.token, 0);
});

test('in a terminal, a command signs in through the browser first and then carries on', async () => {
  const s = store();
  const w = wrangler(null, null, 'good-token');
  const { code, output } = await flareship(here, ['list'], { env: s.env, interactive: true, deps: w.deps });

  assert.equal(code, 0, output);
  assert.match(output, /Not signed in to Cloudflare on this machine yet/);
  assert.match(output, /Opening your browser to sign in to Cloudflare/);
  assert.match(output, /Signed in\s+\S+\s+account 0123456789abcdef0123456789abcdef/);
  assert.match(output, /Nothing in this account yet/);
  assert.equal(w.calls.login, 1);
  assert.deepEqual(s.config(), { auth: 'browser', accountId: ACCOUNT });
  assert.equal(s.session().token, 'good-token');
});

test('a browser sign-in that fails or cannot be read back is reported', async () => {
  const refused = await flareship(here, ['login'], { env: NO_ENV, interactive: true, deps: { wranglerToken: async () => null, wranglerLogin: async () => false } });
  assert.equal(refused.code, 1);
  assert.match(refused.output, /The browser sign-in did not finish[\s\S]*flareship login --token/);

  const unreadable = await flareship(here, ['login'], { env: NO_ENV, interactive: true, deps: { wranglerToken: async () => null, wranglerLogin: async () => true } });
  assert.equal(unreadable.code, 1);
  assert.match(unreadable.output, /Signed in, but the session could not be read back/);
});

test('login reuses a wrangler session that already exists', async () => {
  const s = store();
  const w = wrangler('good-token');
  const { code, output } = await flareship(here, ['login'], { env: s.env, interactive: true, deps: w.deps });
  assert.equal(code, 0, output);
  assert.match(output, /Cloudflare is already signed in on this machine/);
  assert.match(output, /Signed in/);
  assert.match(output, /Next: run "flareship import" inside a repository/);
  assert.equal(w.calls.login, 0);
  assert.deepEqual(s.config(), { auth: 'browser', accountId: ACCOUNT });
});

test('login needs a terminal, and the browser sign-in can be turned off', async () => {
  const script = await flareship(here, ['login'], { env: NO_ENV });
  assert.equal(script.code, 1);
  assert.match(script.output, /"flareship login" needs a terminal/);

  const off = await flareship(here, ['login'], { env: { ...NO_ENV, FLARESHIP_NO_WRANGLER: '1' }, interactive: true });
  assert.equal(off.code, 1);
  assert.match(off.output, /Browser sign-in is turned off \(FLARESHIP_NO_WRANGLER\)/);
});

test('login --token saves a token that finds its own account, and later commands use it', async () => {
  const s = store();
  const w = wrangler('should-not-be-used');
  const login = await flareship(here, ['login', '--token'], { env: s.env, interactive: true, answers: ['good-token'], deps: w.deps });

  assert.equal(login.code, 0, login.output);
  assert.deepEqual(login.asked, ['Paste the token (hidden)']);
  assert.match(login.output, /Create Token -> Custom token/);
  assert.match(login.output, /Workers Builds Configuration \| Edit/);
  assert.match(login.output, /The token is valid/);
  assert.match(login.output, /Using account Acme/);
  assert.match(login.output, /Can manage Pages projects/);
  assert.match(login.output, /Can manage Workers builds/);
  assert.match(login.output, /Saved in .*config\.json/);
  assert.deepEqual(s.config(), { token: 'good-token', accountId: ACCOUNT });

  const whoami = await flareship(here, ['whoami'], { env: s.env, deps: w.deps });
  assert.equal(whoami.code, 0, whoami.output);
  assert.match(whoami.output, /Signed in\s+API token saved in .*config\.json/);
  assert.match(whoami.output, /Workers builds\s+available/);
  assert.equal(w.calls.token, 0);
});

test('login --token asks for the account when the token cannot find it', async () => {
  mock.state.accounts = [];
  const s = store();
  const pasted = await flareship(here, ['login', '--token'], {
    env: s.env,
    interactive: true,
    answers: ['good-token', `https://dash.cloudflare.com/${ACCOUNT}/workers-and-pages`],
  });
  assert.equal(pasted.code, 0, pasted.output);
  assert.match(pasted.output, /This token cannot find your account by itself/);
  assert.deepEqual(pasted.asked, ['Paste the token (hidden)', 'Paste that address, or the Account ID']);
  assert.equal(s.config().accountId, ACCOUNT);

  const wrong = await flareship(here, ['login', '--token'], { env: NO_ENV, interactive: true, answers: ['good-token', 'https://dash.cloudflare.com/profile'] });
  assert.equal(wrong.code, 1);
  assert.match(wrong.output, /That does not contain an Account ID/);

  mock.state.accounts = [
    { id: ACCOUNT, name: 'Acme' },
    { id: OTHER_ACCOUNT, name: 'Side project' },
  ];
  const s2 = store();
  const several = await flareship(here, ['login', '--token'], { env: s2.env, interactive: true, answers: ['good-token', OTHER_ACCOUNT] });
  assert.equal(several.code, 0, several.output);
  assert.match(several.output, /Acme[\s\S]*Side project/);
  assert.equal(s2.config().accountId, OTHER_ACCOUNT);

  const fromEnv = await flareship(here, ['login', '--token'], { env: { ...NO_ENV, CLOUDFLARE_ACCOUNT_ID: ACCOUNT }, interactive: true, answers: ['good-token'] });
  assert.equal(fromEnv.code, 0, fromEnv.output);
  assert.deepEqual(fromEnv.asked, ['Paste the token (hidden)']);
});

test('login --token rejects an empty, invalid or useless token', async () => {
  const empty = await flareship(here, ['login', '--token'], { env: NO_ENV, interactive: true, answers: [''] });
  assert.equal(empty.code, 1);
  assert.match(empty.output, /No token entered/);

  const unknown = await flareship(here, ['login', '--token'], { env: NO_ENV, interactive: true, answers: ['typo'] });
  assert.equal(unknown.code, 1);
  assert.match(unknown.output, /Authentication error/);

  mock.state.verifyFails = true;
  const invalid = await flareship(here, ['login', '--token'], { env: NO_ENV, interactive: true, answers: ['good-token'] });
  assert.equal(invalid.code, 1);
  assert.match(invalid.output, /Invalid API Token/);
  mock.state.verifyFails = false;

  mock.state.pagesForbidden = true;
  mock.state.buildsForbidden = true;
  const useless = await flareship(here, ['login', '--token'], { env: NO_ENV, interactive: true, answers: ['good-token'] });
  assert.equal(useless.code, 1);
  assert.match(useless.output, /can manage neither Pages projects nor Workers builds/);
});

test('login --token says which of Pages and Workers the token can manage', async () => {
  mock.state.buildsForbidden = true;
  const pagesOnly = await flareship(here, ['login', '--token'], { env: store().env, interactive: true, answers: ['good-token'] });
  assert.equal(pagesOnly.code, 0, pagesOnly.output);
  assert.match(pagesOnly.output, /Can manage Pages projects/);
  assert.match(pagesOnly.output, /Cannot manage Workers builds/);

  mock.reset();
  mock.state.pagesForbidden = true;
  const workersOnly = await flareship(here, ['login', '--token'], { env: store().env, interactive: true, answers: ['good-token'] });
  assert.equal(workersOnly.code, 0, workersOnly.output);
  assert.match(workersOnly.output, /Cannot manage Pages projects/);
  assert.match(workersOnly.output, /Can manage Workers builds/);
});

test('the account is found automatically, chosen once, or asked for in the environment', async () => {
  const s = store();
  const env = { ...s.env, CLOUDFLARE_API_TOKEN: 'good-token' };
  assert.equal((await flareship(here, ['list'], { env })).code, 0);
  assert.deepEqual(s.config(), { accountId: ACCOUNT });

  mock.state.accounts = [
    { id: ACCOUNT, name: 'Acme' },
    { id: OTHER_ACCOUNT, name: 'Side project' },
  ];
  const script = await flareship(here, ['list'], { env: { ...store().env, CLOUDFLARE_API_TOKEN: 'good-token' } });
  assert.equal(script.code, 1);
  assert.match(script.output, /This token can see several accounts\. Set CLOUDFLARE_ACCOUNT_ID to one of:[\s\S]*Acme[\s\S]*Side project/);

  const yes = await flareship(here, ['list', '--yes'], { env: { ...store().env, CLOUDFLARE_API_TOKEN: 'good-token' }, interactive: true });
  assert.equal(yes.code, 1);

  const s2 = store();
  const chosen = await flareship(here, ['list'], { env: { ...s2.env, CLOUDFLARE_API_TOKEN: 'good-token' }, interactive: true, answers: ['2'] });
  assert.equal(chosen.code, 0, chosen.output);
  assert.deepEqual(chosen.asked, ['Which one']);
  assert.deepEqual(s2.config(), { accountId: OTHER_ACCOUNT });

  const invalid = await flareship(here, ['list'], { env: { ...store().env, CLOUDFLARE_API_TOKEN: 'good-token' }, interactive: true, answers: ['9'] });
  assert.equal(invalid.code, 1);
  assert.match(invalid.output, /That is not one of the listed accounts/);

  mock.state.accounts = [];
  const none = await flareship(here, ['list'], { env: { ...store().env, CLOUDFLARE_API_TOKEN: 'good-token' } });
  assert.equal(none.code, 1);
  assert.match(none.output, /This token cannot list accounts\. Set CLOUDFLARE_ACCOUNT_ID/);
});

test('the environment token wins over a saved one, which wins over the browser', async () => {
  const s = store();
  s.writeConfig({ token: 'saved-but-wrong', accountId: ACCOUNT });
  const w = wrangler('good-token');

  const saved = await flareship(here, ['whoami'], { env: s.env, deps: w.deps });
  assert.equal(saved.code, 1);
  assert.match(saved.output, /Authentication error/);
  assert.equal(w.calls.token, 0);

  const env = await flareship(here, ['whoami'], { env: { ...s.env, CLOUDFLARE_API_TOKEN: 'good-token' }, deps: w.deps });
  assert.equal(env.code, 0, env.output);
  assert.match(env.output, /Signed in\s+CLOUDFLARE_API_TOKEN/);
  assert.equal(w.calls.token, 0);
});

test('whoami reports what the sign-in can reach', async () => {
  mock.state.projects.push({ name: 'one', subdomain: 'one.pages.dev' });
  mock.state.scripts.push({ id: 'a', tag: 'tag-a' }, { id: 'b', tag: 'tag-b' });

  const full = await flareship(here, ['whoami']);
  assert.equal(full.code, 0, full.output);
  assert.match(full.output, /Signed in\s+CLOUDFLARE_API_TOKEN/);
  assert.match(full.output, new RegExp(`Account\\s+${ACCOUNT}`));
  assert.match(full.output, /Pages\s+1 project\n/);
  assert.match(full.output, /Workers\s+2 Workers\n/);
  assert.match(full.output, /Workers builds\s+available/);

  const browser = await flareship(here, ['whoami'], { env: { CLOUDFLARE_API_TOKEN: '' }, deps: wrangler('good-token').deps });
  assert.match(browser.output, /Signed in\s+Cloudflare browser sign-in \(wrangler\)/);
  assert.match(browser.output, /Workers builds\s+needs an API token: flareship login --token/);

  mock.state.buildsForbidden = true;
  mock.state.pagesForbidden = true;
  const limited = await flareship(here, ['whoami']);
  assert.match(limited.output, /Pages\s+no access/);
  assert.match(limited.output, /Workers builds\s+no access with this token/);
});

test('a token without Pages access can still list Workers', async () => {
  mock.state.pagesForbidden = true;
  mock.state.scripts.push({ id: 'edge-api', tag: 'tag-edge-api' });
  const { code, output } = await flareship(here, ['list']);
  assert.equal(code, 0, output);
  assert.match(output, /edge-api\s+Worker/);
  assert.match(output, /0 Pages projects \S+ 1 Worker\n/);
});

test('logout removes the saved account and session', async () => {
  const s = store();
  s.writeConfig({ token: 'good-token', accountId: ACCOUNT });
  s.writeSession({ token: 'good-token', savedAt: Date.now() });

  const first = await flareship(here, ['logout'], { env: s.env });
  assert.equal(first.code, 0);
  assert.match(first.output, /Removed .*config\.json/);
  assert.match(first.output, /npx wrangler logout/);
  assert.equal(s.config(), null);
  assert.equal(s.session(), null);

  const second = await flareship(here, ['logout'], { env: s.env });
  assert.equal(second.code, 0);
  assert.match(second.output, /Nothing was saved/);
});
