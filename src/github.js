import { spawn } from 'node:child_process';
import { Fail } from './errors.js';

function run(command, args, { input, env, cwd } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { env, cwd, stdio: ['pipe', 'pipe', 'ignore'] });
    } catch {
      resolve(null);
      return;
    }
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    const timer = setTimeout(() => child.kill(), 15000);
    child.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? stdout : null);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input || '');
  });
}

async function localToken(env, cwd) {
  if (env.GH_TOKEN || env.GITHUB_TOKEN) return env.GH_TOKEN || env.GITHUB_TOKEN;
  if (env.FLARESHIP_NO_GIT_CREDENTIALS) return null;
  const fromGh = await run('gh', ['auth', 'token'], { env, cwd });
  if (fromGh?.trim()) return fromGh.trim();
  const quiet = { ...env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' };
  const filled = await run('git', ['credential', 'fill'], { env: quiet, cwd, input: 'protocol=https\nhost=github.com\n\n' });
  return filled?.match(/^password=(.+)$/m)?.[1]?.trim() || null;
}

export async function githubRepo(remote, { env = process.env, cwd, fetchImpl = globalThis.fetch } = {}) {
  const base = (env.FLARESHIP_GITHUB_API || 'https://api.github.com').replace(/\/+$/, '');
  const read = async (token) => {
    const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'flareship' };
    if (token) headers.Authorization = `Bearer ${token}`;
    try {
      return await fetchImpl(`${base}/repos/${remote.owner}/${remote.repo}`, { headers });
    } catch (error) {
      throw new Fail(`Could not reach GitHub: ${error.cause?.message || error.message}`);
    }
  };

  let response = await read(null);
  if (!response.ok) {
    const token = await localToken(env, cwd);
    if (token) response = await read(token);
  }
  if (!response.ok) {
    throw new Fail(
      [
        `Could not read github.com/${remote.owner}/${remote.repo} from GitHub (HTTP ${response.status}).`,
        'For a private repository, flareship needs your GitHub sign-in to look up its ID:',
        '  install the GitHub CLI and run "gh auth login", or set GH_TOKEN.',
      ].join('\n'),
    );
  }
  const repo = await response.json();
  return { repoId: String(repo.id), repoName: repo.name, ownerId: String(repo.owner.id), ownerName: repo.owner.login };
}
