import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { run } from '../src/cli.js';

const ACCOUNT = 'acc123';
const state = { projects: [], requests: [], polls: 0, denyRepo: 'locked', scripts: [], workerConfigs: {}, buildPolls: 0 };
let server;
let base;

function body(request) {
  return new Promise((resolve) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

const stage = (name, status) => ({ name, status });

function deployment(done) {
  return {
    id: 'dep-0001-full',
    short_id: 'dep-0001',
    environment: 'production',
    url: 'https://dep-0001.demo-site.pages.dev',
    created_on: new Date().toISOString(),
    deployment_trigger: { type: 'ad_hoc', metadata: { branch: 'main', commit_hash: 'abcdef1234567' } },
    stages: done ? [stage('build', 'success'), stage('deploy', 'success')] : [stage('build', 'active')],
    latest_stage: done ? stage('deploy', 'success') : stage('build', 'active'),
  };
}

before(async () => {
  server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const text = await body(request);
    state.requests.push({ method: request.method, path: url.pathname, auth: request.headers.authorization, text });
    const send = (status, json) => {
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(json));
    };
    const prefix = `/v4/accounts/${ACCOUNT}/pages/projects`;

    if (url.pathname === '/github/repos/Acme/edge-api') {
      return send(200, { id: 777, name: 'edge-api', owner: { id: 42, login: 'Acme' } });
    }
    if (request.headers.authorization !== 'Bearer good-token') {
      return send(403, { success: false, errors: [{ code: 10000, message: 'Authentication error' }] });
    }
    if (request.method === 'GET' && url.pathname === prefix) return send(200, { success: true, result: state.projects, result_info: { total_pages: 1 } });
    if (request.method === 'POST' && url.pathname === prefix) {
      const wanted = JSON.parse(text);
      if (wanted.source.config.repo_name === state.denyRepo) {
        return send(400, { success: false, errors: [{ code: 8000011, message: 'There is an internal issue with your Cloudflare Pages Git installation.' }] });
      }
      const created = { ...wanted, subdomain: `${wanted.name}.pages.dev`, domains: [`${wanted.name}.pages.dev`] };
      state.projects.push(created);
      return send(200, { success: true, result: created });
    }
    if (request.method === 'POST' && url.pathname === `${prefix}/demo-site/deployments`) {
      state.polls = 0;
      return send(200, { success: true, result: deployment(false) });
    }
    if (request.method === 'GET' && url.pathname === `${prefix}/demo-site/deployments`) return send(200, { success: true, result: [deployment(true)] });
    if (request.method === 'GET' && url.pathname === `${prefix}/demo-site/deployments/dep-0001-full`) {
      state.polls += 1;
      return send(200, { success: true, result: deployment(state.polls >= 2) });
    }
    if (request.method === 'GET' && url.pathname.endsWith('/history/logs')) {
      const lines = ['Cloning repository...', 'Running build command', 'Success: Your site was deployed!'];
      return send(200, { success: true, result: { data: lines.slice(0, state.polls + 1).map((line) => ({ line })) } });
    }
    const account = `/v4/accounts/${ACCOUNT}`;
    const route = `${request.method} ${url.pathname.slice(account.length)}`;
    const build = (done) => ({
      build_uuid: 'bld00001-full',
      status: done ? 'stopped' : 'running',
      build_outcome: done ? 'success' : null,
      created_on: new Date().toISOString(),
      build_trigger_metadata: { branch: 'main', commit_hash: 'fedcba9876543', commit_message: 'Add the edge API', build_trigger_source: 'push' },
    });
    if (route === 'GET /workers/scripts') return send(200, { success: true, result: state.scripts });
    if (route === 'GET /workers/subdomain') return send(200, { success: true, result: { subdomain: 'acme' } });
    if (route === 'PUT /workers/scripts/edge-api') {
      state.scripts.push({ id: 'edge-api', tag: 'tag-edge-api' });
      return send(200, { success: true, result: { id: 'edge-api' } });
    }
    if (route === 'GET /builds/tokens') return send(200, { success: true, result: [{ build_token_uuid: 'bt-1', build_token_name: 'main build token' }] });
    if (route === 'GET /builds/workers/tag-edge-api') {
      const config = state.workerConfigs['tag-edge-api'];
      if (!config) return send(404, { success: false, errors: [{ code: 12040, message: 'No build configuration associated with that script tag' }] });
      return send(200, { success: true, result: config });
    }
    if (route === 'POST /builds/workers') {
      const wanted = JSON.parse(text);
      state.workerConfigs[wanted.script_tag] = wanted;
      return send(200, { success: true, result: wanted });
    }
    if (route === 'GET /builds/workers/tag-edge-api/triggers') {
      const config = state.workerConfigs['tag-edge-api'];
      const triggers = config ? [{ trigger_uuid: 'trg-1', branch_includes: [config.git_repository.branch], branch_excludes: [], deleted_on: null }] : [];
      return send(200, { success: true, result: triggers });
    }
    if (route === 'POST /builds/triggers/trg-1/builds') {
      state.buildPolls = 0;
      return send(200, { success: true, result: build(false) });
    }
    if (route === 'GET /builds/builds/bld00001-full') {
      state.buildPolls += 1;
      return send(200, { success: true, result: build(state.buildPolls >= 2) });
    }
    if (route === 'GET /builds/builds/bld00001-full/logs') {
      const lines = ['Cloning repository', 'Running: npm run build', 'Deployed edge-api'];
      return send(200, { success: true, result: { cursor: 'c1', truncated: false, lines: lines.slice(0, state.buildPolls + 1).map((line) => [Date.now(), line]) } });
    }
    if (route === 'GET /builds/workers/tag-edge-api/builds') return send(200, { success: true, result: [build(true)] });
    return send(404, { success: false, errors: [{ code: 7003, message: `No route for ${request.method} ${url.pathname}` }] });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}/v4`;
});

after(() => new Promise((resolve) => server.close(resolve)));

function repo(name, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flareship-flow-'));
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), content);
  }
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['remote', 'add', 'origin', `https://github.com/Acme/${name}.git`], { cwd: dir });
  return dir;
}

async function flareship(cwd, argv, extraEnv = {}) {
  const lines = [];
  const env = {
    CLOUDFLARE_API_TOKEN: 'good-token',
    CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
    FLARESHIP_API_BASE: base,
    FLARESHIP_POLL_MS: '5',
    FLARESHIP_CONFIG: path.join(os.tmpdir(), 'flareship-test-missing-config.json'),
    FLARESHIP_NO_BROWSER: '1',
    FLARESHIP_NO_WRANGLER: '1',
    FLARESHIP_NO_GIT_CREDENTIALS: '1',
    FLARESHIP_GITHUB_API: `${base.replace(/\/v4$/, '')}/github`,
    ...extraEnv,
  };
  const code = await run(argv, { cwd, env, interactive: false, log: (line) => lines.push(String(line)), err: (line) => lines.push(String(line)) });
  return { code, output: lines.join('\n') };
}

test('import creates a connected project, builds it and reports the live address', async () => {
  const dir = repo('Demo_Site', { 'package.json': JSON.stringify({ scripts: { build: 'vite build' }, devDependencies: { vite: '5' } }) });
  const { code, output } = await flareship(dir, ['import', '--yes']);

  assert.equal(code, 0, output);
  assert.match(output, /1\/4\s+Repository/);
  assert.match(output, /4\/4\s+Create and publish/);
  assert.match(output, /Detected Vite/);
  assert.match(output, /Success: Your site was deployed!/);
  assert.match(output, /Live at https:\/\/demo-site\.pages\.dev/);

  const created = JSON.parse(state.requests.find((r) => r.method === 'POST' && r.path.endsWith('/pages/projects')).text);
  assert.deepEqual(created.build_config, { build_command: 'npm run build', destination_dir: 'dist', root_dir: '' });
  assert.equal(created.name, 'demo-site');
  assert.equal(created.production_branch, 'main');
  assert.deepEqual(created.source, {
    type: 'github',
    config: {
      owner: 'Acme',
      repo_name: 'Demo_Site',
      production_branch: 'main',
      pr_comments_enabled: true,
      deployments_enabled: true,
      production_deployments_enabled: true,
      preview_deployment_setting: 'all',
    },
  });
});

test('import does not create a second project for a repository that is already connected', async () => {
  const dir = repo('Demo_Site', { 'index.html': '<html>' });
  const before = state.projects.length;
  const { code, output } = await flareship(dir, ['import', '--yes']);
  assert.equal(code, 0, output);
  assert.match(output, /already connected/);
  assert.equal(state.projects.length, before);
});

test('status, logs and open work on the connected project', async () => {
  const dir = repo('demo_site', { 'index.html': '<html>' });
  const status = await flareship(dir, ['status']);
  assert.equal(status.code, 0, status.output);
  assert.match(status.output, /demo-site\s+Pages\s+\S+ live\n\s+https:\/\/demo-site\.pages\.dev/);
  assert.match(status.output, /npm run build/);
  assert.match(status.output, /abcdef1/);

  const logs = await flareship(dir, ['logs']);
  assert.equal(logs.code, 0, logs.output);
  assert.match(logs.output, /Cloning repository/);

  const open = await flareship(dir, ['open']);
  assert.equal(open.output.trim(), 'https://demo-site.pages.dev');
});

test('import explains what to do when Cloudflare cannot read the repository', async () => {
  const dir = repo('locked', { 'public/index.html': '<html>' });
  const { code, output } = await flareship(dir, ['import', '--yes']);
  assert.equal(code, 1);
  assert.match(output, /Cloudflare has no access to github\.com\/Acme\/locked/);
  assert.match(output, /github\.com\/settings\/installations/);
  assert.match(output, new RegExp(`dash\\.cloudflare\\.com/${ACCOUNT}/workers-and-pages/create/pages`));
});

test('import refuses to guess when it cannot detect the build and nobody can be asked', async () => {
  const dir = repo('mystery', { 'main.rs': 'fn main() {}' });
  const guess = await flareship(dir, ['import', '--yes']);
  assert.equal(guess.code, 1);
  assert.match(guess.output, /Pass --build/);

  const explicit = await flareship(dir, ['import', '--yes', '--build', 'none', '--out', 'web', '--name', 'Mystery Web', '--no-previews']);
  assert.equal(explicit.code, 1, 'the mock has no deployment route for this project, so the first build cannot start');
  assert.match(explicit.output, /Created mystery-web/);
  assert.match(explicit.output, /first build could not be started/);
  const created = state.projects.find((p) => p.name === 'mystery-web');
  assert.deepEqual(created.build_config, { build_command: '', destination_dir: 'web', root_dir: '' });
  assert.equal(created.source.config.preview_deployment_setting, 'none');
});

test('clear errors for a bad token, a missing token and a folder that is not a repository', async () => {
  const dir = repo('demo_site', { 'index.html': '<html>' });
  const bad = await flareship(dir, ['status'], { CLOUDFLARE_API_TOKEN: 'wrong' });
  assert.equal(bad.code, 1);
  assert.match(bad.output, /Authentication error/);

  const missing = await flareship(dir, ['status'], { CLOUDFLARE_API_TOKEN: '' });
  assert.equal(missing.code, 1);
  assert.match(missing.output, /flareship login/);

  const outside = await flareship(fs.mkdtempSync(path.join(os.tmpdir(), 'flareship-plain-')), ['import', '--yes']);
  assert.equal(outside.code, 1);
  assert.match(outside.output, /not inside a Git repository/);
});

test('help and guide print without touching the network', async () => {
  const count = state.requests.length;
  const help = await flareship(os.tmpdir(), []);
  assert.match(help.output, /flareship import/);
  const guide = await flareship(os.tmpdir(), ['guide']);
  assert.match(guide.output, /flareship login/);
  assert.match(guide.output, /workers-and-pages\/create\/pages/);
  assert.match(guide.output, /github\.com\/settings\/installations/);
  assert.equal(state.requests.length, count);
});

const WRANGLER_JSONC = `{
  // the Worker's name must match the one on Cloudflare
  "name": "edge-api",
  "main": "src/index.js", /* entry */
  "compatibility_date": "2025-01-01",
}
`;

function workerRepo() {
  return repo('edge-api', {
    'wrangler.jsonc': WRANGLER_JSONC,
    'package.json': JSON.stringify({ scripts: { build: 'node build.js' } }),
  });
}

test('import connects a repository with a wrangler config as a Worker', async () => {
  const dir = workerRepo();
  const { code, output } = await flareship(dir, ['import', '--yes']);

  assert.equal(code, 0, output);
  assert.match(output, /Worker edge-api/);
  assert.match(output, /Created the Worker edge-api/);
  assert.match(output, /Connected edge-api to github\.com\/Acme\/edge-api/);
  assert.match(output, /Deployed edge-api/);
  assert.match(output, /Live at https:\/\/edge-api\.acme\.workers\.dev/);

  const settings = (deploy) => ({
    build_command: 'npm run build',
    deploy_command: deploy,
    root_directory: '/',
    build_caching_enabled: true,
    path_includes: ['*'],
    path_excludes: [],
    build_token_uuid: 'bt-1',
  });
  assert.deepEqual(state.workerConfigs['tag-edge-api'], {
    script_tag: 'tag-edge-api',
    git_repository: { provider_type: 'github', provider_account_id: '42', provider_account_name: 'Acme', repo_id: '777', repo_name: 'edge-api', branch: 'main' },
    production_settings: settings('npx wrangler deploy'),
    previews_enabled: true,
    previews_base_config: settings('npx wrangler preview'),
  });
  assert.equal(state.requests.filter((r) => r.path.endsWith('/pages/projects') && r.method === 'POST' && r.text.includes('edge-api')).length, 0);
});

test('a connected Worker is not imported twice, and status, logs, deploy and open work on it', async () => {
  const dir = workerRepo();
  const again = await flareship(dir, ['import', '--yes']);
  assert.equal(again.code, 0, again.output);
  assert.match(again.output, /edge-api is already connected/);
  assert.equal(state.scripts.length, 1);

  const status = await flareship(dir, ['status']);
  assert.equal(status.code, 0, status.output);
  assert.match(status.output, /edge-api\s+Worker\s+\S+ live\n\s+https:\/\/edge-api\.acme\.workers\.dev/);
  assert.match(status.output, /github\.com\/Acme\/edge-api/);
  assert.match(status.output, /npx wrangler deploy/);
  assert.match(status.output, /bld00001\s+production\s+main\s+fedcba9\s+Add the edge API/);

  const logs = await flareship(dir, ['logs', 'bld00001']);
  assert.equal(logs.code, 0, logs.output);
  assert.match(logs.output, /Running: npm run build/);

  const deploy = await flareship(dir, ['deploy']);
  assert.equal(deploy.code, 0, deploy.output);
  assert.match(deploy.output, /Building edge-api from main/);
  assert.match(deploy.output, /Live at https:\/\/edge-api\.acme\.workers\.dev/);

  const open = await flareship(dir, ['open']);
  assert.equal(open.output.trim(), 'https://edge-api.acme.workers.dev');

  const byName = await flareship(os.tmpdir(), ['status', '--name', 'edge-api']);
  assert.equal(byName.code, 0, byName.output);
  assert.match(byName.output, /edge-api\s+Worker/);
});

test('list shows Pages projects and Workers together', async () => {
  const { code, output } = await flareship(os.tmpdir(), ['list']);
  assert.equal(code, 0, output);
  assert.match(output, /demo-site\s+Pages\s+https:\/\/demo-site\.pages\.dev\s+github\.com\/Acme\/Demo_Site/);
  assert.match(output, /edge-api\s+Worker\s+https:\/\/edge-api\.acme\.workers\.dev\s+github\.com\/Acme\/edge-api/);
});

test('importing a Worker needs a wrangler config, and --pages overrides the choice', async () => {
  const plain = repo('plain-site', { 'public/index.html': '<html>' });
  const forced = await flareship(plain, ['import', '--yes', '--workers']);
  assert.equal(forced.code, 1);
  assert.match(forced.output, /needs a wrangler configuration file/);

  const both = await flareship(plain, ['import', '--workers', '--pages']);
  assert.equal(both.code, 1);
  assert.match(both.output, /not both/);
});
