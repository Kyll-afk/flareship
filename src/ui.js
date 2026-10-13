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

export const fancy =
  !process.env.FLARESHIP_ASCII && (process.platform !== 'win32' || Boolean(process.env.WT_SESSION || process.env.TERM_PROGRAM));

export const sym = fancy
  ? { ok: '✓', fail: '✗', warn: '▲', run: '●', stop: '■', bar: '│', dot: '·', ellipsis: '…' }
  : { ok: '+', fail: 'x', warn: '!', run: '*', stop: '#', bar: '|', dot: '-', ellipsis: '...' };

const FRAMES = fancy ? ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] : ['|', '/', '-', '\\'];
const ANSI = /\x1b\[[0-9;]*m/g;

export const width = (text) => String(text).replace(ANSI, '').length;
export const pad = (text, size) => String(text) + ' '.repeat(Math.max(0, size - width(text)));
export const columns = () => process.stdout.columns || 100;

export function truncate(text, size) {
  const value = String(text);
  if (value.length <= size) return value;
  return value.slice(0, Math.max(0, size - sym.ellipsis.length)).trimEnd() + sym.ellipsis;
}

export function fields(pairs, indent = 2) {
  const rows = pairs.filter(Boolean);
  const size = Math.max(...rows.map(([label]) => label.length)) + 3;
  return rows.map(([label, value]) => `${' '.repeat(indent)}${dim(label.padEnd(size))}${value}`);
}

export function table(rows, { header, indent = 2, gap = 2 } = {}) {
  const all = header ? [header.map((cell) => dim(cell.toUpperCase())), ...rows] : rows;
  const sizes = [];
  for (const row of all) row.forEach((cell, i) => (sizes[i] = Math.max(sizes[i] || 0, width(cell))));
  return all.map((row) => (' '.repeat(indent) + row.map((cell, i) => pad(cell, sizes[i] + gap)).join('')).trimEnd());
}

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
