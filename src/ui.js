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
      process.stdout.write(prompt);
      rl._writeToOutput = () => {};
    }
    rl.question(hidden ? '' : prompt, (answer) => {
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
