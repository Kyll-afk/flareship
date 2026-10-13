import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { run } from '../src/cli.js';

const ACCOUNT = 'acc123';
const state = { projects: [], requests: [], polls: 0, denyRepo: 'locked' };
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
  assert.match(status.output, /demo-site\s+\S+ live\n\s+https:\/\/demo-site\.pages\.dev/);
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
