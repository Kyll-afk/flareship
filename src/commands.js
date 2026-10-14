import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ApiError, createClient, isAuthError } from './api.js';
import { clearConfig, clearSession, configPath, loadConfig, loadSession, saveConfig, saveSession } from './config.js';
import { detect, readWranglerConfig } from './detect.js';
import { Fail } from './errors.js';
import { readRepo } from './git.js';
import { githubRepo } from './github.js';
import { ago, bold, busy, columns, cyan, dim, fields, green, red, spinner, sym, table, truncate, yellow } from './ui.js';

const NO_GIT_ACCESS = [8000011, 8000012];
const TAIL_LIMIT_MS = 20 * 60 * 1000;
const SESSION_TTL_MS = 50 * 60 * 1000;
const PAGES_STAGES = {
  queued: 'Waiting in the build queue',
  initialize: 'Preparing the build machine',
  clone_repo: 'Cloning the repository',
  build: 'Building the site',
  deploy: 'Publishing to Cloudflare',
};
const WORKER_STAGES = {
  queued: 'Waiting in the build queue',
  initializing: 'Preparing the build machine',
  running: 'Building and deploying the Worker',
};

export const HELP = `flareship: connect a Git repository to Cloudflare Pages or Workers from the terminal

Usage
  flareship import            connect this repository and publish it, step by step
  flareship guide             print the full setup walkthrough with every link
  flareship status            show the project and its latest builds
  flareship deploy            start a new build and follow it
  flareship logs [id]         print a build log (latest by default)
  flareship open              open the live site in the browser
  flareship list              list every Pages project and Worker in the account
  flareship login             sign in to Cloudflare through the browser
  flareship login --token     use an API token instead (Workers, scripts, CI)
  flareship logout            forget the saved account or token
  flareship whoami            show how you are signed in and to which account

Options
  --name <name>       project name (default: the repository or Worker name)
  --build <command>   build command ("none" for no build step)
  --out <folder>      folder to publish after the build (Pages)
  --root <folder>     folder to build from, for monorepos
  --branch <branch>   production branch (import) or branch to deploy (deploy)
  --no-previews       do not build previews for other branches
  --workers           treat the project as a Worker
  --pages             treat the project as a Pages project
  -y, --yes           accept the detected settings without asking
  -f, --follow        keep following a running build (logs)
  -h, --help          show this help
  -v, --version       show the version

Pages or Workers
  A repository with a wrangler.toml / wrangler.jsonc is imported as a Worker;
  anything else as a Pages project. --workers and --pages override that.

Authentication
  "flareship login" opens the browser (Cloudflare's own wrangler sign-in): no
  token to create and no Account ID to copy. That is enough for Pages.
  Workers builds need an API token, because Cloudflare does not let the browser
  sign-in use that API: run "flareship login --token". In scripts, set
  CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID.`;

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

export function buildState(build) {
  if (build.status !== 'stopped') return 'running';
  if (build.build_outcome === 'success') return 'success';
  if (build.build_outcome === 'cancelled' || build.build_outcome === 'skipped') return 'canceled';
  return 'failure';
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

const TOKEN_PERMISSIONS = [
  'Account | Cloudflare Pages             | Edit   (Pages projects)',
  'Account | Workers Builds Configuration | Edit   (Workers)',
  'Account | Workers Scripts              | Edit   (Workers)',
  'Account | Account Settings             | Read   (finds your account by itself)',
];

const WORKERS_TOKEN_HELP = [
  'Workers builds need an API token: Cloudflare does not let the browser sign-in use that API.',
  '',
  `Create one at ${LINKS.tokens}`,
  '  Create Token -> Custom token -> Get started, with these permissions:',
  ...TOKEN_PERMISSIONS.map((line) => `    ${line}`),
  '  Account Resources: Include | your account',
  '',
  'Then run "flareship login --token" and paste it. Pages keeps working with the same token.',
].join('\n');

export const GUIDE = `flareship setup, step by step

1. Put the project on GitHub (or GitLab)
   Cloudflare builds what is on the remote, not what is on your machine.
     git remote -v        must show an "origin" on github.com or gitlab.com
     git push -u origin main

2. Sign in to Cloudflare (once per machine)
   Pages:    flareship login
             Your browser opens on Cloudflare: click "Allow". No token to create
             and no Account ID to copy. If wrangler is already signed in on this
             machine you can skip this step.
   Workers:  flareship login --token
             Cloudflare does not let the browser sign-in manage Workers builds,
             so a Worker needs an API token. Create it at
             ${LINKS.tokens}
             (Create Token -> Custom token) with these permissions:
${TOKEN_PERMISSIONS.map((line) => `               ${line}`).join('\n')}
             The same token also works for Pages, and for scripts and CI.

3. Let Cloudflare read the repository (once per repository, or once for all)
   First time ever: open ${LINKS.connectGit()}
     Import an existing Git repository -> Connect GitHub -> pick the repositories
     You can close the page once the repository shows up in the list.
   Later repositories: open ${LINKS.githubApp}
     Cloudflare Workers and Pages -> Configure -> add the repository,
     or choose "All repositories" so you never have to do this again.

4. Import the project
   Inside the repository run:  flareship import
   A repository with a wrangler.toml / wrangler.jsonc becomes a Worker, anything
   else a Pages project (--workers and --pages override). It detects the build,
   asks you to confirm, connects the repository, starts the first build and
   prints the live address.

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

async function browserToken(ctx, { fresh = false } = {}) {
  if (!fresh) {
    const cached = loadSession(ctx.env);
    if (cached.token && Date.now() - cached.savedAt < SESSION_TTL_MS) return cached.token;
  }
  const token = await busy('Checking the Cloudflare sign-in', () => ctx.deps.wranglerToken(ctx.env));
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
  const choice = Number(await ctx.deps.ask('Which one', '1'));
  const account = accounts[choice - 1];
  if (!account) throw new Fail('That is not one of the listed accounts.');
  return account.id;
}

function requireBuildsAccess(source) {
  if (source === 'browser') throw new Fail(WORKERS_TOKEN_HELP);
}

function requireRepo(ctx) {
  const repo = readRepo(ctx.cwd);
  if (!repo) throw new Fail('This folder is not inside a Git repository.');
  if (!repo.remoteUrl) throw new Fail('This repository has no "origin" remote. Push it to GitHub or GitLab first.');
  if (!repo.remote) throw new Fail(`Cloudflare can only connect to GitHub or GitLab, and origin is ${repo.remoteUrl}`);
  return repo;
}

function pagesTarget({ client, accountId }, project) {
  return {
    kind: 'pages',
    name: project.name,
    project,
    url: siteUrl(project),
    productionBranch: project.production_branch,
    connected: Boolean(project.source),
    async start(branch) {
      const deployment = await client.createDeployment(accountId, project.name, branch);
      return { id: deployment.id, url: deployment.url };
    },
    logs: (id) => client.deploymentLogs(accountId, project.name, id),
    async poll(id) {
      const deployment = await client.getDeployment(accountId, project.name, id);
      return { state: deploymentState(deployment), label: PAGES_STAGES[deployment.latest_stage?.name] };
    },
  };
}

async function workerTarget(s, script, { builds = true } = {}) {
  const { client, accountId, source } = s;
  if (builds) requireBuildsAccess(source);
  const [config, subdomain] = await busy('Loading the Worker', () =>
    Promise.all([
      builds ? client.getWorkerBuildConfig(accountId, script.tag) : null,
      client.workersSubdomain(accountId).catch(() => null),
    ]),
  );
  return {
    kind: 'worker',
    name: script.id,
    tag: script.tag,
    config,
    url: subdomain ? `https://${script.id}.${subdomain}.workers.dev` : null,
    productionBranch: config?.git_repository?.branch || null,
    connected: Boolean(config),
    async start(branch) {
      const triggers = await client.listTriggers(accountId, script.tag);
      const live = triggers.filter((t) => !t.deleted_on);
      const trigger =
        live.find((t) => (t.branch_includes || []).includes(branch)) ||
        live.find((t) => (t.branch_includes || []).includes('*') && !(t.branch_excludes || []).includes(branch));
      if (!trigger) throw new Fail(`${script.id} has no build trigger for the branch "${branch}".`);
      const build = await client.startBuild(accountId, trigger.trigger_uuid, branch);
      return { id: build.build_uuid, url: build.preview_url || null };
    },
    logs: (id) => client.buildLogs(accountId, id),
    async poll(id) {
      const build = await client.getBuild(accountId, id);
      return { state: buildState(build), label: WORKER_STAGES[build.status] };
    },
  };
}

function wranglerConfigFor(ctx, repo) {
  return readWranglerConfig(path.join(repo.root, cleanFolder(ctx.flags.root)));
}

async function resolveTarget(ctx, s, options) {
  const { client, accountId } = s;
  const { flags } = ctx;

  if (flags.name) {
    let pagesError = null;
    if (!flags.workers) {
      try {
        return pagesTarget(s, await busy('Loading the project', () => client.getProject(accountId, flags.name)));
      } catch (error) {
        if (!(error instanceof ApiError) || isAuthError(error) || flags.pages) throw error;
        pagesError = error;
      }
    }
    const scripts = await busy('Loading your Workers', () => client.listScripts(accountId));
    const script = scripts.find((x) => x.id === flags.name);
    if (script) return workerTarget(s, script, options);
    throw pagesError || new Fail(`No Worker is called "${flags.name}".`);
  }

  const repo = requireRepo(ctx);
  if (!flags.workers) {
    const projects = await busy('Loading your projects', () => client.listProjects(accountId));
    const project = findProjectForRepo(projects, repo.remote);
    if (project) return pagesTarget(s, project);
  }
  if (!flags.pages) {
    const config = wranglerConfigFor(ctx, repo);
    if (config?.name && !config.pages) {
      const scripts = await busy('Loading your Workers', () => client.listScripts(accountId));
      const script = scripts.find((x) => x.id === config.name);
      if (script) return workerTarget(s, script, options);
    }
  }
  throw new Fail(`Nothing on Cloudflare is connected to ${repoLabel(repo.remote)} yet. Run "flareship import" first.`);
}

function gitAccessHelp(remote, accountId) {
  const cannotSee = `Cloudflare cannot see ${repoLabel(remote)}: it has no access to it, or it is not pushed yet.`;
  if (remote.type !== 'github') {
    return [cannotSee, `Connect GitLab once at ${LINKS.connectGit(accountId)} and run this again.`].join('\n');
  }
  return [
    cannotSee,
    'Nothing was created.',
    '',
    'If Cloudflare is already connected to your GitHub account, add this repository:',
    `  ${LINKS.githubApp}  ->  Cloudflare Workers and Pages  ->  Configure`,
    'If it was never connected, do it once here ("Import an existing Git repository" -> "Connect GitHub"):',
    `  ${LINKS.connectGit(accountId)}`,
    '',
    'Then run "flareship import" again.',
  ].join('\n');
}

async function tail(ctx, target, id, indent = '  ') {
  const interval = Number(ctx.env.FLARESHIP_POLL_MS) || 3000;
  const limit = Number(ctx.env.FLARESHIP_TAIL_LIMIT_MS) || TAIL_LIMIT_MS;
  const started = Date.now();
  const progress = spinner('Waiting for the build to start');
  let printed = 0;
  const flush = async () => {
    let lines;
    try {
      lines = await target.logs(id);
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
      const { state, label } = await target.poll(id);
      if (state !== 'running') {
        await flush();
        return state;
      }
      progress.text(label || 'Building');
      if (Date.now() - started > limit) return 'running';
      await sleep(interval);
    }
  } finally {
    progress.stop();
  }
}

async function deployAndFollow(ctx, target, branch, indent = '  ') {
  const build = await busy('Starting the build', () => target.start(branch));
  ctx.log(`${indent}Building ${bold(target.name)} from ${branch}`);
  const state = await tail(ctx, target, build.id, indent);
  if (state === 'success') {
    const production = branch === target.productionBranch;
    const url = production ? target.url : build.url;
    ctx.log(ok(url ? `${production ? 'Live at' : 'Preview at'} ${cyan(url)}` : 'Deployed', indent));
    ctx.log('');
    return 0;
  }
  if (state === 'running') {
    ctx.log(warn('Still building after a long wait. Check it with "flareship status".', indent));
    ctx.log('');
    return 1;
  }
  throw new Fail(`The build ${state === 'canceled' ? 'was canceled' : 'failed'}. See the log above.`);
}

function alreadyConnected(ctx, target, repo) {
  ctx.log('');
  ctx.log(ok(`${bold(target.name)} is already connected to ${repoLabel(repo.remote)}`));
  if (target.url) ctx.log(`    Pushes to ${target.productionBranch} publish to ${cyan(target.url)}`);
  ctx.log('');
  return 0;
}

function pushWarnings(repo) {
  if (!repo.upstream) return ['This branch has not been pushed. Cloudflare builds what is on the remote.'];
  if (repo.ahead > 0) return [`${repo.ahead} local commit(s) are not pushed yet and will not be in the first build.`];
  return [];
}

function printPlan(ctx, rows, warnings) {
  ctx.log('');
  for (const line of fields(rows, IN.length)) ctx.log(line);
  if (warnings.length) ctx.log('');
  for (const warning of warnings) ctx.log(warn(warning, IN));
}

async function confirmPlan(ctx, question) {
  if (!ctx.prompts) return true;
  ctx.log('');
  if (await ctx.deps.confirm(`${IN}${question}`)) return true;
  ctx.log(`${IN}Nothing was created.`);
  return false;
}

async function firstBuild(ctx, target, branch) {
  try {
    return await deployAndFollow(ctx, target, branch, IN);
  } catch (error) {
    if (error instanceof ApiError) {
      throw new Fail(`The project exists, but the first build could not be started: ${error.message}\nPush a commit or run "flareship deploy".`);
    }
    throw error;
  }
}

async function importPages(ctx, s, repo) {
  const { client, accountId } = s;
  const { flags } = ctx;

  ctx.log(step(3, 4, 'Build settings'));
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
    plan.name = sanitizeName(await ctx.deps.ask(`${IN}Project name`, plan.name));
    plan.branch = await ctx.deps.ask(`${IN}Production branch`, plan.branch);
    plan.build = cleanBuild(await ctx.deps.ask(`${IN}Build command, or "none"`, plan.build || 'none'));
    plan.out = cleanFolder(await ctx.deps.ask(`${IN}Folder to publish, or "." for the whole repository`, plan.out || '.'));
  } else if (plan.build === null || plan.out === null) {
    throw new Fail('Could not detect the build settings. Pass --build "<command>" (or --build none) and --out <folder>.');
  }

  printPlan(
    ctx,
    [
      ['Pages project', bold(plan.name)],
      ['Repository', repoLabel(repo.remote)],
      ['Branch', `${plan.branch}${plan.previews ? dim(`  ${sym.dot}  other branches get preview links`) : ''}`],
      plan.root ? ['Root', plan.root] : null,
      ['Build', plan.build || dim('none')],
      ['Publish', plan.out || 'the whole repository'],
    ],
    [...(plan.out ? [] : ['No publish folder: every file in the repository will be public.']), ...pushWarnings(repo)],
  );
  if (!(await confirmPlan(ctx, 'Create this project?'))) return 0;

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
    if (error instanceof ApiError && NO_GIT_ACCESS.some((code) => error.has(code))) throw new Fail(gitAccessHelp(repo.remote, accountId));
    throw error;
  }
  ctx.log(ok(`Created ${bold(project.name)}`, IN));
  ctx.log(`${IN}  ${dim(`Every push to ${plan.branch} now publishes to ${siteUrl(project)}`)}`);
  return firstBuild(ctx, pagesTarget(s, project), plan.branch);
}

async function importWorker(ctx, s, repo, config) {
  const { client, accountId, source } = s;
  const { flags } = ctx;
  requireBuildsAccess(source);
  if (repo.remote.type !== 'github') throw new Fail('flareship can only connect Workers to GitHub repositories for now. Use --pages, or connect it in the dashboard.');

  ctx.log(step(3, 4, 'Build settings'));
  if (!config) {
    throw new Fail(
      [
        'A Worker needs a wrangler configuration file in the repository, and none was found.',
        'For a static site, commit a wrangler.jsonc like this one and push it:',
        '  { "name": "my-site", "compatibility_date": "2025-01-01", "assets": { "directory": "./dist" } }',
        'Or import it as a Pages project with: flareship import --pages',
      ].join('\n'),
    );
  }
  if (!config.name) throw new Fail(`${config.file} has no "name". Cloudflare needs it to match the Worker's name.`);
  if (flags.name && flags.name !== config.name) {
    throw new Fail(`The Worker must be named "${config.name}", the name in ${config.file}, or its builds will fail. Change it there.`);
  }

  const scripts = await busy('Loading your Workers', () => client.listScripts(accountId));
  let script = scripts.find((x) => x.id === config.name);
  if (script) {
    const target = await workerTarget(s, script);
    if (target.connected) return alreadyConnected(ctx, target, repo);
  }

  const root = cleanFolder(flags.root);
  const found = detect(path.join(repo.root, root));
  const plan = {
    name: config.name,
    branch: flags.branch ?? repo.defaultBranch ?? repo.branch ?? 'main',
    build: flags.build !== undefined ? cleanBuild(flags.build) : found.build || '',
    root,
    previews: !flags['no-previews'],
  };
  ctx.log(`${IN}Worker ${bold(plan.name)}${dim(`  ${sym.dot}  from ${config.file}`)}`);
  if (flags.out !== undefined) ctx.log(warn('--out is ignored for Workers: the published folder comes from the wrangler configuration.', IN));

  if (ctx.prompts) {
    ctx.log('');
    plan.branch = await ctx.deps.ask(`${IN}Production branch`, plan.branch);
    plan.build = cleanBuild(await ctx.deps.ask(`${IN}Build command, or "none"`, plan.build || 'none'));
  }

  const tokens = await busy('Looking for a build token', () => client.listBuildTokens(accountId));
  if (!tokens.length) {
    throw new Fail(
      [
        'This account has no Workers build token yet, and only the dashboard can create the first one.',
        `Open ${LINKS.accountHome}, connect any Worker to a repository once (Settings -> Builds -> Connect),`,
        'then run "flareship import" again.',
      ].join('\n'),
    );
  }
  const buildToken = tokens[0];

  printPlan(
    ctx,
    [
      ['Worker', `${bold(plan.name)}${script ? '' : dim(`  ${sym.dot}  will be created`)}`],
      ['Repository', repoLabel(repo.remote)],
      ['Branch', `${plan.branch}${plan.previews ? dim(`  ${sym.dot}  other branches get previews`) : ''}`],
      plan.root ? ['Root', plan.root] : null,
      ['Build', plan.build || dim('none')],
      ['Deploy', 'npx wrangler deploy'],
      ['Build token', buildToken.build_token_name || buildToken.build_token_uuid],
    ],
    pushWarnings(repo),
  );
  if (!(await confirmPlan(ctx, 'Connect this Worker?'))) return 0;

  ctx.log(step(4, 4, 'Create and publish'));
  const github = await busy('Reading the repository from GitHub', () => githubRepo(repo.remote, { env: ctx.env, cwd: ctx.cwd }));
  if (!script) {
    await busy('Creating the Worker', () => client.createPlaceholderWorker(accountId, plan.name));
    script = (await busy('Creating the Worker', () => client.listScripts(accountId))).find((x) => x.id === plan.name);
    if (!script) throw new Fail(`The Worker "${plan.name}" was created but could not be read back. Run "flareship import" again.`);
    ctx.log(ok(`Created the Worker ${bold(plan.name)}`, IN));
  }

  const settings = (deployCommand) => ({
    build_command: plan.build,
    deploy_command: deployCommand,
    root_directory: plan.root ? `/${plan.root}` : '/',
    build_caching_enabled: true,
    path_includes: ['*'],
    path_excludes: [],
    build_token_uuid: buildToken.build_token_uuid,
  });
  await busy('Connecting the repository', () =>
    client.createWorkerBuildConfig(accountId, {
      script_tag: script.tag,
      git_repository: {
        provider_type: 'github',
        provider_account_id: github.ownerId,
        provider_account_name: github.ownerName,
        repo_id: github.repoId,
        repo_name: github.repoName,
        branch: plan.branch,
      },
      production_settings: settings('npx wrangler deploy'),
      previews_enabled: plan.previews,
      previews_base_config: settings('npx wrangler preview'),
    }),
  );
  const target = await workerTarget(s, script);
  ctx.log(ok(`Connected ${bold(plan.name)} to ${repoLabel(repo.remote)}`, IN));
  if (target.url) ctx.log(`${IN}  ${dim(`Every push to ${plan.branch} now publishes to ${target.url}`)}`);
  return firstBuild(ctx, target, plan.branch);
}

async function importCommand(ctx) {
  const { flags } = ctx;
  if (flags.workers && flags.pages) throw new Fail('Use --workers or --pages, not both.');

  ctx.log(step(1, 4, 'Repository'));
  const repo = requireRepo(ctx);
  ctx.log(`${IN}${repoLabel(repo.remote)}${repo.branch ? dim(`  ${sym.dot}  ${repo.branch}`) : ''}`);

  ctx.log(step(2, 4, 'Cloudflare account'));
  const s = await session(ctx);
  ctx.log(`${IN}${s.accountId}`);

  if (!flags.workers) {
    const projects = await busy('Checking whether this repository is already connected', () => s.client.listProjects(s.accountId));
    const existing = findProjectForRepo(projects, repo.remote);
    if (existing) return alreadyConnected(ctx, pagesTarget(s, existing), repo);
  }

  const config = wranglerConfigFor(ctx, repo);
  const asWorker = flags.workers || (!flags.pages && Boolean(config) && !config.pages);
  return asWorker ? importWorker(ctx, s, repo, config) : importPages(ctx, s, repo);
}

async function deployCommand(ctx) {
  const s = await session(ctx);
  const target = await resolveTarget(ctx, s);
  if (!target.connected) throw new Fail(`${target.name} is not connected to a Git repository, so there is nothing to build.`);
  ctx.log('');
  return deployAndFollow(ctx, target, ctx.flags.branch || target.productionBranch);
}

function buildRows(items) {
  const room = Math.max(16, Math.min(60, columns() - 58));
  return items.map((item) => [
    STATE_MARK[item.state](),
    dim(item.id),
    item.target,
    truncate(item.branch || '', 16),
    (item.commit || '').slice(0, 7),
    truncate(String(item.message || '').split('\n')[0], room),
    dim(ago(item.when)),
  ]);
}

function printBuilds(ctx, items, previews = []) {
  ctx.log('');
  if (!items.length) {
    ctx.log(dim('  No builds yet.'));
  } else {
    const header = ['', 'id', 'target', 'branch', 'commit', 'message', 'when'];
    for (const line of table(buildRows(items), { header })) ctx.log(line);
    if (previews.length) ctx.log('');
    for (const preview of previews) ctx.log(`  ${dim(`${preview.id}  ${preview.url}`)}`);
    ctx.log('');
    ctx.log(dim(`  flareship logs <id> prints a build log ${sym.dot} flareship deploy rebuilds`));
  }
  ctx.log('');
}

async function pagesStatus(ctx, { client, accountId }, target) {
  const { project } = target;
  const deployments = await busy('Loading the latest deployments', () => client.listDeployments(accountId, project.name, 8));
  const build = project.build_config || {};
  const config = project.source?.config;
  const custom = (project.domains || []).filter((d) => d !== project.subdomain);
  const latest = deployments.find((d) => d.environment === 'production') || deployments[0];

  ctx.log('');
  ctx.log(`  ${bold(project.name)}  ${dim('Pages')}${latest ? `  ${STATE_WORD[deploymentState(latest)]()}` : ''}`);
  ctx.log(`  ${cyan(target.url)}`);
  ctx.log('');
  const rows = [
    custom.length ? ['Domains', custom.join(', ')] : null,
    ['Repository', config ? `${project.source.type}.com/${config.owner}/${config.repo_name}` : dim('not connected (direct upload)')],
    ['Branch', project.production_branch],
    ['Build', build.build_command || dim('none')],
    ['Publish', build.destination_dir || 'the whole repository'],
  ];
  for (const line of fields(rows)) ctx.log(line);

  const items = deployments.map((d) => {
    const meta = d.deployment_trigger?.metadata || {};
    return {
      state: deploymentState(d),
      id: d.short_id || '',
      target: d.environment || '',
      branch: meta.branch,
      commit: meta.commit_hash,
      message: meta.commit_message,
      when: d.created_on,
    };
  });
  const previews = deployments.filter((d) => d.environment !== 'production' && d.url).slice(0, 3).map((d) => ({ id: d.short_id, url: d.url }));
  printBuilds(ctx, items, previews);
  return 0;
}

function workerBuildItems(builds, productionBranch) {
  return builds.map((b) => {
    const meta = b.build_trigger_metadata || {};
    return {
      state: buildState(b),
      id: (b.build_uuid || '').slice(0, 8),
      target: !productionBranch || meta.branch === productionBranch ? 'production' : 'preview',
      branch: meta.branch,
      commit: meta.commit_hash,
      message: meta.commit_message || (meta.build_trigger_source === 'push' ? '' : `started by ${meta.build_trigger_source || 'hand'}`),
      when: b.created_on,
    };
  });
}

async function workerStatus(ctx, { client, accountId }, target) {
  const builds = target.connected ? await busy('Loading the latest builds', () => client.listWorkerBuilds(accountId, target.tag, 8)) : [];
  const repo = target.config?.git_repository;
  const settings = target.config?.production_settings || {};
  const latest = builds.find((b) => (b.build_trigger_metadata?.branch || '') === target.productionBranch) || builds[0];

  ctx.log('');
  ctx.log(`  ${bold(target.name)}  ${dim('Worker')}${latest ? `  ${STATE_WORD[buildState(latest)]()}` : ''}`);
  if (target.url) ctx.log(`  ${cyan(target.url)}`);
  ctx.log('');
  const rows = target.connected
    ? [
        ['Repository', `${repo.provider_type}.com/${repo.provider_account_name}/${repo.repo_name}`],
        ['Branch', `${repo.branch}${target.config.previews_enabled ? dim(`  ${sym.dot}  previews on`) : ''}`],
        settings.root_directory && settings.root_directory !== '/' ? ['Root', settings.root_directory] : null,
        ['Build', settings.build_command || dim('none')],
        ['Deploy', settings.deploy_command || dim('none')],
      ]
    : [['Repository', dim('not connected to Git')]];
  for (const line of fields(rows)) ctx.log(line);
  printBuilds(ctx, workerBuildItems(builds, target.productionBranch));
  return 0;
}

async function statusCommand(ctx) {
  const s = await session(ctx);
  const target = await resolveTarget(ctx, s);
  return target.kind === 'pages' ? pagesStatus(ctx, s, target) : workerStatus(ctx, s, target);
}

async function logsCommand(ctx) {
  const s = await session(ctx);
  const { client, accountId } = s;
  const target = await resolveTarget(ctx, s);
  const wanted = ctx.args[0];

  let builds;
  if (target.kind === 'pages') {
    const deployments = await busy('Loading the latest deployments', () => client.listDeployments(accountId, target.name, 20));
    builds = deployments.map((d) => ({ id: d.id, short: d.short_id, running: deploymentState(d) === 'running' }));
  } else {
    const list = await busy('Loading the latest builds', () => client.listWorkerBuilds(accountId, target.tag, 20));
    builds = list.map((b) => ({ id: b.build_uuid, short: (b.build_uuid || '').slice(0, 8), running: buildState(b) === 'running' }));
  }
  const build = wanted ? builds.find((b) => b.id === wanted || b.short === wanted || b.id.startsWith(wanted)) : builds[0];
  if (!build) throw new Fail(wanted ? `No recent build matches "${wanted}".` : `${target.name} has no builds yet.`);

  if (ctx.flags.follow && build.running) {
    const state = await tail(ctx, target, build.id);
    return state === 'success' ? 0 : 1;
  }
  const lines = await busy('Loading the build log', () => target.logs(build.id));
  for (const entry of lines) ctx.log(entry.line);
  return 0;
}

async function listCommand(ctx) {
  const s = await session(ctx);
  const { client, accountId, source } = s;
  const failures = [];
  const orEmpty = (error) => {
    if (!isAuthError(error)) throw error;
    failures.push(error);
    return [];
  };
  const [projects, scripts, subdomain] = await busy('Loading your projects', () =>
    Promise.all([
      client.listProjects(accountId).catch(orEmpty),
      client.listScripts(accountId).catch(orEmpty),
      client.workersSubdomain(accountId).catch(() => null),
    ]),
  );
  if (failures.length === 2) throw failures[0];

  const rows = projects.map((project) => {
    const config = project.source?.config;
    const from = config ? `${project.source.type}.com/${config.owner}/${config.repo_name}` : dim('direct upload');
    return [bold(project.name), 'Pages', cyan(siteUrl(project)), from];
  });
  const canReadBuilds = source !== 'browser';
  const configs = canReadBuilds
    ? await busy('Loading your Workers', () => Promise.all(scripts.slice(0, 30).map((x) => client.getWorkerBuildConfig(accountId, x.tag).catch(() => undefined))))
    : [];
  scripts.forEach((script, i) => {
    const repo = configs[i]?.git_repository;
    const from = repo
      ? `${repo.provider_type}.com/${repo.provider_account_name}/${repo.repo_name}`
      : dim(canReadBuilds && configs[i] === null ? 'not connected to Git' : 'unknown without an API token');
    rows.push([bold(script.id), 'Worker', subdomain ? cyan(`https://${script.id}.${subdomain}.workers.dev`) : '', from]);
  });

  ctx.log('');
  if (!rows.length) {
    ctx.log('  Nothing in this account yet. Run "flareship import" inside a repository.');
  } else {
    for (const line of table(rows, { header: ['name', 'type', 'address', 'source'], gap: 3 })) ctx.log(line);
    ctx.log('');
    ctx.log(dim(`  ${projects.length} Pages project${projects.length === 1 ? '' : 's'} ${sym.dot} ${scripts.length} Worker${scripts.length === 1 ? '' : 's'}`));
  }
  ctx.log('');
  return 0;
}

export function openInBrowser(url, { platform = process.platform, release = os.release(), spawnImpl = spawn } = {}) {
  const wsl = platform === 'linux' && release.toLowerCase().includes('microsoft');
  const [command, args] =
    platform === 'win32' || wsl
      ? [wsl ? 'cmd.exe' : 'cmd', ['/c', 'start', '""', url]]
      : platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  try {
    const child = spawnImpl(command, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {}
}

async function openCommand(ctx) {
  const s = await session(ctx);
  const target = await resolveTarget(ctx, s, { builds: false });
  if (!target.url) throw new Fail(`${target.name} has no public address: this account has no workers.dev subdomain.`);
  ctx.log(target.url);
  if (!ctx.env.FLARESHIP_NO_BROWSER) ctx.deps.open(target.url);
  return 0;
}

async function browserLogin(ctx) {
  let token = await browserToken(ctx, { fresh: true });
  if (token) {
    ctx.log(`  Cloudflare is already signed in on this machine ${dim('(wrangler)')}`);
  } else {
    ctx.log('  Opening your browser to sign in to Cloudflare. Click "Allow" there.');
    ctx.log(dim("  The first time, this downloads Cloudflare's wrangler and can take a minute."));
    if (!(await ctx.deps.wranglerLogin(ctx.env))) throw new Fail('The browser sign-in did not finish. Run "flareship login" again, or use "flareship login --token".');
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
  ctx.log('  3. Add only the permissions you need from this list:');
  for (const line of TOKEN_PERMISSIONS) ctx.log(`       ${line}`);
  ctx.log('  4. Account Resources: Include | your account -> Continue to summary');
  ctx.log('  5. Check that only those permissions are listed -> Create Token -> copy it');
  const token = await ctx.deps.askSecret('  Paste the token (hidden)');
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
        ctx.log('  This token cannot find your account by itself (it lacks "Account Settings: Read").');
        ctx.log(`  Open ${cyan(LINKS.accountHome)} and copy the address from the browser's address bar.`);
      }
      accountId = extractAccountId(await ctx.deps.ask('  Paste that address, or the Account ID'));
      if (!accountId) throw new Fail('That does not contain an Account ID (32 letters and digits).');
    }
  }

  const can = await busy('Checking what the token can do', async () => ({
    pages: await client.listProjects(accountId).then(() => true, () => false),
    workers: await client.listBuildTokens(accountId).then(() => true, () => false),
  }));
  if (!can.pages && !can.workers) {
    throw new Fail('The token works but can manage neither Pages projects nor Workers builds in that account.\nCheck its permissions and the Account ID.');
  }
  ctx.log(can.pages ? ok('Can manage Pages projects') : warn('Cannot manage Pages projects (no "Cloudflare Pages: Edit")'));
  ctx.log(can.workers ? ok('Can manage Workers builds') : warn('Cannot manage Workers builds (no "Workers Builds Configuration: Edit")'));
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
  clearSession(ctx.env);
  ctx.log('');
  ctx.log(clearConfig(ctx.env) ? ok(`Removed ${configPath(ctx.env)}`) : '  Nothing was saved.');
  ctx.log(dim('  The Cloudflare browser sign-in belongs to wrangler. To end it too, run: npx wrangler logout'));
  ctx.log('');
  return 0;
}

async function whoamiCommand(ctx) {
  const { client, accountId, source } = await session(ctx);
  const failures = [];
  const orNull = (error) => {
    if (!isAuthError(error)) throw error;
    failures.push(error);
    return null;
  };
  const [projects, scripts, builds] = await busy('Loading your account', () =>
    Promise.all([
      client.listProjects(accountId).then((list) => list.length, orNull),
      client.listScripts(accountId).then((list) => list.length, orNull),
      source === 'browser' ? false : client.listBuildTokens(accountId).then(() => true, () => false),
    ]),
  );
  if (failures.length === 2) throw failures[0];
  const how = { env: 'CLOUDFLARE_API_TOKEN', token: `API token saved in ${configPath(ctx.env)}`, browser: 'Cloudflare browser sign-in (wrangler)' }[source];
  ctx.log('');
  const rows = [
    ['Signed in', how],
    ['Account', accountId],
    ['Pages', projects === null ? dim('no access') : `${projects} project${projects === 1 ? '' : 's'}`],
    ['Workers', scripts === null ? dim('no access') : `${scripts} Worker${scripts === 1 ? '' : 's'}`],
    ['Workers builds', builds ? 'available' : dim(source === 'browser' ? 'needs an API token: flareship login --token' : 'no access with this token')],
  ];
  for (const line of fields(rows)) ctx.log(line);
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
