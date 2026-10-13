import { execFileSync } from 'node:child_process';

function git(args, cwd) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

export function parseRemote(url) {
  if (!url) return null;
  const match = url.trim().match(/^(?:https?:\/\/(?:[^@/]+@)?|ssh:\/\/git@|git@)(github\.com|gitlab\.com)[:/](.+?)(?:\.git)?\/?$/i);
  if (!match) return null;
  const type = match[1].toLowerCase() === 'github.com' ? 'github' : 'gitlab';
  const parts = match[2].split('/').filter(Boolean);
  if (parts.length < 2) return null;
  if (type === 'github' && parts.length !== 2) return null;
  const repo = parts.pop();
  return { type, owner: parts.join('/'), repo };
}

export function readRepo(cwd) {
  const root = git(['rev-parse', '--show-toplevel'], cwd);
  if (!root) return null;
  const remoteUrl = git(['remote', 'get-url', 'origin'], cwd);
  const head = git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], cwd);
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  const upstream = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], cwd);
  const ahead = upstream ? Number(git(['rev-list', '--count', '@{u}..HEAD'], cwd) || 0) : 0;
  return {
    root,
    remoteUrl,
    remote: parseRemote(remoteUrl),
    branch: branch && branch !== 'HEAD' ? branch : null,
    defaultBranch: head ? head.replace(/^origin\//, '') : null,
    upstream,
    ahead,
  };
}
