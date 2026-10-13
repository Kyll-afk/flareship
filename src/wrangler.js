import { spawnSync } from 'node:child_process';

const PACKAGE = 'wrangler@4';

function wrangler(args, { env, inherit = false, timeout } = {}) {
  return spawnSync(`npx --yes ${PACKAGE} ${args.join(' ')}`, {
    env,
    encoding: 'utf8',
    shell: true,
    stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    timeout,
  });
}

export function wranglerToken(env = process.env) {
  const result = wrangler(['auth', 'token', '--json'], { env, timeout: 120000 });
  if (result.status !== 0 || !result.stdout) return null;
  const start = result.stdout.indexOf('{');
  const end = result.stdout.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(result.stdout.slice(start, end + 1)).token || null;
  } catch {
    return null;
  }
}

export function wranglerLogin(env = process.env) {
  return wrangler(['login'], { env, inherit: true }).status === 0;
}
