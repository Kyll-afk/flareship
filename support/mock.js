import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { run } from '../src/cli.js';

export const ACCOUNT = '0123456789abcdef0123456789abcdef';
export const OTHER_ACCOUNT = 'fedcba9876543210fedcba9876543210';

function fresh() {
  return {
    tokens: new Set(['good-token']),
    verifyFails: false,
    accounts: [{ id: ACCOUNT, name: 'Acme' }],
    pagesForbidden: false,
    buildsForbidden: false,
    projects: [],
    projectsPerPage: 100,
    denied: { locked: 8000011, hidden: 8000012 },
    deployments: [],
    deploymentOutcome: 'success',
    deploymentStartError: null,
    pollsToFinish: 2,
    scripts: [],
    subdomain: 'acme',
    buildTokens: [{ build_token_uuid: 'bt-1', build_token_name: 'main build token' }],
    workerConfigs: {},
    builds: [],
    buildOutcome: 'success',
    logPageSize: 0,
    logsUnavailable: 0,
    github: { 'Acme/edge-api': { id: 777, ownerId: 42, private: false } },
    requests: [],
    counter: 0,
  };
}

const stage = (name, status) => ({ name, status });

function readBody(request) {
  return new Promise((resolve) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

export async function startMock() {
  const state = fresh();

  const deploymentView = (d) => {
    const done = d.polls >= state.pollsToFinish;
    const stages = !done
      ? [stage('queued', 'success'), stage('build', 'active')]
      : d.outcome === 'success'
        ? [stage('build', 'success'), stage('deploy', 'success')]
        : [stage('build', d.outcome)];
    return {
      id: d.id,
      short_id: d.short_id,
      environment: d.environment,
      url: `https://${d.short_id}.${d.project}.pages.dev`,
      created_on: d.created_on,
      deployment_trigger: { type: 'ad_hoc', metadata: { branch: d.branch, commit_hash: d.commit, commit_message: d.message } },
      stages,
      latest_stage: stages.at(-1),
    };
  };

  const buildView = (b) => {
    const done = b.polls >= state.pollsToFinish;
    return {
      build_uuid: b.id,
      status: done ? 'stopped' : b.polls === 0 ? 'queued' : 'running',
      build_outcome: done ? b.outcome : null,
      created_on: b.created_on,
      preview_url: b.preview ? `https://preview-${b.script}.${state.subdomain}.workers.dev` : undefined,
      build_trigger_metadata: { branch: b.branch, commit_hash: b.commit, commit_message: b.message, build_trigger_source: b.source },
    };
  };

  const triggersFor = (tag) => {
    const config = state.workerConfigs[tag];
    if (!config) return [];
    const branch = config.git_repository.branch;
    const triggers = [{ trigger_uuid: `trg-prod-${tag}`, branch_includes: [branch], branch_excludes: [], deleted_on: null }];
    if (config.previews_enabled) triggers.push({ trigger_uuid: `trg-prev-${tag}`, branch_includes: ['*'], branch_excludes: [branch], deleted_on: null });
    return triggers;
  };

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const text = await readBody(request);
    const auth = request.headers.authorization || '';
    state.requests.push({ method: request.method, path: url.pathname, query: Object.fromEntries(url.searchParams), auth, text });
    const send = (status, json) => {
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(json));
    };
    const good = (result, extra = {}) => send(200, { success: true, result, ...extra });
    const bad = (status, code, message) => send(status, { success: false, errors: [{ code, message }] });

    const github = url.pathname.match(/^\/github\/repos\/([^/]+)\/([^/]+)$/);
    if (github) {
      const repo = state.github[`${github[1]}/${github[2]}`];
      if (!repo || (repo.private && auth !== 'Bearer gh-token')) return send(404, { message: 'Not Found' });
      return send(200, { id: repo.id, name: github[2], owner: { id: repo.ownerId, login: github[1] } });
    }

    if (!state.tokens.has(auth.replace(/^Bearer /, ''))) return bad(403, 10000, 'Authentication error');
    if (url.pathname === '/v4/user/tokens/verify') return state.verifyFails ? bad(401, 1000, 'Invalid API Token') : good({ status: 'active' });
    if (url.pathname === '/v4/accounts') return good(state.accounts);

    const scoped = url.pathname.match(/^\/v4\/accounts\/([0-9a-f]{32})(\/.*)$/);
    if (!scoped || ![ACCOUNT, OTHER_ACCOUNT].includes(scoped[1])) return bad(404, 7003, `No route for ${request.method} ${url.pathname}`);
    const route = `${request.method} ${scoped[2]}`;
    let m;

    if (scoped[2].startsWith('/pages/') && state.pagesForbidden) return bad(403, 10000, 'Authentication error');
    if (scoped[2].startsWith('/builds/') && state.buildsForbidden) return bad(403, 10000, 'Authentication error');

    if (route === 'GET /pages/projects') {
      const page = Number(url.searchParams.get('page') || 1);
      const size = state.projectsPerPage;
      const total = Math.max(1, Math.ceil(state.projects.length / size));
      return good(state.projects.slice((page - 1) * size, page * size), { result_info: { page, total_pages: total } });
    }
    if (route === 'POST /pages/projects') {
      const wanted = JSON.parse(text);
      const code = state.denied[wanted.source.config.repo_name];
      if (code) return bad(code === 8000012 ? 401 : 400, code, 'Cloudflare cannot use this repository');
      if (state.projects.some((p) => p.name === wanted.name)) return bad(409, 8000002, 'A project with this name already exists');
      const created = { ...wanted, subdomain: `${wanted.name}.pages.dev`, domains: [`${wanted.name}.pages.dev`] };
      state.projects.push(created);
      return good(created);
    }
    if ((m = route.match(/^GET \/pages\/projects\/([^/]+)$/))) {
      const project = state.projects.find((p) => p.name === m[1]);
      return project ? good(project) : bad(404, 8000007, 'Project not found');
    }
    if ((m = route.match(/^POST \/pages\/projects\/([^/]+)\/deployments$/))) {
      if (state.deploymentStartError) return bad(400, 8000000, state.deploymentStartError);
      const project = state.projects.find((p) => p.name === m[1]);
      const branch = text.match(/name="branch"\r\n\r\n([^\r\n]+)/)?.[1] || project.production_branch;
      const n = ++state.counter;
      const deployment = {
        id: `dep${String(n).padStart(5, '0')}-full`,
        short_id: `dep${String(n).padStart(5, '0')}`,
        project: m[1],
        branch,
        environment: branch === project.production_branch ? 'production' : 'preview',
        commit: 'abcdef1234567',
        message: 'Latest commit',
        outcome: state.deploymentOutcome,
        polls: 0,
        created_on: new Date().toISOString(),
      };
      state.deployments.unshift(deployment);
      return good(deploymentView(deployment));
    }
    if ((m = route.match(/^GET \/pages\/projects\/([^/]+)\/deployments$/))) {
      return good(state.deployments.filter((d) => d.project === m[1]).map(deploymentView));
    }
    if ((m = route.match(/^GET \/pages\/projects\/[^/]+\/deployments\/([^/]+)$/))) {
      const deployment = state.deployments.find((d) => d.id === m[1]);
      if (!deployment) return bad(404, 8000009, 'Deployment not found');
      deployment.polls += 1;
      return good(deploymentView(deployment));
    }
    if ((m = route.match(/^GET \/pages\/projects\/[^/]+\/deployments\/([^/]+)\/history\/logs$/))) {
      if (state.logsUnavailable > 0) {
        state.logsUnavailable -= 1;
        return bad(404, 8000009, 'Logs are not available yet');
      }
      const deployment = state.deployments.find((d) => d.id === m[1]);
      const lines = ['Cloning repository...', 'Building', deployment.outcome === 'success' ? 'Success: Your site was deployed!' : 'Failed: build command exited with code 1'];
      return good({ data: lines.slice(0, deployment.polls + 1).map((line) => ({ line })) });
    }

    if (route === 'GET /workers/scripts') return good(state.scripts);
    if (route === 'GET /workers/subdomain') return good({ subdomain: state.subdomain });
    if ((m = route.match(/^PUT \/workers\/scripts\/([^/]+)$/))) {
      state.scripts.push({ id: m[1], tag: `tag-${m[1]}` });
      return good({ id: m[1] });
    }

    if (route === 'GET /builds/tokens') return good(state.buildTokens);
    if (route === 'POST /builds/workers') {
      const wanted = JSON.parse(text);
      state.workerConfigs[wanted.script_tag] = wanted;
      return good(wanted);
    }
    if ((m = route.match(/^GET \/builds\/workers\/([^/]+)$/))) {
      const config = state.workerConfigs[m[1]];
      return config ? good(config) : bad(404, 12040, 'No build configuration associated with that script tag was found for this account');
    }
    if ((m = route.match(/^GET \/builds\/workers\/([^/]+)\/triggers$/))) return good(triggersFor(m[1]));
    if ((m = route.match(/^GET \/builds\/workers\/([^/]+)\/builds$/))) return good(state.builds.filter((b) => b.tag === m[1]).map(buildView));
    if ((m = route.match(/^POST \/builds\/triggers\/trg-(prod|prev)-(.+)\/builds$/))) {
      const tag = m[2];
      const n = ++state.counter;
      const build = {
        id: `bld${String(n).padStart(5, '0')}-full`,
        tag,
        script: state.scripts.find((x) => x.tag === tag)?.id,
        branch: JSON.parse(text).branch,
        preview: m[1] === 'prev',
        commit: 'fedcba9876543',
        message: 'Add the edge API',
        source: 'push',
        outcome: state.buildOutcome,
        polls: 0,
        created_on: new Date().toISOString(),
      };
      state.builds.unshift(build);
      return good(buildView(build));
    }
    if ((m = route.match(/^GET \/builds\/builds\/([^/]+)$/))) {
      const build = state.builds.find((b) => b.id === m[1]);
      if (!build) return bad(404, 12000, 'Build not found');
      build.polls += 1;
      return good(buildView(build));
    }
    if ((m = route.match(/^GET \/builds\/builds\/([^/]+)\/logs$/))) {
      const build = state.builds.find((b) => b.id === m[1]);
      const all = ['Cloning repository', 'Running: npm run build', `Deployed ${build.script}`].slice(0, build.polls + 1).map((line) => [Date.now(), line]);
      if (!state.logPageSize) return good({ cursor: 'end', truncated: false, lines: all });
      const from = Number(url.searchParams.get('cursor') || 0);
      const to = from + state.logPageSize;
      return good({ cursor: String(to), truncated: to < all.length, lines: all.slice(from, to) });
    }

    return bad(404, 7003, `No route for ${request.method} ${url.pathname}`);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    state,
    base: `${origin}/v4`,
    github: `${origin}/github`,
    reset() {
      for (const key of Object.keys(state)) delete state[key];
      Object.assign(state, fresh());
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

export function tempDir(prefix = 'flareship-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function writeFiles(dir, files) {
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), typeof content === 'string' ? content : JSON.stringify(content));
  }
  return dir;
}

const git = (dir, ...args) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd: dir, stdio: 'pipe' });

export function makeRepo(name, files = {}, { owner = 'Acme', host = 'github.com', branch = 'main', remote = true, pushed = false, ahead = 0, defaultBranch } = {}) {
  const dir = writeFiles(tempDir('flareship-repo-'), files);
  git(dir, 'init', '-q', '-b', branch);
  if (remote) git(dir, 'remote', 'add', 'origin', remote === true ? `https://${host}/${owner}/${name}.git` : remote);
  if (pushed || ahead) {
    git(dir, 'commit', '-q', '--allow-empty', '-m', 'first');
    git(dir, 'update-ref', `refs/remotes/origin/${branch}`, 'HEAD');
    git(dir, 'branch', '-q', `--set-upstream-to=origin/${branch}`);
    for (let i = 0; i < ahead; i++) git(dir, 'commit', '-q', '--allow-empty', '-m', `local ${i}`);
  }
  if (defaultBranch) {
    git(dir, 'commit', '-q', '--allow-empty', '-m', 'default');
    git(dir, 'update-ref', `refs/remotes/origin/${defaultBranch}`, 'HEAD');
    git(dir, 'symbolic-ref', 'refs/remotes/origin/HEAD', `refs/remotes/origin/${defaultBranch}`);
  }
  return dir;
}

export function createCli(mock) {
  const configDir = tempDir('flareship-config-');
  let runs = 0;

  return async function flareship(cwd, argv, { env = {}, interactive = false, answers = [], deps = {} } = {}) {
    const lines = [];
    const asked = [];
    const opened = [];
    const queue = [...answers];
    const answer = (label) => {
      asked.push(String(label).trim());
      if (!queue.length) throw new Error(`No scripted answer for: ${label}`);
      return queue.shift();
    };
    const code = await run(argv, {
      cwd,
      interactive,
      env: {
        CLOUDFLARE_API_TOKEN: 'good-token',
        CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
        FLARESHIP_API_BASE: mock.base,
        FLARESHIP_GITHUB_API: mock.github,
        FLARESHIP_NO_GIT_CREDENTIALS: '1',
        FLARESHIP_POLL_MS: '2',
        FLARESHIP_CONFIG: path.join(configDir, `run-${++runs}`, 'config.json'),
        ...env,
      },
      log: (line) => lines.push(String(line)),
      err: (line) => lines.push(String(line)),
      deps: {
        ask: async (label, fallback = '') => answer(label) || fallback,
        askSecret: async (label) => answer(label),
        confirm: async (label, fallback = true) => {
          const reply = answer(label);
          return reply === '' ? fallback : /^y/i.test(reply);
        },
        wranglerToken: async () => null,
        wranglerLogin: async () => false,
        open: (url) => opened.push(url),
        ...deps,
      },
    });
    return { code, output: lines.join('\n'), asked, opened, unused: queue };
  };
}
