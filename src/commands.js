import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ApiError, createClient } from './api.js';
import { clearConfig, clearSession, configPath, loadConfig, loadSession, saveConfig, saveSession } from './config.js';
import { detect } from './detect.js';
import { Fail } from './errors.js';
import { readRepo } from './git.js';
import { wranglerLogin, wranglerToken } from './wrangler.js';
import { ago, ask, askSecret, bold, busy, columns, confirm, cyan, dim, fields, green, red, spinner, sym, table, truncate, yellow } from './ui.js';

const NO_GIT_ACCESS = 8000011;
const TAIL_LIMIT_MS = 20 * 60 * 1000;
const SESSION_TTL_MS = 50 * 60 * 1000;
const STAGES = {
  queued: 'Waiting in the build queue',
  initialize: 'Preparing the build machine',
  clone_repo: 'Cloning the repository',
  build: 'Building the site',
  deploy: 'Publishing to Cloudflare',
};

export const HELP = `flareship: connect a Git repository to Cloudflare Pages from the terminal

Usage
  flareship import            connect this repository and publish it, step by step
  flareship guide             print the full setup walkthrough with every link
  flareship status            show the project and its latest deployments
  flareship deploy            start a new deployment and follow the build
  flareship logs [id]         print a deployment's build log (latest by default)
  flareship open              open the live site in the browser
  flareship list              list every Pages project in the account
  flareship login             sign in to Cloudflare through the browser
  flareship login --token     use an API token instead (scripts, CI)
  flareship logout            forget the saved account or token
  flareship whoami            show how you are signed in and to which account

Options
  --name <name>       project name (default: the repository name)
  --build <command>   build command ("none" for no build step)
  --out <folder>      folder to publish after the build
  --root <folder>     folder to build from, for monorepos
  --branch <branch>   production branch (import) or branch to deploy (deploy)
  --no-previews       do not build preview deployments for other branches
  -y, --yes           accept the detected settings without asking
  -f, --follow        keep following a running build (logs)
  -h, --help          show this help
  -v, --version       show the version

Authentication
  "flareship login" opens the browser (Cloudflare's own wrangler sign-in): no
  token to create and no Account ID to copy. For scripts, CLOUDFLARE_API_TOKEN
  and CLOUDFLARE_ACCOUNT_ID are read from the environment and win over it; the
  token needs the "Cloudflare Pages: Edit" permission.`;

export function sanitizeName(raw) {
  const name = String(raw ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+/, '')
    .slice(0, 58)
    .replace(/-+$/, '');
  return name || 'site';
}

export function findProjectForRepo(projects, remote) {
  const same = (a, b) => String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase();
  return (
    projects.find(
      (p) => p.source?.type === remote.type && same(p.source.config?.owner, remote.owner) && same(p.source.config?.repo_name, remote.repo),
    ) || null
  );
}

export function deploymentState(deployment) {
  const stages = [...(deployment.stages || []), deployment.latest_stage].filter(Boolean);
  if (stages.some((s) => s.status === 'failure')) return 'failure';
  if (stages.some((s) => s.status === 'canceled')) return 'canceled';
  if (deployment.latest_stage?.name === 'deploy' && deployment.latest_stage.status === 'success') return 'success';
  return 'running';
}

export function extractAccountId(value) {
  const match = String(value ?? '').match(/(?<![0-9a-f])[0-9a-f]{32}(?![0-9a-f])/i);
  return match ? match[0].toLowerCase() : null;
}

export function cleanFolder(value) {
  const folder = String(value ?? '').trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  return folder === '.' ? '' : folder;
}

function cleanBuild(value) {
  const build = String(value ?? '').trim();
  return build === '-' || build.toLowerCase() === 'none' ? '' : build;
}

const LINKS = {
  tokens: 'https://dash.cloudflare.com/profile/api-tokens',
  accountHome: 'https://dash.cloudflare.com/?to=/:account/workers-and-pages',
  githubApp: 'https://github.com/settings/installations',
  connectGit: (accountId) => `https://dash.cloudflare.com/${accountId || '?to=/:account'}/workers-and-pages/create/pages`,
};

export const GUIDE = `flareship setup, step by step

1. Put the project on GitHub (or GitLab)
   Cloudflare builds what is on the remote, not what is on your machine.
     git remote -v        must show an "origin" on github.com or gitlab.com
     git push -u origin main

2. Sign in to Cloudflare (once per machine)
   Run:  flareship login
   Your browser opens on Cloudflare: click "Allow". There is no token to create
   and no Account ID to copy. It uses Cloudflare's own wrangler sign-in, so if
   wrangler is already signed in on this machine you can skip this step.
   Scripts and CI use an API token instead:  flareship login --token

3. Let Cloudflare read the repository (once per repository, or once for all)
   First time ever: open ${LINKS.connectGit()}
     Import an existing Git repository -> Connect GitHub -> pick the repositories
     You can close the page once the repository shows up in the list.
   Later repositories: open ${LINKS.githubApp}
     Cloudflare Workers and Pages -> Configure -> add the repository,
     or choose "All repositories" so you never have to do this again.

4. Import the project
   Inside the repository run:  flareship import
   It detects the build, asks you to confirm, creates the Pages project,
   starts the first build and prints the live address.

5. From now on
     git push                 publishes (production branch) or creates a preview (other branches)
     flareship status         what is live and the latest builds
     flareship logs -f        follow the build that is running
     flareship deploy         rebuild without a new commit
     flareship open           open the site`;

const IN = '       ';
const step = (n, total, title) => `\n  ${cyan(`${n}/${total}`)}  ${bold(title)}`;
const ok = (text, indent = '  ') => `${indent}${green(sym.ok)} ${text}`;
const warn = (text, indent = '  ') => `${indent}${yellow(sym.warn)} ${text}`;
const siteUrl = (project) => `https://${project.subdomain || `${project.name}.pages.dev`}`;
const repoLabel = (remote) => `${remote.type}.com/${remote.owner}/${remote.repo}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function browserToken(ctx, { fresh = false } = {}) {
  if (!fresh) {
    const cached = loadSession(ctx.env);
    if (cached.token && Date.now() - cached.savedAt < SESSION_TTL_MS) return cached.token;
  }
  const token = await busy('Checking the Cloudflare sign-in', () => wranglerToken(ctx.env));
  if (token) saveSession({ token, savedAt: Date.now() }, ctx.env);
  else clearSession(ctx.env);
  return token;
}

async function session(ctx) {
  const config = loadConfig(ctx.env);
  let token = ctx.env.CLOUDFLARE_API_TOKEN || config.token;
  let source = ctx.env.CLOUDFLARE_API_TOKEN ? 'env' : config.token ? 'token' : null;
  if (!token && !ctx.env.FLARESHIP_NO_WRANGLER) {
    token = await browserToken(ctx);
    if (token) source = 'browser';
  }
  if (!token) {
    if (!ctx.interactive) throw new Fail('Not signed in to Cloudflare. Run "flareship login" or set CLOUDFLARE_API_TOKEN.');
    ctx.log(`${IN}Not signed in to Cloudflare on this machine yet.`);
    return loginFlow(ctx);
  }
  const refresh = source === 'browser' ? () => browserToken(ctx, { fresh: true }) : undefined;
  const client = createClient({ token, base: ctx.env.FLARESHIP_API_BASE, refresh });
  let accountId = ctx.env.CLOUDFLARE_ACCOUNT_ID || config.accountId;
  if (!accountId) {
    accountId = await pickAccount(ctx, client);
    saveConfig({ ...config, accountId }, ctx.env);
  }
  return { client, accountId, source };
}

async function pickAccount(ctx, client) {
  const accounts = await busy('Finding your Cloudflare account', () => client.listAccounts());
  if (accounts.length === 1) return accounts[0].id;
  if (accounts.length === 0) {
    throw new Fail('This token cannot list accounts. Set CLOUDFLARE_ACCOUNT_ID or run "flareship login --token" and enter the account.');
  }
  const lines = accounts.map((a, i) => `  ${i + 1}. ${a.name} ${dim(a.id)}`).join('\n');
  if (!ctx.prompts) throw new Fail(`This token can see several accounts. Set CLOUDFLARE_ACCOUNT_ID to one of:\n${lines}`);
  ctx.log(`This token can see several accounts:\n${lines}`);
  const choice = Number(await ask('Which one', '1'));
  const account = accounts[choice - 1];
  if (!account) throw new Fail('That is not one of the listed accounts.');
  return account.id;
}

function requireRepo(ctx) {
  const repo = readRepo(ctx.cwd);
  if (!repo) throw new Fail('This folder is not inside a Git repository.');
  if (!repo.remoteUrl) throw new Fail('This repository has no "origin" remote. Push it to GitHub or GitLab first.');
  if (!repo.remote) throw new Fail(`Cloudflare Pages can only connect to GitHub or GitLab, and origin is ${repo.remoteUrl}`);
  return repo;
}

async function resolveProject(ctx, client, accountId) {
  if (ctx.flags.name) return busy('Loading the project', () => client.getProject(accountId, ctx.flags.name));
  const repo = requireRepo(ctx);
  const projects = await busy('Loading your projects', () => client.listProjects(accountId));
  const project = findProjectForRepo(projects, repo.remote);
  if (!project) throw new Fail(`No Pages project is connected to ${repoLabel(repo.remote)}. Run "flareship import" first.`);
  return project;
}

async function planImport(ctx, repo) {
  const { flags } = ctx;
  const root = cleanFolder(flags.root);
  const found = detect(path.join(repo.root, root));
  const plan = {
    name: sanitizeName(flags.name ?? repo.remote.repo),
    branch: flags.branch ?? repo.defaultBranch ?? repo.branch ?? 'main',
    build: flags.build !== undefined ? cleanBuild(flags.build) : found.build,
    out: flags.out !== undefined ? cleanFolder(flags.out) : found.out,
    root,
    previews: !flags['no-previews'],
  };

  if (found.name) ctx.log(`${IN}Detected ${bold(found.name)}${found.note ? dim(`  ${sym.dot}  ${found.note}`) : ''}`);
  else ctx.log(`${IN}Could not detect how this project is built.`);

  if (ctx.prompts) {
    ctx.log('');
    plan.name = sanitizeName(await ask(`${IN}Project name`, plan.name));
    plan.branch = await ask(`${IN}Production branch`, plan.branch);
    plan.build = cleanBuild(await ask(`${IN}Build command, or "none"`, plan.build || 'none'));
    plan.out = cleanFolder(await ask(`${IN}Folder to publish, or "." for the whole repository`, plan.out || '.'));
  } else if (plan.build === null || plan.out === null) {
    throw new Fail('Could not detect the build settings. Pass --build "<command>" (or --build none) and --out <folder>.');
  }
  return plan;
}

function printPlan(ctx, repo, plan) {
  const rows = [
    ['Project', bold(plan.name)],
    ['Repository', repoLabel(repo.remote)],
    ['Branch', `${plan.branch}${plan.previews ? dim(`  ${sym.dot}  other branches get preview links`) : ''}`],
    plan.root ? ['Root', plan.root] : null,
    ['Build', plan.build || dim('none')],
    ['Publish', plan.out || 'the whole repository'],
  ];
  ctx.log('');
  for (const line of fields(rows, IN.length)) ctx.log(line);

  const warnings = [];
  if (!plan.out) warnings.push('No publish folder: every file in the repository will be public.');
  if (!repo.upstream) warnings.push('This branch has not been pushed. Cloudflare builds what is on the remote.');
  else if (repo.ahead > 0) warnings.push(`${repo.ahead} local commit(s) are not pushed yet and will not be in the first build.`);
  if (warnings.length) ctx.log('');
  for (const warning of warnings) ctx.log(warn(warning, IN));
}

function gitAccessHelp(remote, accountId) {
  if (remote.type !== 'github') {
    return [
      `Cloudflare has no access to ${repoLabel(remote)}.`,
      `Connect GitLab once at https://dash.cloudflare.com/${accountId}/workers-and-pages/create/pages and run this again.`,
    ].join('\n');
  }
  return [
    `Cloudflare has no access to ${repoLabel(remote)}.`,
    '',
    'If Cloudflare is already connected to your GitHub account, add this repository:',
    `  ${LINKS.githubApp}  ->  Cloudflare Workers and Pages  ->  Configure`,
    'If it was never connected, do it once here ("Import an existing Git repository" -> "Connect GitHub"):',
    `  ${LINKS.connectGit(accountId)}`,
    '',
    'Then run "flareship import" again.',
  ].join('\n');
}

async function tail(ctx, client, accountId, name, id, indent = '  ') {
  const interval = Number(ctx.env.FLARESHIP_POLL_MS) || 3000;
  const started = Date.now();
  const progress = spinner('Waiting for the build to start');
  let printed = 0;
  const flush = async () => {
    let lines;
    try {
      lines = await client.deploymentLogs(accountId, name, id);
    } catch (error) {
      if (error instanceof ApiError) return;
      throw error;
    }
    if (lines.length > printed) progress.clear();
    for (const entry of lines.slice(printed)) ctx.log(`${indent}${dim(sym.bar)} ${dim(entry.line)}`);
    printed = Math.max(printed, lines.length);
  };

  try {
    for (;;) {
      await flush();
      const deployment = await client.getDeployment(accountId, name, id);
      const state = deploymentState(deployment);
      if (state !== 'running') {
        await flush();
        return state;
      }
      progress.text(STAGES[deployment.latest_stage?.name] || 'Building');
      if (Date.now() - started > TAIL_LIMIT_MS) return 'running';
      await sleep(interval);
    }
  } finally {
    progress.stop();
  }
}

async function deployAndFollow(ctx, client, accountId, project, branch, indent = '  ') {
  const deployment = await busy('Starting the build', () => client.createDeployment(accountId, project.name, branch));
  ctx.log(`${indent}Building ${bold(project.name)} from ${branch}`);
  const state = await tail(ctx, client, accountId, project.name, deployment.id, indent);
  if (state === 'success') {
    const production = branch === project.production_branch;
    ctx.log(ok(`${production ? 'Live at' : 'Preview at'} ${cyan(production ? siteUrl(project) : deployment.url)}`, indent));
    ctx.log('');
    return 0;
  }
  if (state === 'running') {
    ctx.log(warn('Still building after 20 minutes. Check it with "flareship status".', indent));
    ctx.log('');
    return 1;
  }
  throw new Fail(`The build ${state === 'canceled' ? 'was canceled' : 'failed'}. See the log above.`);
}

async function importCommand(ctx) {
  ctx.log(step(1, 4, 'Repository'));
  const repo = requireRepo(ctx);
  ctx.log(`${IN}${repoLabel(repo.remote)}${repo.branch ? dim(`  ${sym.dot}  ${repo.branch}`) : ''}`);

  ctx.log(step(2, 4, 'Cloudflare account'));
  const { client, accountId } = await session(ctx);
  ctx.log(`${IN}${accountId}`);

  const projects = await busy('Checking whether this repository is already connected', () => client.listProjects(accountId));
  const existing = findProjectForRepo(projects, repo.remote);
  if (existing) {
    ctx.log('');
    ctx.log(ok(`${bold(existing.name)} is already connected to ${repoLabel(repo.remote)}`));
    ctx.log(`    Pushes to ${existing.production_branch} publish to ${cyan(siteUrl(existing))}`);
    ctx.log('');
    return 0;
  }

  ctx.log(step(3, 4, 'Build settings'));
  const plan = await planImport(ctx, repo);
  printPlan(ctx, repo, plan);
  if (ctx.prompts) {
    ctx.log('');
    if (!(await confirm(`${IN}Create this project?`))) {
      ctx.log(`${IN}Nothing was created.`);
      return 0;
    }
  }

  ctx.log(step(4, 4, 'Create and publish'));
  let project;
  try {
    project = await busy('Creating the project on Cloudflare', () =>
      client.createProject(accountId, {
        name: plan.name,
        production_branch: plan.branch,
        build_config: { build_command: plan.build, destination_dir: plan.out, root_dir: plan.root },
        source: {
          type: repo.remote.type,
          config: {
            owner: repo.remote.owner,
            repo_name: repo.remote.repo,
            production_branch: plan.branch,
            pr_comments_enabled: true,
            deployments_enabled: true,
            production_deployments_enabled: true,
            preview_deployment_setting: plan.previews ? 'all' : 'none',
          },
        },
      }),
    );
  } catch (error) {
    if (error instanceof ApiError && error.has(NO_GIT_ACCESS)) throw new Fail(gitAccessHelp(repo.remote, accountId));
    throw error;
  }
  ctx.log(ok(`Created ${bold(project.name)}`, IN));
  ctx.log(`${IN}  ${dim(`Every push to ${plan.branch} now publishes to ${siteUrl(project)}`)}`);

  try {
    return await deployAndFollow(ctx, client, accountId, project, plan.branch, IN);
  } catch (error) {
    if (error instanceof ApiError) {
      throw new Fail(`The project exists, but the first build could not be started: ${error.message}\nPush a commit or run "flareship deploy".`);
    }
    throw error;
  }
}

async function deployCommand(ctx) {
  const { client, accountId } = await session(ctx);
  const project = await resolveProject(ctx, client, accountId);
  if (!project.source) throw new Fail(`${project.name} is not connected to a Git repository, so there is nothing to build.`);
  ctx.log('');
  return deployAndFollow(ctx, client, accountId, project, ctx.flags.branch || project.production_branch);
}

const STATE_MARK = {
  success: () => green(sym.ok),
  failure: () => red(sym.fail),
  canceled: () => yellow(sym.stop),
  running: () => cyan(sym.run),
};
const STATE_WORD = {
  success: () => green(`${sym.ok} live`),
  failure: () => red(`${sym.fail} last build failed`),
  canceled: () => yellow(`${sym.stop} last build canceled`),
  running: () => cyan(`${sym.run} building`),
};

function deploymentRows(deployments) {
  const fixed = 58;
  const room = Math.max(16, Math.min(60, columns() - fixed));
  return deployments.map((deployment) => {
    const meta = deployment.deployment_trigger?.metadata || {};
    const message = String(meta.commit_message || '').split('\n')[0];
    return [
      STATE_MARK[deploymentState(deployment)](),
      dim(deployment.short_id || ''),
      deployment.environment || '',
      truncate(meta.branch || '', 16),
      (meta.commit_hash || '').slice(0, 7),
      truncate(message, room),
      dim(ago(deployment.created_on)),
    ];
  });
}

async function statusCommand(ctx) {
  const { client, accountId } = await session(ctx);
  const project = await resolveProject(ctx, client, accountId);
  const deployments = await busy('Loading the latest deployments', () => client.listDeployments(accountId, project.name, 8));
  const build = project.build_config || {};
  const config = project.source?.config;
  const custom = (project.domains || []).filter((d) => d !== project.subdomain);
  const latest = deployments.find((d) => d.environment === 'production') || deployments[0];

  ctx.log('');
  ctx.log(`  ${bold(project.name)}${latest ? `  ${STATE_WORD[deploymentState(latest)]()}` : ''}`);
  ctx.log(`  ${cyan(siteUrl(project))}`);
  ctx.log('');
  const rows = [
    custom.length ? ['Domains', custom.join(', ')] : null,
    ['Repository', config ? `${project.source.type}.com/${config.owner}/${config.repo_name}` : dim('not connected (direct upload)')],
    ['Branch', project.production_branch],
    ['Build', build.build_command || dim('none')],
    ['Publish', build.destination_dir || 'the whole repository'],
  ];
  for (const line of fields(rows)) ctx.log(line);

  ctx.log('');
  if (!deployments.length) {
    ctx.log(dim('  No deployments yet.'));
  } else {
    const header = ['', 'id', 'target', 'branch', 'commit', 'message', 'when'];
    for (const line of table(deploymentRows(deployments), { header })) ctx.log(line);
    const previews = deployments.filter((d) => d.environment !== 'production' && d.url).slice(0, 3);
    if (previews.length) ctx.log('');
    for (const preview of previews) ctx.log(`  ${dim(`${preview.short_id}  ${preview.url}`)}`);
    ctx.log('');
    ctx.log(dim(`  flareship logs <id> prints a build log ${sym.dot} flareship deploy rebuilds`));
  }
  ctx.log('');
  return 0;
}

async function logsCommand(ctx) {
  const { client, accountId } = await session(ctx);
  const project = await resolveProject(ctx, client, accountId);
  const deployments = await busy('Loading the latest deployments', () => client.listDeployments(accountId, project.name, 20));
  const wanted = ctx.args[0];
  const deployment = wanted ? deployments.find((d) => d.id === wanted || d.short_id === wanted || d.id.startsWith(wanted)) : deployments[0];
  if (!deployment) throw new Fail(wanted ? `No recent deployment matches "${wanted}".` : `${project.name} has no deployments yet.`);

  if (ctx.flags.follow && deploymentState(deployment) === 'running') {
    const state = await tail(ctx, client, accountId, project.name, deployment.id);
    return state === 'success' ? 0 : 1;
  }
  const lines = await busy('Loading the build log', () => client.deploymentLogs(accountId, project.name, deployment.id));
  for (const entry of lines) ctx.log(entry.line);
  return 0;
}

async function listCommand(ctx) {
  const { client, accountId } = await session(ctx);
  const projects = await busy('Loading your projects', () => client.listProjects(accountId));
  ctx.log('');
  if (!projects.length) {
    ctx.log('  No Pages projects in this account yet. Run "flareship import" inside a repository.');
  } else {
    const rows = projects.map((project) => {
      const config = project.source?.config;
      const from = config ? `${project.source.type}.com/${config.owner}/${config.repo_name}` : dim('direct upload');
      return [bold(project.name), cyan(siteUrl(project)), from];
    });
    for (const line of table(rows, { header: ['project', 'address', 'source'], gap: 3 })) ctx.log(line);
    ctx.log('');
    ctx.log(dim(`  ${projects.length} project${projects.length === 1 ? '' : 's'}`));
  }
  ctx.log('');
  return 0;
}

function openInBrowser(url) {
  const wsl = process.platform === 'linux' && os.release().toLowerCase().includes('microsoft');
  const [command, args] =
    process.platform === 'win32' || wsl
      ? [wsl ? 'cmd.exe' : 'cmd', ['/c', 'start', '""', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {}
}

async function openCommand(ctx) {
  const { client, accountId } = await session(ctx);
  const project = await resolveProject(ctx, client, accountId);
  const url = siteUrl(project);
  ctx.log(url);
  if (!ctx.env.FLARESHIP_NO_BROWSER) openInBrowser(url);
  return 0;
}

async function browserLogin(ctx) {
  let token = await browserToken(ctx, { fresh: true });
  if (token) {
    ctx.log(`  Cloudflare is already signed in on this machine ${dim('(wrangler)')}`);
  } else {
    ctx.log('  Opening your browser to sign in to Cloudflare. Click "Allow" there.');
    ctx.log(dim('  The first time, this downloads Cloudflare\'s wrangler and can take a minute.'));
    if (!(await wranglerLogin(ctx.env))) throw new Fail('The browser sign-in did not finish. Run "flareship login" again, or use "flareship login --token".');
    token = await browserToken(ctx, { fresh: true });
    if (!token) throw new Fail('Signed in, but the session could not be read back. Try "flareship login --token".');
  }
  const client = createClient({ token, base: ctx.env.FLARESHIP_API_BASE });
  const accountId = ctx.env.CLOUDFLARE_ACCOUNT_ID || (await pickAccount(ctx, client));
  await busy('Checking access to Pages', () => client.listProjects(accountId));
  saveConfig({ auth: 'browser', accountId }, ctx.env);
  ctx.log(ok(`Signed in  ${dim(`${sym.dot}  account ${accountId}`)}`));
  return { client, accountId, source: 'browser' };
}

async function tokenLogin(ctx) {
  ctx.log(`  1. Open ${cyan(LINKS.tokens)}`);
  ctx.log('  2. Create Token -> Custom token -> Get started  (not one of the templates)');
  ctx.log('  3. Add exactly two permissions:');
  ctx.log('       Account | Cloudflare Pages | Edit');
  ctx.log('       Account | Account Settings | Read');
  ctx.log('  4. Account Resources: Include | your account -> Continue to summary');
  ctx.log('  5. Check that only those two permissions are listed -> Create Token -> copy it');
  const token = await askSecret('Paste the token (hidden)');
  if (!token) throw new Fail('No token entered.');

  const client = createClient({ token, base: ctx.env.FLARESHIP_API_BASE });
  await busy('Checking the token', () => client.verifyToken());
  ctx.log(ok('The token is valid'));

  let accountId = ctx.env.CLOUDFLARE_ACCOUNT_ID;
  if (!accountId) {
    const accounts = await client.listAccounts().catch(() => []);
    if (accounts.length === 1) {
      accountId = accounts[0].id;
      ctx.log(ok(`Using account ${bold(accounts[0].name)}`));
    } else {
      if (accounts.length > 1) for (const account of accounts) ctx.log(`  ${account.name} ${dim(account.id)}`);
      else {
        ctx.log('This token cannot find your account by itself (it lacks "Account Settings: Read").');
        ctx.log(`Open ${cyan(LINKS.accountHome)} and copy the address from the browser's address bar.`);
      }
      accountId = extractAccountId(await ask('Paste that address, or the Account ID'));
      if (!accountId) throw new Fail('That does not contain an Account ID (32 letters and digits).');
    }
  }

  try {
    await client.listProjects(accountId);
  } catch (error) {
    if (error instanceof ApiError) {
      throw new Fail(`The token works but cannot read Pages projects in that account: ${error.message}\nCheck the "Cloudflare Pages: Edit" permission and the Account ID.`);
    }
    throw error;
  }
  const file = saveConfig({ token, accountId }, ctx.env);
  ctx.log(ok(`Saved in ${file}`));
  return { client, accountId, source: 'token' };
}

function loginFlow(ctx) {
  return ctx.flags.token ? tokenLogin(ctx) : browserLogin(ctx);
}

async function loginCommand(ctx) {
  if (!ctx.interactive) throw new Fail('"flareship login" needs a terminal. In scripts, set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID.');
  if (ctx.env.FLARESHIP_NO_WRANGLER && !ctx.flags.token) throw new Fail('Browser sign-in is turned off (FLARESHIP_NO_WRANGLER). Use "flareship login --token".');
  ctx.log('');
  await loginFlow(ctx);
  ctx.log('');
  ctx.log(dim('  Next: run "flareship import" inside a repository.'));
  ctx.log('');
  return 0;
}

async function guideCommand(ctx) {
  ctx.log(GUIDE);
  return 0;
}

async function logoutCommand(ctx) {
  ctx.log('');
  clearSession(ctx.env);
  ctx.log(clearConfig(ctx.env) ? ok(`Removed ${configPath(ctx.env)}`) : '  Nothing was saved.');
  ctx.log(dim('  The Cloudflare browser sign-in belongs to wrangler. To end it too, run: npx wrangler logout'));
  ctx.log('');
  return 0;
}

async function whoamiCommand(ctx) {
  const { client, accountId, source } = await session(ctx);
  const projects = await busy('Loading your projects', () => client.listProjects(accountId));
  const how = { env: 'CLOUDFLARE_API_TOKEN', token: `API token saved in ${configPath(ctx.env)}`, browser: 'Cloudflare browser sign-in (wrangler)' }[source];
  ctx.log('');
  for (const line of fields([['Signed in', how], ['Account', accountId], ['Projects', String(projects.length)]])) ctx.log(line);
  ctx.log('');
  return 0;
}

export const commands = {
  import: importCommand,
  guide: guideCommand,
  deploy: deployCommand,
  status: statusCommand,
  logs: logsCommand,
  list: listCommand,
  open: openCommand,
  login: loginCommand,
  logout: logoutCommand,
  whoami: whoamiCommand,
};
