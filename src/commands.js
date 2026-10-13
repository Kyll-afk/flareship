import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ApiError, createClient } from './api.js';
import { clearConfig, configPath, loadConfig, saveConfig } from './config.js';
import { detect } from './detect.js';
import { Fail } from './errors.js';
import { readRepo } from './git.js';
import { ago, ask, askSecret, bold, confirm, cyan, dim, green, red, yellow } from './ui.js';

const NO_GIT_ACCESS = 8000011;
const TAIL_LIMIT_MS = 20 * 60 * 1000;

export const HELP = `flareship: connect a Git repository to Cloudflare Pages from the terminal

Usage
  flareship import            connect this repository and publish it, step by step
  flareship guide             print the full setup walkthrough with every link
  flareship status            show the project and its latest deployments
  flareship deploy            start a new deployment and follow the build
  flareship logs [id]         print a deployment's build log (latest by default)
  flareship open              open the live site in the browser
  flareship list              list every Pages project in the account
  flareship login             save a Cloudflare API token on this machine
  flareship logout            remove the saved token
  flareship whoami            show which token and account are in use

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
  CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are read from the environment
  and win over the values saved by "flareship login". The token needs the
  "Cloudflare Pages: Edit" permission.`;

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

2. Create a Cloudflare API token (once per machine)
   Open ${LINKS.tokens}
     Create Token -> Custom token -> Get started
     Permissions:        Account | Cloudflare Pages | Edit
     Account Resources:  Include | your account
     Continue to summary -> Create Token -> copy it (it is shown only once)
   Then run:  flareship login
   The Account ID it may ask for is on ${LINKS.accountHome}
   (right column, "Account details").

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

const step = (n, total, title) => `\n${bold(`[${n}/${total}]`)} ${bold(title)}`;
const siteUrl = (project) => `https://${project.subdomain || `${project.name}.pages.dev`}`;
const repoLabel = (remote) => `${remote.type}.com/${remote.owner}/${remote.repo}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function session(ctx) {
  const config = loadConfig(ctx.env);
  const token = ctx.env.CLOUDFLARE_API_TOKEN || config.token;
  if (!token) {
    if (!ctx.interactive) throw new Fail('No Cloudflare API token found. Run "flareship login" or set CLOUDFLARE_API_TOKEN.');
    ctx.log('No Cloudflare API token on this machine yet. Setting one up:');
    return loginFlow(ctx);
  }
  const client = createClient({ token, base: ctx.env.FLARESHIP_API_BASE });
  const accountId = ctx.env.CLOUDFLARE_ACCOUNT_ID || config.accountId || (await pickAccount(ctx, client));
  return { client, accountId };
}

async function pickAccount(ctx, client) {
  const accounts = await client.listAccounts();
  if (accounts.length === 1) return accounts[0].id;
  if (accounts.length === 0) {
    throw new Fail('This token cannot list accounts. Set CLOUDFLARE_ACCOUNT_ID or run "flareship login" and enter the account ID.');
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
  if (ctx.flags.name) return client.getProject(accountId, ctx.flags.name);
  const repo = requireRepo(ctx);
  const project = findProjectForRepo(await client.listProjects(accountId), repo.remote);
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

  if (found.name) ctx.log(`Detected ${bold(found.name)}${found.note ? dim(` (${found.note})`) : ''}`);
  else ctx.log('Could not detect how this project is built.');

  if (ctx.prompts) {
    plan.name = sanitizeName(await ask('Project name', plan.name));
    plan.branch = await ask('Production branch', plan.branch);
    plan.build = cleanBuild(await ask('Build command, or "none"', plan.build || 'none'));
    plan.out = cleanFolder(await ask('Folder to publish, or "." for the whole repository', plan.out || '.'));
  } else if (plan.build === null || plan.out === null) {
    throw new Fail('Could not detect the build settings. Pass --build "<command>" (or --build none) and --out <folder>.');
  }
  return plan;
}

function printPlan(ctx, repo, plan) {
  const row = (label, value) => ctx.log(`  ${dim(label.padEnd(9))} ${value}`);
  ctx.log('');
  row('project', bold(plan.name));
  row('repo', repoLabel(repo.remote));
  row('branch', `${plan.branch}${plan.previews ? dim('  (other branches get preview links)') : ''}`);
  if (plan.root) row('root', plan.root);
  row('build', plan.build || dim('none'));
  row('publish', plan.out || 'the whole repository');
  ctx.log('');
  if (!plan.out) ctx.log(yellow('warning') + ' no publish folder: every file in the repository will be public.');
  if (!repo.upstream) ctx.log(yellow('warning') + ' this branch has not been pushed. Cloudflare builds what is on the remote.');
  else if (repo.ahead > 0) ctx.log(yellow('warning') + ` ${repo.ahead} local commit(s) are not pushed yet and will not be in the first build.`);
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

async function tail(ctx, client, accountId, name, id) {
  const interval = Number(ctx.env.FLARESHIP_POLL_MS) || 3000;
  const started = Date.now();
  let printed = 0;
  const flush = async () => {
    let lines;
    try {
      lines = await client.deploymentLogs(accountId, name, id);
    } catch (error) {
      if (error instanceof ApiError) return;
      throw error;
    }
    for (const entry of lines.slice(printed)) ctx.log(dim('  | ') + entry.line);
    printed = Math.max(printed, lines.length);
  };

  for (;;) {
    await flush();
    const state = deploymentState(await client.getDeployment(accountId, name, id));
    if (state !== 'running') {
      await flush();
      return state;
    }
    if (Date.now() - started > TAIL_LIMIT_MS) return 'running';
    await sleep(interval);
  }
}

async function deployAndFollow(ctx, client, accountId, project, branch) {
  const deployment = await client.createDeployment(accountId, project.name, branch);
  ctx.log(`Building ${bold(project.name)} from ${branch}...`);
  const state = await tail(ctx, client, accountId, project.name, deployment.id);
  if (state === 'success') {
    const production = branch === project.production_branch;
    ctx.log(`${green('done')} ${production ? 'live at' : 'preview at'} ${cyan(production ? siteUrl(project) : deployment.url)}`);
    return 0;
  }
  if (state === 'running') {
    ctx.log(`${yellow('still building')} after 20 minutes. Check it with "flareship status".`);
    return 1;
  }
  throw new Fail(`The build ${state === 'canceled' ? 'was canceled' : 'failed'}. See the log above.`);
}

async function importCommand(ctx) {
  ctx.log(step(1, 4, 'Repository'));
  const repo = requireRepo(ctx);
  ctx.log(`${repoLabel(repo.remote)}${repo.branch ? dim(`  on ${repo.branch}`) : ''}`);

  ctx.log(step(2, 4, 'Cloudflare account'));
  const { client, accountId } = await session(ctx);
  ctx.log(`account ${dim(accountId)}`);

  const existing = findProjectForRepo(await client.listProjects(accountId), repo.remote);
  if (existing) {
    ctx.log(`${bold(existing.name)} is already connected to ${repoLabel(repo.remote)}.`);
    ctx.log(`Pushes to ${existing.production_branch} publish to ${cyan(siteUrl(existing))}`);
    return 0;
  }

  ctx.log(step(3, 4, 'Build settings'));
  const plan = await planImport(ctx, repo);
  printPlan(ctx, repo, plan);
  if (ctx.prompts && !(await confirm('Create this project?'))) {
    ctx.log('Nothing was created.');
    return 0;
  }

  ctx.log(step(4, 4, 'Create and publish'));
  let project;
  try {
    project = await client.createProject(accountId, {
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
    });
  } catch (error) {
    if (error instanceof ApiError && error.has(NO_GIT_ACCESS)) throw new Fail(gitAccessHelp(repo.remote, accountId));
    throw error;
  }
  ctx.log(`${green('created')} ${bold(project.name)}. Every push to ${plan.branch} now publishes to ${cyan(siteUrl(project))}`);

  try {
    return await deployAndFollow(ctx, client, accountId, project, plan.branch);
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
  return deployAndFollow(ctx, client, accountId, project, ctx.flags.branch || project.production_branch);
}

function describeDeployment(deployment) {
  const state = deploymentState(deployment);
  const mark = { success: green('ok  '), failure: red('fail'), canceled: yellow('stop'), running: cyan('run ') }[state];
  const meta = deployment.deployment_trigger?.metadata || {};
  const commit = (meta.commit_hash || '').slice(0, 7).padEnd(7);
  const env = (deployment.environment || '').padEnd(10);
  const branch = (meta.branch || '').padEnd(14).slice(0, 14);
  return `  ${mark} ${dim(deployment.short_id || '')}  ${env} ${branch} ${commit}  ${ago(deployment.created_on).padEnd(9)} ${deployment.url || ''}`;
}

async function statusCommand(ctx) {
  const { client, accountId } = await session(ctx);
  const project = await resolveProject(ctx, client, accountId);
  const build = project.build_config || {};
  const row = (label, value) => ctx.log(`  ${dim(label.padEnd(9))} ${value}`);

  ctx.log(`${bold(project.name)}  ${cyan(siteUrl(project))}`);
  const custom = (project.domains || []).filter((d) => d !== project.subdomain);
  if (custom.length) row('domains', custom.join(', '));
  if (project.source) {
    const config = project.source.config || {};
    row('repo', `${project.source.type}.com/${config.owner}/${config.repo_name}`);
  } else {
    row('repo', dim('not connected (direct upload)'));
  }
  row('branch', project.production_branch);
  row('build', build.build_command || dim('none'));
  row('publish', build.destination_dir || 'the whole repository');

  const deployments = await client.listDeployments(accountId, project.name, 8);
  ctx.log('');
  if (!deployments.length) ctx.log(dim('  no deployments yet'));
  for (const deployment of deployments) ctx.log(describeDeployment(deployment));
  return 0;
}

async function logsCommand(ctx) {
  const { client, accountId } = await session(ctx);
  const project = await resolveProject(ctx, client, accountId);
  const deployments = await client.listDeployments(accountId, project.name, 20);
  const wanted = ctx.args[0];
  const deployment = wanted ? deployments.find((d) => d.id === wanted || d.short_id === wanted || d.id.startsWith(wanted)) : deployments[0];
  if (!deployment) throw new Fail(wanted ? `No recent deployment matches "${wanted}".` : `${project.name} has no deployments yet.`);

  if (ctx.flags.follow && deploymentState(deployment) === 'running') {
    const state = await tail(ctx, client, accountId, project.name, deployment.id);
    return state === 'success' ? 0 : 1;
  }
  for (const entry of await client.deploymentLogs(accountId, project.name, deployment.id)) ctx.log(entry.line);
  return 0;
}

async function listCommand(ctx) {
  const { client, accountId } = await session(ctx);
  const projects = await client.listProjects(accountId);
  if (!projects.length) ctx.log('No Pages projects in this account yet.');
  for (const project of projects) {
    const config = project.source?.config;
    const from = config ? `${project.source.type}.com/${config.owner}/${config.repo_name}` : 'direct upload';
    ctx.log(`${bold(project.name.padEnd(28))} ${siteUrl(project).padEnd(44)} ${dim(from)}`);
  }
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

async function loginFlow(ctx) {
  ctx.log(`  1. Open ${cyan(LINKS.tokens)}`);
  ctx.log('  2. Create Token -> Custom token -> Permissions: Account | Cloudflare Pages | Edit');
  ctx.log('  3. Account Resources: Include | your account -> Continue to summary -> Create Token');
  ctx.log('  4. Copy the token (it is shown only once)');
  const token = await askSecret('Paste the token (hidden)');
  if (!token) throw new Fail('No token entered.');

  const client = createClient({ token, base: ctx.env.FLARESHIP_API_BASE });
  await client.verifyToken();
  ctx.log(`${green('ok')} the token is valid`);

  let accountId = ctx.env.CLOUDFLARE_ACCOUNT_ID;
  if (!accountId) {
    const accounts = await client.listAccounts().catch(() => []);
    if (accounts.length === 1) {
      accountId = accounts[0].id;
      ctx.log(`Using account ${bold(accounts[0].name)}`);
    } else {
      if (accounts.length > 1) for (const account of accounts) ctx.log(`  ${account.name} ${dim(account.id)}`);
      else ctx.log(`This token cannot list accounts. Copy the Account ID from ${cyan(LINKS.accountHome)} (right column).`);
      accountId = await ask('Account ID');
      if (!accountId) throw new Fail('No account ID entered.');
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
  ctx.log(`${green('saved')} ${file}`);
  return { client, accountId };
}

async function loginCommand(ctx) {
  if (!ctx.interactive) throw new Fail('"flareship login" needs a terminal. In scripts, set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID.');
  await loginFlow(ctx);
  ctx.log('Next: run "flareship import" inside a repository.');
  return 0;
}

async function guideCommand(ctx) {
  ctx.log(GUIDE);
  return 0;
}

async function logoutCommand(ctx) {
  ctx.log(clearConfig(ctx.env) ? `Removed ${configPath(ctx.env)}` : 'Nothing was saved.');
  return 0;
}

async function whoamiCommand(ctx) {
  const config = loadConfig(ctx.env);
  const fromEnv = Boolean(ctx.env.CLOUDFLARE_API_TOKEN);
  const { client, accountId } = await session(ctx);
  const projects = await client.listProjects(accountId);
  ctx.log(`token    ${fromEnv ? 'CLOUDFLARE_API_TOKEN' : configPath(ctx.env)}`);
  ctx.log(`account  ${accountId}${ctx.env.CLOUDFLARE_ACCOUNT_ID ? '' : config.accountId ? '' : dim('  (the only one this token can see)')}`);
  ctx.log(`projects ${projects.length}`);
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
