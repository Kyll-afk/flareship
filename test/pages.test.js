import assert from 'node:assert/strict';
import os from 'node:os';
import { after, beforeEach, test } from 'node:test';
import { createCli, makeRepo, startMock, tempDir } from '../support/mock.js';

const mock = await startMock();
const flareship = createCli(mock);
after(() => mock.close());
beforeEach(() => mock.reset());

const VITE = { 'package.json': { scripts: { build: 'vite build' }, devDependencies: { vite: '5' } } };
const created = () => mock.state.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/pages/projects')).map((r) => JSON.parse(r.text));

function seedProject(name, { owner = 'Acme', repo = name, branch = 'main', type = 'github', connected = true, domains = [], build = { build_command: 'npm run build', destination_dir: 'dist', root_dir: '' } } = {}) {
  const project = {
    name,
    subdomain: `${name}.pages.dev`,
    domains: [`${name}.pages.dev`, ...domains],
    production_branch: branch,
    build_config: build,
    source: connected ? { type, config: { owner, repo_name: repo } } : null,
  };
  mock.state.projects.push(project);
  return project;
}

function seedDeployment(project, { branch = 'main', environment = 'production', outcome = 'success', polls = 5, message = 'Seeded commit' } = {}) {
  const n = ++mock.state.counter;
  const deployment = {
    id: `dep${String(n).padStart(5, '0')}-full`,
    short_id: `dep${String(n).padStart(5, '0')}`,
    project,
    branch,
    environment,
    commit: '1234567890abc',
    message,
    outcome,
    polls,
    created_on: new Date().toISOString(),
  };
  mock.state.deployments.unshift(deployment);
  return deployment;
}

test('import creates a connected project, builds it and reports the live address', async () => {
  const dir = makeRepo('Demo_Site', VITE, { pushed: true });
  const { code, output } = await flareship(dir, ['import', '--yes']);

  assert.equal(code, 0, output);
  assert.match(output, /1\/4\s+Repository\n\s+github\.com\/Acme\/Demo_Site/);
  assert.match(output, /2\/4\s+Cloudflare account/);
  assert.match(output, /3\/4\s+Build settings\n\s+Detected Vite/);
  assert.match(output, /4\/4\s+Create and publish/);
  assert.match(output, /Created demo-site/);
  assert.match(output, /Every push to main now publishes to https:\/\/demo-site\.pages\.dev/);
  assert.match(output, /Building demo-site from main/);
  assert.match(output, /Success: Your site was deployed!/);
  assert.match(output, /Live at https:\/\/demo-site\.pages\.dev/);
  assert.doesNotMatch(output, /has not been pushed|not pushed yet|will be public/);

  assert.deepEqual(created(), [
    {
      name: 'demo-site',
      production_branch: 'main',
      build_config: { build_command: 'npm run build', destination_dir: 'dist', root_dir: '' },
      source: {
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
      },
    },
  ]);
});

test('import takes every setting from the options', async () => {
  const dir = makeRepo('mystery', { 'apps/web/main.rs': '' });
  const { code, output } = await flareship(dir, ['import', '--yes', '--name', 'Mystery Web', '--build', 'make site', '--out', './out/', '--root', 'apps/web', '--branch', 'release', '--no-previews']);

  assert.equal(code, 0, output);
  assert.match(output, /Could not detect how this project is built/);
  assert.match(output, /Root\s+apps\/web/);
  const [project] = created();
  assert.equal(project.name, 'mystery-web');
  assert.equal(project.production_branch, 'release');
  assert.deepEqual(project.build_config, { build_command: 'make site', destination_dir: 'out', root_dir: 'apps/web' });
  assert.equal(project.source.config.preview_deployment_setting, 'none');
  assert.equal(project.source.config.production_branch, 'release');
  assert.match(output, /Live at https:\/\/mystery-web\.pages\.dev/);
});

test('--build none means no build step', async () => {
  const dir = makeRepo('plain', { 'main.rs': '' });
  const { code } = await flareship(dir, ['import', '--yes', '--build', 'none', '--out', 'web']);
  assert.equal(code, 0);
  assert.deepEqual(created()[0].build_config, { build_command: '', destination_dir: 'web', root_dir: '' });
});

test('import refuses to guess when it cannot detect the build and nobody can be asked', async () => {
  const dir = makeRepo('mystery', { 'main.rs': 'fn main() {}' });
  const { code, output } = await flareship(dir, ['import', '--yes']);
  assert.equal(code, 1);
  assert.match(output, /Could not detect the build settings\. Pass --build/);
  assert.equal(created().length, 0);
});

test('import asks for each setting and uses the answers', async () => {
  const dir = makeRepo('demo', VITE);
  const { code, output, asked, unused } = await flareship(dir, ['import'], {
    interactive: true,
    answers: ['My Shop', 'production', 'npm run build:prod', 'build/', 'y'],
  });

  assert.equal(code, 0, output);
  assert.deepEqual(asked, ['Project name', 'Production branch', 'Build command, or "none"', 'Folder to publish, or "." for the whole repository', 'Create this project?']);
  assert.equal(unused.length, 0);
  const [project] = created();
  assert.equal(project.name, 'my-shop');
  assert.equal(project.production_branch, 'production');
  assert.deepEqual(project.build_config, { build_command: 'npm run build:prod', destination_dir: 'build', root_dir: '' });
  assert.match(output, /Pages project\s+my-shop/);
});

test('pressing Enter at every question keeps the detected settings', async () => {
  const dir = makeRepo('demo', VITE);
  const { code } = await flareship(dir, ['import'], { interactive: true, answers: ['', '', '', '', ''] });
  assert.equal(code, 0);
  assert.deepEqual(created()[0].build_config, { build_command: 'npm run build', destination_dir: 'dist', root_dir: '' });
  assert.equal(created()[0].name, 'demo');
});

test('answering "none" and "." publishes the whole repository without a build', async () => {
  const dir = makeRepo('demo', VITE);
  const { code, output } = await flareship(dir, ['import'], { interactive: true, answers: ['', '', 'none', '.', 'yes'] });
  assert.equal(code, 0);
  assert.deepEqual(created()[0].build_config, { build_command: '', destination_dir: '', root_dir: '' });
  assert.match(output, /Publish\s+the whole repository/);
  assert.match(output, /No publish folder: every file in the repository will be public/);
});

test('declining the confirmation creates nothing', async () => {
  const dir = makeRepo('demo', VITE);
  const { code, output } = await flareship(dir, ['import'], { interactive: true, answers: ['', '', '', '', 'n'] });
  assert.equal(code, 0);
  assert.match(output, /Nothing was created/);
  assert.equal(created().length, 0);
});

test('import warns about a static site in the repository root and about unpushed work', async () => {
  const root = await flareship(makeRepo('rooted', { 'index.html': '<html>' }), ['import', '--yes']);
  assert.match(root.output, /Detected Static site/);
  assert.match(root.output, /No publish folder: every file in the repository will be public/);
  assert.match(root.output, /This branch has not been pushed/);

  const ahead = await flareship(makeRepo('ahead', VITE, { ahead: 2 }), ['import', '--yes']);
  assert.match(ahead.output, /2 local commit\(s\) are not pushed yet/);
  assert.doesNotMatch(ahead.output, /has not been pushed/);
});

test('the production branch defaults to the remote default branch, then the current one', async () => {
  await flareship(makeRepo('a', VITE, { branch: 'feature', defaultBranch: 'trunk' }), ['import', '--yes']);
  assert.equal(created()[0].production_branch, 'trunk');
  await flareship(makeRepo('b', VITE, { branch: 'develop' }), ['import', '--yes']);
  assert.equal(created()[1].production_branch, 'develop');
});

test('import does not create a second project for a repository that is already connected', async () => {
  seedProject('demo-site', { repo: 'Demo_Site' });
  const { code, output } = await flareship(makeRepo('demo_site', VITE), ['import', '--yes']);
  assert.equal(code, 0, output);
  assert.match(output, /demo-site is already connected to github\.com\/Acme\/demo_site/);
  assert.match(output, /Pushes to main publish to https:\/\/demo-site\.pages\.dev/);
  assert.equal(created().length, 0);
});

test('import explains what to do when Cloudflare cannot use the repository', async () => {
  for (const name of ['locked', 'hidden']) {
    const { code, output } = await flareship(makeRepo(name, { 'public/index.html': '<html>' }), ['import', '--yes']);
    assert.equal(code, 1);
    assert.match(output, new RegExp(`Cloudflare cannot see github\\.com/Acme/${name}`));
    assert.match(output, /Nothing was created/);
    assert.match(output, /github\.com\/settings\/installations/);
    assert.match(output, /workers-and-pages\/create\/pages/);
  }
  assert.equal(mock.state.projects.length, 0);

  const gitlab = await flareship(makeRepo('locked', { 'public/index.html': '<html>' }, { host: 'gitlab.com' }), ['import', '--yes']);
  assert.equal(gitlab.code, 1);
  assert.match(gitlab.output, /Cloudflare cannot see gitlab\.com\/Acme\/locked/);
  assert.match(gitlab.output, /Connect GitLab once/);
});

test('a GitLab repository is connected as a GitLab source', async () => {
  const { code, output } = await flareship(makeRepo('docs', { 'mkdocs.yml': '' }, { host: 'gitlab.com', owner: 'team/sub' }), ['import', '--yes']);
  assert.equal(code, 0, output);
  assert.equal(created()[0].source.type, 'gitlab');
  assert.equal(created()[0].source.config.owner, 'team/sub');
  assert.deepEqual(created()[0].build_config, { build_command: 'mkdocs build', destination_dir: 'site', root_dir: '' });
});

test('other API errors while creating the project are shown as they are', async () => {
  seedProject('demo', { repo: 'something-else' });
  const { code, output } = await flareship(makeRepo('demo', VITE), ['import', '--yes']);
  assert.equal(code, 1);
  assert.match(output, /A project with this name already exists/);
});

test('a failed or canceled first build is reported with its log', async () => {
  mock.state.deploymentOutcome = 'failure';
  const failed = await flareship(makeRepo('demo', VITE), ['import', '--yes']);
  assert.equal(failed.code, 1);
  assert.match(failed.output, /Created demo/);
  assert.match(failed.output, /Failed: build command exited with code 1/);
  assert.match(failed.output, /The build failed\. See the log above/);

  mock.state.deploymentOutcome = 'canceled';
  const canceled = await flareship(makeRepo('other', VITE), ['import', '--yes']);
  assert.equal(canceled.code, 1);
  assert.match(canceled.output, /The build was canceled/);
});

test('the project is kept when the first build cannot be started', async () => {
  mock.state.deploymentStartError = 'Build queue is unavailable';
  const { code, output } = await flareship(makeRepo('demo', VITE), ['import', '--yes']);
  assert.equal(code, 1);
  assert.match(output, /Created demo/);
  assert.match(output, /The project exists, but the first build could not be started: Build queue is unavailable/);
  assert.match(output, /Push a commit or run "flareship deploy"/);
  assert.equal(mock.state.projects.length, 1);
});

test('deploy rebuilds production, builds a preview for another branch, and refuses upload-only projects', async () => {
  seedProject('demo');
  const dir = makeRepo('demo', VITE);

  const production = await flareship(dir, ['deploy']);
  assert.equal(production.code, 0, production.output);
  assert.match(production.output, /Building demo from main/);
  assert.match(production.output, /Live at https:\/\/demo\.pages\.dev/);

  const preview = await flareship(dir, ['deploy', '--branch', 'feature-x']);
  assert.equal(preview.code, 0, preview.output);
  assert.match(preview.output, /Building demo from feature-x/);
  assert.match(preview.output, /Preview at https:\/\/dep\d+\.demo\.pages\.dev/);
  assert.equal(mock.state.deployments[0].environment, 'preview');

  mock.state.deploymentOutcome = 'failure';
  const failed = await flareship(dir, ['deploy']);
  assert.equal(failed.code, 1);
  assert.match(failed.output, /The build failed/);

  seedProject('uploaded', { connected: false });
  const upload = await flareship(tempDir(), ['deploy', '--name', 'uploaded']);
  assert.equal(upload.code, 1);
  assert.match(upload.output, /uploaded is not connected to a Git repository/);
});

test('status shows the project, its settings and its builds', async () => {
  seedProject('demo', { domains: ['www.example.com'] });
  seedDeployment('demo', { message: 'First\nwith a body' });
  seedDeployment('demo', { branch: 'feature-x', environment: 'preview', message: 'Try a thing' });
  seedDeployment('demo', { message: 'A very long commit message that certainly does not fit in the column it is given by the table' });

  const { code, output } = await flareship(makeRepo('demo', VITE), ['status']);
  assert.equal(code, 0, output);
  assert.match(output, /demo\s+Pages\s+\S+ live\n\s+https:\/\/demo\.pages\.dev/);
  assert.match(output, /Domains\s+www\.example\.com/);
  assert.match(output, /Repository\s+github\.com\/Acme\/demo/);
  assert.match(output, /Branch\s+main/);
  assert.match(output, /Build\s+npm run build/);
  assert.match(output, /Publish\s+dist/);
  assert.match(output, /ID\s+TARGET\s+BRANCH\s+COMMIT\s+MESSAGE\s+WHEN/);
  assert.match(output, /dep00001\s+production\s+main\s+1234567\s+First\s+just now/);
  assert.match(output, /dep00002\s+preview\s+feature-x\s+1234567\s+Try a thing/);
  assert.match(output, /A very long commit message that certainly\S*(\.\.\.|…)/);
  assert.match(output, /dep00002\s+https:\/\/dep00002\.demo\.pages\.dev/);
  assert.match(output, /flareship logs <id> prints a build log/);
});

test('status reflects a failed, canceled or running latest build', async () => {
  seedProject('demo');
  const dir = makeRepo('demo', VITE);
  for (const [outcome, polls, word] of [['failure', 5, 'last build failed'], ['canceled', 5, 'last build canceled'], ['success', 0, 'building']]) {
    seedDeployment('demo', { outcome, polls });
    const { output } = await flareship(dir, ['status']);
    assert.match(output, new RegExp(`demo\\s+Pages\\s+\\S+ ${word}`));
  }
});

test('status of an upload-only project without deployments', async () => {
  seedProject('uploaded', { connected: false, build: {} });
  const { code, output } = await flareship(tempDir(), ['status', '--name', 'uploaded']);
  assert.equal(code, 0, output);
  assert.match(output, /uploaded\s+Pages\n/);
  assert.match(output, /Repository\s+not connected \(direct upload\)/);
  assert.match(output, /Build\s+none/);
  assert.match(output, /Publish\s+the whole repository/);
  assert.match(output, /No builds yet/);
});

test('logs prints the latest build, a chosen one, or follows a running one', async () => {
  seedProject('demo');
  const dir = makeRepo('demo', VITE);

  const none = await flareship(dir, ['logs']);
  assert.equal(none.code, 1);
  assert.match(none.output, /demo has no builds yet/);

  const first = seedDeployment('demo');
  seedDeployment('demo', { outcome: 'failure' });
  const latest = await flareship(dir, ['logs']);
  assert.equal(latest.code, 0);
  assert.match(latest.output, /Failed: build command exited with code 1/);

  for (const id of [first.short_id, first.id, first.id.slice(0, 9)]) {
    const chosen = await flareship(dir, ['logs', id]);
    assert.match(chosen.output, /Success: Your site was deployed!/);
  }

  const unknown = await flareship(dir, ['logs', 'zzz']);
  assert.equal(unknown.code, 1);
  assert.match(unknown.output, /No recent build matches "zzz"/);

  seedDeployment('demo', { polls: 0 });
  const followed = await flareship(dir, ['logs', '--follow']);
  assert.equal(followed.code, 0, followed.output);
  assert.match(followed.output, /Cloning repository[\s\S]*Building[\s\S]*Success: Your site was deployed!/);

  seedDeployment('demo', { polls: 0, outcome: 'failure' });
  const followedFailure = await flareship(dir, ['logs', '-f']);
  assert.equal(followedFailure.code, 1);

  const finished = await flareship(dir, ['logs', '-f']);
  assert.equal(finished.code, 0);
  assert.match(finished.output, /Failed: build command exited/);
});

test('open prints the address and opens the browser unless told not to', async () => {
  seedProject('demo');
  const dir = makeRepo('demo', VITE);
  const opened = await flareship(dir, ['open']);
  assert.equal(opened.output, 'https://demo.pages.dev');
  assert.deepEqual(opened.opened, ['https://demo.pages.dev']);

  const quiet = await flareship(dir, ['open'], { env: { FLARESHIP_NO_BROWSER: '1' } });
  assert.equal(quiet.output, 'https://demo.pages.dev');
  assert.deepEqual(quiet.opened, []);
});

test('commands find the project by --name from any folder, and say when nothing matches', async () => {
  seedProject('demo');
  const byName = await flareship(tempDir(), ['status', '--name', 'demo']);
  assert.equal(byName.code, 0);
  assert.match(byName.output, /demo\s+Pages/);

  const missing = await flareship(tempDir(), ['status', '--name', 'nope']);
  assert.equal(missing.code, 1);
  assert.match(missing.output, /Project not found/);

  const forcedPages = await flareship(tempDir(), ['status', '--name', 'nope', '--pages']);
  assert.equal(forcedPages.code, 1);
  assert.match(forcedPages.output, /Project not found/);

  const unconnected = await flareship(makeRepo('lonely', VITE), ['status']);
  assert.equal(unconnected.code, 1);
  assert.match(unconnected.output, /Nothing on Cloudflare is connected to github\.com\/Acme\/lonely yet\. Run "flareship import" first/);
});

test('list shows every project across pages of results, or says the account is empty', async () => {
  mock.state.subdomain = null;
  const empty = await flareship(os.tmpdir(), ['list']);
  assert.equal(empty.code, 0);
  assert.match(empty.output, /Nothing in this account yet/);

  mock.state.projectsPerPage = 1;
  seedProject('one');
  seedProject('two', { type: 'gitlab', owner: 'team/sub' });
  seedProject('three', { connected: false });
  const { code, output } = await flareship(os.tmpdir(), ['list']);
  assert.equal(code, 0, output);
  assert.match(output, /NAME\s+TYPE\s+ADDRESS\s+SOURCE/);
  assert.match(output, /one\s+Pages\s+https:\/\/one\.pages\.dev\s+github\.com\/Acme\/one/);
  assert.match(output, /two\s+Pages\s+https:\/\/two\.pages\.dev\s+gitlab\.com\/team\/sub\/two/);
  assert.match(output, /three\s+Pages\s+https:\/\/three\.pages\.dev\s+direct upload/);
  assert.match(output, /3 Pages projects \S+ 0 Workers/);
  assert.equal(mock.state.requests.filter((r) => r.path.endsWith('/pages/projects') && r.method === 'GET').length, 4);
});

test('commands that need a repository explain what is wrong with the folder', async () => {
  const outside = await flareship(tempDir(), ['import', '--yes']);
  assert.equal(outside.code, 1);
  assert.match(outside.output, /This folder is not inside a Git repository/);

  const noRemote = await flareship(makeRepo('x', {}, { remote: false }), ['status']);
  assert.equal(noRemote.code, 1);
  assert.match(noRemote.output, /has no "origin" remote/);

  const bitbucket = await flareship(makeRepo('x', {}, { remote: 'https://bitbucket.org/acme/x.git' }), ['deploy']);
  assert.equal(bitbucket.code, 1);
  assert.match(bitbucket.output, /can only connect to GitHub or GitLab, and origin is https:\/\/bitbucket\.org\/acme\/x\.git/);
});

test('an SSH remote works the same as an HTTPS one', async () => {
  seedProject('demo');
  const { code, output } = await flareship(makeRepo('demo', VITE, { remote: 'git@github.com:Acme/demo.git' }), ['status']);
  assert.equal(code, 0, output);
  assert.match(output, /demo\s+Pages/);
});

test('a build log that is not available yet does not stop the follow', async () => {
  mock.state.logsUnavailable = 2;
  const { code, output } = await flareship(makeRepo('demo', VITE), ['import', '--yes']);
  assert.equal(code, 0, output);
  assert.match(output, /Success: Your site was deployed!/);
  assert.match(output, /Live at https:\/\/demo\.pages\.dev/);
});

test('a build that outlasts the wait is left running with a pointer to status', async () => {
  mock.state.pollsToFinish = 1000;
  const { code, output } = await flareship(makeRepo('demo', VITE), ['import', '--yes'], { env: { FLARESHIP_TAIL_LIMIT_MS: '20' } });
  assert.equal(code, 1);
  assert.match(output, /Created demo/);
  assert.match(output, /Still building after a long wait\. Check it with "flareship status"/);
  assert.doesNotMatch(output, /Live at/);
});
