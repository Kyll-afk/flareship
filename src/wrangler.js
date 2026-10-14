import { spawn } from 'node:child_process';

const PACKAGE = 'wrangler@4';

function wrangler(args, { env, inherit = false, timeout } = {}) {
  return new Promise((resolve) => {
    const child = spawn(`npx --yes ${PACKAGE} ${args.join(' ')}`, {
      env,
      shell: true,
      stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'ignore'],
    });
    let stdout = '';
    if (child.stdout) {
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
    }
    let done = false;
    const finish = (status) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolve({ status, stdout });
    };
    const timer = timeout
      ? setTimeout(() => {
          finish(1);
          child.stdout?.destroy();
          if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }).on('error', () => {});
          else child.kill('SIGKILL');
        }, timeout)
      : null;
    child.on('error', () => finish(1));
    child.on('close', (code) => finish(code ?? 1));
  });
}

export async function wranglerToken(env = process.env) {
  const result = await wrangler(['auth', 'token', '--json'], { env, timeout: 120000 });
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

export async function wranglerLogin(env = process.env) {
  return (await wrangler(['login'], { env, inherit: true })).status === 0;
}
