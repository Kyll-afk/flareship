import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ApiError, createClient } from '../src/api.js';
import { parseArgs } from '../src/cli.js';
import { cleanFolder, deploymentState, extractAccountId, findProjectForRepo, sanitizeName } from '../src/commands.js';
import { detect } from '../src/detect.js';
import { Fail } from '../src/errors.js';
import { parseRemote } from '../src/git.js';
import { ago } from '../src/ui.js';

function project(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flareship-detect-'));
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), typeof content === 'string' ? content : JSON.stringify(content));
  }
  return dir;
}

test('parseRemote reads the common GitHub and GitLab forms', () => {
  const want = { type: 'github', owner: 'Kyll-afk', repo: 'ziffy-site' };
  assert.deepEqual(parseRemote('https://github.com/Kyll-afk/ziffy-site.git'), want);
  assert.deepEqual(parseRemote('https://github.com/Kyll-afk/ziffy-site'), want);
  assert.deepEqual(parseRemote('https://user@github.com/Kyll-afk/ziffy-site.git/'), want);
  assert.deepEqual(parseRemote('git@github.com:Kyll-afk/ziffy-site.git'), want);
  assert.deepEqual(parseRemote('ssh://git@github.com/Kyll-afk/ziffy-site.git'), want);
  assert.deepEqual(parseRemote('git@gitlab.com:team/sub/app.git'), { type: 'gitlab', owner: 'team/sub', repo: 'app' });
});

test('parseRemote rejects hosts Pages cannot connect to', () => {
  assert.equal(parseRemote('https://bitbucket.org/a/b.git'), null);
  assert.equal(parseRemote('https://github.com/only-owner'), null);
  assert.equal(parseRemote('https://github.com/a/b/c'), null);
  assert.equal(parseRemote(''), null);
  assert.equal(parseRemote(null), null);
});

test('sanitizeName produces a valid Pages project name', () => {
  assert.equal(sanitizeName('Ziffy_Site'), 'ziffy-site');
  assert.equal(sanitizeName('--My App!!--'), 'my-app');
  assert.equal(sanitizeName('___'), 'site');
  assert.equal(sanitizeName('a'.repeat(80)).length, 58);
  assert.equal(sanitizeName(`${'a'.repeat(57)}-b`), 'a'.repeat(57));
});

test('extractAccountId accepts a bare ID or any dashboard address', () => {
  const id = '2824bd06346d60f4326fddc0142d811c';
  assert.equal(extractAccountId(id), id);
  assert.equal(extractAccountId(`  ${id.toUpperCase()}  `), id);
  assert.equal(extractAccountId(`https://dash.cloudflare.com/${id}/workers-and-pages`), id);
  assert.equal(extractAccountId(`https://dash.cloudflare.com/${id}/pages/view/ziffy-site?tab=settings`), id);
  assert.equal(extractAccountId('https://dash.cloudflare.com/profile/api-tokens'), null);
  assert.equal(extractAccountId(`${id}0`), null);
  assert.equal(extractAccountId(''), null);
});

test('cleanFolder normalises the publish folder', () => {
  assert.equal(cleanFolder('./dist/'), 'dist');
  assert.equal(cleanFolder('.'), '');
  assert.equal(cleanFolder('build\\client'), 'build/client');
  assert.equal(cleanFolder(undefined), '');
});

test('findProjectForRepo matches owner and repository without caring about case', () => {
  const projects = [
    { name: 'upload-only', source: null },
    { name: 'other', source: { type: 'github', config: { owner: 'kyll-afk', repo_name: 'other' } } },
    { name: 'ziffy-site', source: { type: 'github', config: { owner: 'Kyll-afk', repo_name: 'ziffy-site' } } },
  ];
  assert.equal(findProjectForRepo(projects, { type: 'github', owner: 'kyll-AFK', repo: 'Ziffy-Site' }).name, 'ziffy-site');
  assert.equal(findProjectForRepo(projects, { type: 'gitlab', owner: 'Kyll-afk', repo: 'ziffy-site' }), null);
  assert.equal(findProjectForRepo(projects, { type: 'github', owner: 'Kyll-afk', repo: 'missing' }), null);
});

test('deploymentState follows the build stages', () => {
  const stage = (name, status) => ({ name, status });
  assert.equal(deploymentState({ stages: [stage('queued', 'success'), stage('build', 'active')], latest_stage: stage('build', 'active') }), 'running');
  assert.equal(deploymentState({ stages: [stage('build', 'failure')], latest_stage: stage('build', 'failure') }), 'failure');
  assert.equal(deploymentState({ stages: [stage('build', 'canceled')], latest_stage: stage('build', 'canceled') }), 'canceled');
  assert.equal(deploymentState({ stages: [stage('build', 'success'), stage('deploy', 'success')], latest_stage: stage('deploy', 'success') }), 'success');
  assert.equal(deploymentState({ latest_stage: stage('build', 'success') }), 'running');
});

test('detect recognises frameworks and package managers', () => {
  const vite = detect(project({ 'package.json': { scripts: { build: 'vite build' }, devDependencies: { vite: '5' } }, 'pnpm-lock.yaml': '' }));
  assert.deepEqual([vite.name, vite.build, vite.out, vite.confident], ['Vite', 'pnpm run build', 'dist', true]);

  const kit = detect(project({ 'package.json': { scripts: { build: 'vite build' }, devDependencies: { vite: '5', '@sveltejs/kit': '2' } } }));
  assert.deepEqual([kit.name, kit.build, kit.out], ['SvelteKit', 'npm run build', '.svelte-kit/cloudflare']);

  const next = detect(project({ 'package.json': { scripts: { build: 'next build' }, dependencies: { next: '15' } }, 'yarn.lock': '' }));
  assert.deepEqual([next.name, next.build, next.out, next.confident], ['Next.js', 'yarn build', 'out', false]);

  const eleventy = detect(project({ 'package.json': { devDependencies: { '@11ty/eleventy': '3' } } }));
  assert.deepEqual([eleventy.build, eleventy.out, eleventy.confident], ['npx @11ty/eleventy', '_site', true]);

  const plain = detect(project({ 'package.json': { scripts: { build: 'node build.js' } } }));
  assert.deepEqual([plain.name, plain.build, plain.out, plain.confident], ['Node project', 'npm run build', 'dist', false]);
});

test('detect handles generators, static sites and unknown projects', () => {
  assert.deepEqual(pick(detect(project({ 'hugo.toml': '' }))), ['Hugo', 'hugo', 'public']);
  assert.deepEqual(pick(detect(project({ '_config.yml': '' }))), ['Jekyll', 'jekyll build', '_site']);
  assert.deepEqual(pick(detect(project({ 'mkdocs.yml': '' }))), ['MkDocs', 'mkdocs build', 'site']);

  const root = detect(project({ 'index.html': '<html>', 'tools/dist.py': '' }));
  assert.deepEqual(pick(root), ['Static site', '', '']);
  assert.equal(root.confident, false);
  assert.match(root.note, /whole repository/);

  assert.deepEqual(pick(detect(project({ 'public/index.html': '<html>' }))), ['Static site', '', 'public']);
  assert.deepEqual(pick(detect(project({ 'main.rs': '' }))), [null, null, null]);
});

function pick(found) {
  return [found.name, found.build, found.out];
}

test('parseArgs separates the command, its arguments and the options', () => {
  assert.deepEqual(parseArgs(['import', '--name', 'x', '--build=npm run build', '--out', 'dist', '-y', '--no-previews']), {
    command: 'import',
    args: [],
    flags: { name: 'x', build: 'npm run build', out: 'dist', yes: true, 'no-previews': true },
  });
  assert.deepEqual(parseArgs(['logs', 'abc123', '-f']), { command: 'logs', args: ['abc123'], flags: { follow: true } });
  assert.deepEqual(parseArgs([]), { command: undefined, args: [], flags: {} });
  assert.deepEqual(parseArgs(['import', '--build', '']).flags, { build: '' });
  assert.throws(() => parseArgs(['import', '--nope']), Fail);
  assert.throws(() => parseArgs(['import', '-x']), Fail);
  assert.throws(() => parseArgs(['import', '--name']), Fail);
});

test('ago prints short relative times', () => {
  const now = Date.parse('2026-10-13T12:00:00Z');
  assert.equal(ago('2026-10-13T11:59:50Z', now), 'just now');
  assert.equal(ago('2026-10-13T11:55:00Z', now), '5m ago');
  assert.equal(ago('2026-10-13T09:00:00Z', now), '3h ago');
  assert.equal(ago('2026-10-11T12:00:00Z', now), '2d ago');
});

test('the API client sends the token and turns Cloudflare errors into ApiError', async () => {
  const seen = [];
  const reply = (status, body) => ({ ok: status < 400, status, json: async () => body });
  const fetchImpl = async (url, init) => {
    seen.push({ url: String(url), init });
    if (String(url).includes('/pages/projects/demo/deployments')) return reply(200, { success: true, result: { id: 'd1' } });
    return reply(400, { success: false, errors: [{ code: 8000011, message: 'no git installation' }] });
  };
  const client = createClient({ token: 'secret', base: 'https://api.test/v4/', fetchImpl });

  const deployment = await client.createDeployment('acc', 'demo', 'main');
  assert.equal(deployment.id, 'd1');
  assert.equal(seen[0].url, 'https://api.test/v4/accounts/acc/pages/projects/demo/deployments');
  assert.equal(seen[0].init.method, 'POST');
  assert.equal(seen[0].init.headers.Authorization, 'Bearer secret');
  assert.equal(seen[0].init.body.get('branch'), 'main');

  await assert.rejects(
    () => client.createProject('acc', { name: 'demo' }),
    (error) => error instanceof ApiError && error.has(8000011) && error.status === 400 && /no git installation/.test(error.message),
  );
  assert.equal(seen[1].init.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(seen[1].init.body), { name: 'demo' });
});

test('the API client reports network failures as ApiError', async () => {
  const client = createClient({
    token: 't',
    fetchImpl: async () => {
      throw new Error('getaddrinfo ENOTFOUND');
    },
  });
  await assert.rejects(() => client.listAccounts(), (error) => error instanceof ApiError && /Could not reach Cloudflare/.test(error.message));
});

test('the API client fetches a fresh token once when the cached one is rejected', async () => {
  const used = [];
  let refreshes = 0;
  const fetchImpl = async (url, init) => {
    used.push(init.headers.Authorization);
    if (init.headers.Authorization === 'Bearer stale') {
      return { ok: false, status: 403, json: async () => ({ success: false, errors: [{ code: 10000, message: 'Authentication error' }] }) };
    }
    return { ok: true, status: 200, json: async () => ({ success: true, result: [{ id: 'a', name: 'A' }] }) };
  };
  const refresh = async () => {
    refreshes += 1;
    return 'fresh';
  };
  const client = createClient({ token: 'stale', refresh, fetchImpl });
  assert.deepEqual(await client.listAccounts(), [{ id: 'a', name: 'A' }]);
  assert.deepEqual(await client.listAccounts(), [{ id: 'a', name: 'A' }]);
  assert.deepEqual(used, ['Bearer stale', 'Bearer fresh', 'Bearer fresh']);
  assert.equal(refreshes, 1);

  const stuck = createClient({ token: 'stale', refresh: async () => 'stale', fetchImpl });
  await assert.rejects(() => stuck.listAccounts(), /Authentication error/);
});
