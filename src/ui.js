import readline from 'node:readline';

const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const paint = (code) => (text) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : String(text));

export const bold = paint(1);
export const dim = paint(2);
export const red = paint(31);
export const green = paint(32);
export const yellow = paint(33);
export const cyan = paint(36);

function question(prompt, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      const write = rl._writeToOutput.bind(rl);
      rl._writeToOutput = (text) => {
        if (String(text).startsWith(prompt)) write(prompt);
      };
    }
    rl.question(prompt, (answer) => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      resolve(answer.trim());
    });
  });
}

export async function ask(label, fallback = '') {
  const hint = fallback ? dim(` (${fallback})`) : '';
  const answer = await question(`${label}${hint}: `);
  return answer || fallback;
}

export function askSecret(label) {
  return question(`${label}: `, { hidden: true });
}

export async function confirm(label, fallback = true) {
  const answer = (await question(`${label} ${dim(fallback ? '(Y/n)' : '(y/N)')} `)).toLowerCase();
  if (!answer) return fallback;
  return answer === 'y' || answer === 'yes';
}

export function ago(date, now = Date.now()) {
  const seconds = Math.max(0, Math.round((now - new Date(date).getTime()) / 1000));
  if (!Number.isFinite(seconds)) return '';
  if (seconds < 45) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

const FRAMES =
  process.platform === 'win32' && !process.env.WT_SESSION
    ? ['|', '/', '-', '\\']
    : ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export function spinner(label) {
  const stream = process.stderr;
  if (!stream.isTTY || process.env.CI || process.env.FLARESHIP_NO_SPINNER) {
    return { text() {}, clear() {}, stop() {} };
  }
  const started = Date.now();
  let frame = 0;
  let current = label;
  const clear = () => stream.write('\r\x1b[2K');
  const draw = () => {
    const seconds = Math.floor((Date.now() - started) / 1000);
    stream.write(`\r\x1b[2K${FRAMES[frame++ % FRAMES.length]} ${current}${seconds >= 2 ? `  ${seconds}s` : ''}`);
  };
  draw();
  const timer = setInterval(draw, 90);
  return {
    text(next) {
      current = next;
    },
    clear,
    stop() {
      clearInterval(timer);
      clear();
    },
  };
}

export async function busy(label, task) {
  const progress = spinner(label);
  try {
    return await task();
  } finally {
    progress.stop();
  }
}
