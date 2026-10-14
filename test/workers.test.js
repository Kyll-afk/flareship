import assert from 'node:assert/strict';
import os from 'node:os';
import { after, beforeEach, test } from 'node:test';
import { createCli, makeRepo, startMock, tempDir } from '../support/mock.js';

const mock = await startMock();
const flareship = createCli(mock);
after(() => mock.close());
beforeEach(() => mock.reset());

const WRANGLER_JSONC = `{
  // the Worker's name must match the one on Cloudflare
  "name": "edge-api",
  "main": "src/index.js", /* entry */
  "compatibility_date": "2025-01-01",
}
`;
const FILES = { 'wrangler.jsonc': WRANGLER_JSONC, 'package.json': { scripts: { build: 'node build.js' } } };
const workerRepo = (options) => makeRepo('edge-api', FILES, options);
const browser = { env: { CLOUDFLARE_API_TOKEN: '' }, deps: { wranglerToken: async () => 'good-token' } };

const settings = (deploy, overrides = {}) => ({
  build_command: 'npm run build',
  deploy_command: deploy,
  root_directory: '/',
  build_caching_enabled: true,
  path_includes: ['*'],
  path_excludes: [],
  build_token_uuid: 'bt-1',
  ...overrides,
});

function seedWorker(name = 'edge-api', { connected = true, branch = 'main', previews = true } = {}) {
  const script = { id: name, tag: `tag-${name}` };
  mock.state.scripts.push(script);
  if (connected) {
    mock.state.workerConfigs[script.tag] = {
      script_tag: script.tag,
      git_repository: { provider_type: 'github', provider_account_id: '42', provider_account_name: 'Acme', repo_id: '777', repo_name: name, branch },
      production_settings: settings('npx wrangler deploy'),
      previews_enabled: previews,
      previews_base_config: settings('npx wrangler preview'),
    };
  }
  return script;
}

function seedBuild(tag, { branch = 'main', outcome = 'success', polls = 5, message = 'Add the edge API', source = 'push' } = {}) {
  const n = ++mock.state.counter;
  const build = { id: `bld${String(n).padStart(5, '0')}-full`, tag, script: tag.replace(/^tag-/, ''), branch, preview: false, commit: 'fedcba9876543', message, source, outcome, polls, created_on: new Date().toISOString() };
  mock.state.builds.unshift(build);
  return build;
}

test('import connects a repository with a wrangler config as a Worker, creating the Worker', async () => {
  const { code, output } = await flareship(workerRepo(), ['import', '--yes']);

  assert.equal(code, 0, output);
  assert.match(output, /3\/4\s+Build settings\n\s+Worker edge-api\s+\S+\s+from wrangler\.jsonc/);
  assert.match(output, /Worker\s+edge-api\s+\S+\s+will be created/);
  assert.match(output, /Deploy\s+npx wrangler deploy/);
  assert.match(output, /Build token\s+main build token/);
  assert.match(output, /Created the Worker edge-api/);
  assert.match(output, /Connected edge-api to github\.com\/Acme\/edge-api/);
  assert.match(output, /Every push to main now publishes to https:\/\/edge-api\.acme\.workers\.dev/);
  assert.match(output, /Deployed edge-api/);
  assert.match(output, /Live at https:\/\/edge-api\.acme\.workers\.dev/);

  assert.deepEqual(mock.state.workerConfigs['tag-edge-api'], {
    script_tag: 'tag-edge-api',
    git_repository: { provider_type: 'github', provider_account_id: '42', provider_account_name: 'Acme', repo_id: '777', repo_name: 'edge-api', branch: 'main' },
    production_settings: settings('npx wrangler deploy'),
    previews_enabled: true,
    previews_base_config: settings('npx wrangler preview'),
  });
  const upload = mock.state.requests.find((r) => r.method === 'PUT' && r.path.endsWith('/workers/scripts/edge-api'));
  assert.match(upload.text, /main_module/);
  assert.equal(mock.state.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/pages/projects')).length, 0);
});

test('an existing Worker is connected without being recreated', async () => {
  seedWorker('edge-api', { connected: false });
  const { code, output } = await flareship(workerRepo(), ['import', '--yes']);
  assert.equal(code, 0, output);
  assert.doesNotMatch(output, /will be created|Created the Worker/);
  assert.match(output, /Connected edge-api/);
  assert.equal(mock.state.scripts.length, 1);
  assert.equal(mock.state.requests.filter((r) => r.method === 'PUT').length, 0);
});

test('import options shape the Worker build settings', async () => {
  const dir = makeRepo('edge-api', { 'apps/api/wrangler.toml': 'name = "edge-api"\nmain = "index.js"\n' });
  const { code, output } = await flareship(dir, ['import', '--yes', '--root', 'apps/api', '--branch', 'release', '--build', 'make', '--no-previews', '--out', 'dist']);
  assert.equal(code, 0, output);
  assert.match(output, /from wrangler\.toml/);
  assert.match(output, /--out is ignored for Workers/);
  assert.match(output, /Root\s+apps\/api/);
  const config = mock.state.workerConfigs['tag-edge-api'];
  assert.equal(config.git_repository.branch, 'release');
  assert.equal(config.previews_enabled, false);
  assert.deepEqual(config.production_settings, settings('npx wrangler deploy', { build_command: 'make', root_directory: '/apps/api' }));
});

test('a Worker without a build script gets an empty build command', async () => {
  const dir = makeRepo('edge-api', { 'wrangler.json': { name: 'edge-api' } });
  const { code, output } = await flareship(dir, ['import', '--yes']);
  assert.equal(code, 0, output);
  assert.match(output, /Build\s+none/);
  assert.equal(mock.state.workerConfigs['tag-edge-api'].production_settings.build_command, '');
});

test('import asks for the Worker settings and can be declined', async () => {
  const accepted = await flareship(workerRepo(), ['import'], { interactive: true, answers: ['develop', 'npm run compile', 'y'] });
  assert.equal(accepted.code, 0, accepted.output);
  assert.deepEqual(accepted.asked, ['Production branch', 'Build command, or "none"', 'Connect this Worker?']);
  assert.equal(mock.state.workerConfigs['tag-edge-api'].git_repository.branch, 'develop');
  assert.equal(mock.state.workerConfigs['tag-edge-api'].production_settings.build_command, 'npm run compile');

  mock.reset();
  const declined = await flareship(workerRepo(), ['import'], { interactive: true, answers: ['', 'none', 'n'] });
  assert.equal(declined.code, 0);
  assert.match(declined.output, /Nothing was created/);
  assert.deepEqual(mock.state.workerConfigs, {});
  assert.equal(mock.state.scripts.length, 0);
});

test('a connected Worker is not imported twice', async () => {
  seedWorker();
  const { code, output } = await flareship(workerRepo(), ['import', '--yes']);
  assert.equal(code, 0, output);
  assert.match(output, /edge-api is already connected to github\.com\/Acme\/edge-api/);
  assert.match(output, /Pushes to main publish to https:\/\/edge-api\.acme\.workers\.dev/);
  assert.equal(mock.state.requests.filter((r) => r.method === 'POST').length, 0);
});

test('importing a Worker fails with instructions when something it needs is missing', async () => {
  const cases = [
    [makeRepo('plain', { 'public/index.html': '<html>' }), ['--workers'], /A Worker needs a wrangler configuration file[\s\S]*flareship import --pages/],
    [makeRepo('edge-api', { 'wrangler.toml': 'main = "x.js"\n' }), [], /wrangler\.toml has no "name"/],
    [makeRepo('edge-api', { 'wrangler.jsonc': '{ not json' }), [], /wrangler\.jsonc has no "name"/],
    [workerRepo(), ['--name', 'other'], /The Worker must be named "edge-api", the name in wrangler\.jsonc/],
    [workerRepo({ host: 'gitlab.com' }), [], /can only connect Workers to GitHub/],
    [workerRepo(), ['--workers', '--pages'], /Use --workers or --pages, not both/],
  ];
  for (const [dir, flags, message] of cases) {
    const { code, output } = await flareship(dir, ['import', '--yes', ...flags]);
    assert.equal(code, 1, output);
    assert.match(output, message);
  }
  assert.deepEqual(mock.state.workerConfigs, {});

  mock.state.buildTokens = [];
  const noToken = await flareship(workerRepo(), ['import', '--yes']);
  assert.equal(noToken.code, 1);
  assert.match(noToken.output, /This account has no Workers build token yet[\s\S]*Settings -> Builds -> Connect/);
  assert.equal(mock.state.scripts.length, 0);
});

test('--name matching the wrangler config is accepted', async () => {
  const { code } = await flareship(workerRepo(), ['import', '--yes', '--name', 'edge-api']);
  assert.equal(code, 0);
});

test('--pages and a Pages wrangler config both import as a Pages project', async () => {
  const forced = await flareship(workerRepo(), ['import', '--yes', '--pages', '--out', 'dist']);
  assert.equal(forced.code, 0, forced.output);
  assert.match(forced.output, /Pages project\s+edge-api/);
  assert.equal(mock.state.projects.length, 1);
  assert.deepEqual(mock.state.workerConfigs, {});

  mock.reset();
  const pagesConfig = makeRepo('site', { 'wrangler.toml': 'name = "site"\npages_build_output_dir = "dist"\n', 'public/index.html': '<html>' });
  const auto = await flareship(pagesConfig, ['import', '--yes']);
  assert.equal(auto.code, 0, auto.output);
  assert.match(auto.output, /Pages project\s+site/);
});

test('a repository already connected as a Pages project is not turned into a Worker by accident', async () => {
  mock.state.projects.push({ name: 'edge-api', subdomain: 'edge-api.pages.dev', production_branch: 'main', source: { type: 'github', config: { owner: 'Acme', repo_name: 'edge-api' } } });
  const auto = await flareship(workerRepo(), ['import', '--yes']);
  assert.match(auto.output, /already connected/);
  assert.deepEqual(mock.state.workerConfigs, {});

  const forced = await flareship(workerRepo(), ['import', '--yes', '--workers']);
  assert.equal(forced.code, 0, forced.output);
  assert.match(forced.output, /Connected edge-api/);
});

test('a private repository needs a GitHub sign-in to be looked up', async () => {
  mock.state.github['Acme/edge-api'].private = true;
  const denied = await flareship(workerRepo(), ['import', '--yes']);
  assert.equal(denied.code, 1);
  assert.match(denied.output, /Could not read github\.com\/Acme\/edge-api from GitHub \(HTTP 404\)[\s\S]*gh auth login[\s\S]*GH_TOKEN/);
  assert.deepEqual(mock.state.workerConfigs, {});

  mock.reset();
  mock.state.github['Acme/edge-api'].private = true;
  const allowed = await flareship(workerRepo(), ['import', '--yes'], { env: { GH_TOKEN: 'gh-token' } });
  assert.equal(allowed.code, 0, allowed.output);
  assert.equal(mock.state.workerConfigs['tag-edge-api'].git_repository.repo_id, '777');
});

test('a failed Worker build is reported, and the connection is kept', async () => {
  mock.state.buildOutcome = 'fail';
  const { code, output } = await flareship(workerRepo(), ['import', '--yes']);
  assert.equal(code, 1);
  assert.match(output, /Connected edge-api/);
  assert.match(output, /The build failed\. See the log above/);
  assert.ok(mock.state.workerConfigs['tag-edge-api']);

  mock.state.buildOutcome = 'cancelled';
  const canceled = await flareship(workerRepo(), ['deploy']);
  assert.equal(canceled.code, 1);
  assert.match(canceled.output, /The build was canceled/);
});

test('status shows a Worker, its settings and its builds', async () => {
  const script = seedWorker();
  seedBuild(script.tag);
  seedBuild(script.tag, { branch: 'feature-x', message: '', source: 'manual' });
  const { code, output } = await flareship(workerRepo(), ['status']);
  assert.equal(code, 0, output);
  assert.match(output, /edge-api\s+Worker\s+\S+ live\n\s+https:\/\/edge-api\.acme\.workers\.dev/);
  assert.match(output, /Repository\s+github\.com\/Acme\/edge-api/);
  assert.match(output, /Branch\s+main\s+\S+\s+previews on/);
  assert.match(output, /Build\s+npm run build/);
  assert.match(output, /Deploy\s+npx wrangler deploy/);
  assert.match(output, /bld00001\s+production\s+main\s+fedcba9\s+Add the edge API/);
  assert.match(output, /bld00002\s+preview\s+feature-x\s+fedcba9\s+started by manual/);
});

test('status of a Worker that is not connected, has a root folder, or is still building', async () => {
  seedWorker('edge-api', { connected: false });
  const dir = workerRepo();
  const bare = await flareship(dir, ['status']);
  assert.equal(bare.code, 0, bare.output);
  assert.match(bare.output, /edge-api\s+Worker\n/);
  assert.match(bare.output, /Repository\s+not connected to Git/);
  assert.match(bare.output, /No builds yet/);

  const deploy = await flareship(dir, ['deploy']);
  assert.equal(deploy.code, 1);
  assert.match(deploy.output, /edge-api is not connected to a Git repository/);

  mock.reset();
  const script = seedWorker('edge-api', { previews: false });
  mock.state.workerConfigs[script.tag].production_settings.root_directory = '/apps/api';
  seedBuild(script.tag, { polls: 0 });
  const building = await flareship(dir, ['status']);
  assert.match(building.output, /edge-api\s+Worker\s+\S+ building/);
  assert.match(building.output, /Root\s+\/apps\/api/);
  assert.doesNotMatch(building.output, /previews on/);

  mock.state.builds[0].polls = 5;
  mock.state.builds[0].outcome = 'terminated';
  const failed = await flareship(dir, ['status']);
  assert.match(failed.output, /edge-api\s+Worker\s+\S+ last build failed/);
});

test('logs, deploy and open work on a connected Worker', async () => {
  const script = seedWorker();
  const build = seedBuild(script.tag);
  const dir = workerRepo();

  const logs = await flareship(dir, ['logs', 'bld00001']);
  assert.equal(logs.code, 0, logs.output);
  assert.match(logs.output, /Running: npm run build/);
  assert.equal((await flareship(dir, ['logs', build.id])).code, 0);

  mock.state.logPageSize = 1;
  const paged = await flareship(dir, ['logs']);
  assert.match(paged.output, /Cloning repository\nRunning: npm run build\nDeployed edge-api/);
  mock.state.logPageSize = 0;

  const deploy = await flareship(dir, ['deploy']);
  assert.equal(deploy.code, 0, deploy.output);
  assert.match(deploy.output, /Building edge-api from main/);
  assert.match(deploy.output, /Live at https:\/\/edge-api\.acme\.workers\.dev/);

  const preview = await flareship(dir, ['deploy', '--branch', 'feature-x']);
  assert.equal(preview.code, 0, preview.output);
  assert.match(preview.output, /Preview at https:\/\/preview-edge-api\.acme\.workers\.dev/);

  seedBuild(script.tag, { polls: 0 });
  const followed = await flareship(dir, ['logs', '-f']);
  assert.equal(followed.code, 0, followed.output);
  assert.match(followed.output, /Deployed edge-api/);

  const open = await flareship(dir, ['open']);
  assert.equal(open.output, 'https://edge-api.acme.workers.dev');
  assert.deepEqual(open.opened, ['https://edge-api.acme.workers.dev']);
});

test('a branch without a build trigger cannot be deployed', async () => {
  seedWorker('edge-api', { previews: false });
  const { code, output } = await flareship(workerRepo(), ['deploy', '--branch', 'feature-x']);
  assert.equal(code, 1);
  assert.match(output, /edge-api has no build trigger for the branch "feature-x"/);
});

test('a Worker is found by --name from any folder', async () => {
  seedWorker();
  const byName = await flareship(tempDir(), ['status', '--name', 'edge-api']);
  assert.equal(byName.code, 0, byName.output);
  assert.match(byName.output, /edge-api\s+Worker/);

  const forced = await flareship(tempDir(), ['status', '--name', 'edge-api', '--workers']);
  assert.equal(forced.code, 0);

  const missing = await flareship(tempDir(), ['status', '--name', 'ghost', '--workers']);
  assert.equal(missing.code, 1);
  assert.match(missing.output, /No Worker is called "ghost"/);
});

test('a Worker without a workers.dev subdomain has no address to open', async () => {
  seedWorker();
  mock.state.subdomain = null;
  const open = await flareship(workerRepo(), ['open']);
  assert.equal(open.code, 1);
  assert.match(open.output, /edge-api has no public address/);

  const deploy = await flareship(workerRepo(), ['deploy']);
  assert.equal(deploy.code, 0, deploy.output);
  assert.match(deploy.output, /Deployed\n/);
});

test('list shows Pages projects and Workers together', async () => {
  mock.state.projects.push({ name: 'demo-site', subdomain: 'demo-site.pages.dev', production_branch: 'main', source: { type: 'github', config: { owner: 'Acme', repo_name: 'Demo_Site' } } });
  seedWorker('edge-api');
  seedWorker('cron-job', { connected: false });
  const { code, output } = await flareship(os.tmpdir(), ['list']);
  assert.equal(code, 0, output);
  assert.match(output, /demo-site\s+Pages\s+https:\/\/demo-site\.pages\.dev\s+github\.com\/Acme\/Demo_Site/);
  assert.match(output, /edge-api\s+Worker\s+https:\/\/edge-api\.acme\.workers\.dev\s+github\.com\/Acme\/edge-api/);
  assert.match(output, /cron-job\s+Worker\s+https:\/\/cron-job\.acme\.workers\.dev\s+not connected to Git/);
  assert.match(output, /1 Pages project \S+ 2 Workers/);
});

test('with only the browser sign-in, Workers are listed and opened but their builds need a token', async () => {
  seedWorker();
  const dir = workerRepo();

  const list = await flareship(os.tmpdir(), ['list'], browser);
  assert.equal(list.code, 0, list.output);
  assert.match(list.output, /edge-api\s+Worker\s+https:\/\/edge-api\.acme\.workers\.dev\s+unknown without an API token/);
  assert.equal(mock.state.requests.filter((r) => r.path.includes('/builds/')).length, 0);

  const open = await flareship(dir, ['open'], browser);
  assert.equal(open.output, 'https://edge-api.acme.workers.dev');

  for (const command of [['status'], ['logs'], ['deploy'], ['status', '--name', 'edge-api']]) {
    const { code, output } = await flareship(dir, command, browser);
    assert.equal(code, 1);
    assert.match(output, /Workers builds need an API token[\s\S]*Workers Builds Configuration[\s\S]*flareship login --token/);
  }

  mock.reset();
  const fresh = await flareship(workerRepo(), ['import', '--yes'], browser);
  assert.equal(fresh.code, 1);
  assert.match(fresh.output, /Workers builds need an API token/);
  assert.equal(mock.state.scripts.length, 0);
  assert.equal(mock.state.requests.filter((r) => r.path.includes('/builds/')).length, 0);
});
