import { readFileSync } from 'node:fs';
import { ApiError } from './api.js';
import { HELP, commands } from './commands.js';
import { Fail } from './errors.js';
import { red } from './ui.js';

const BOOLEAN = new Set(['yes', 'follow', 'help', 'version', 'no-previews']);
const VALUED = new Set(['name', 'build', 'out', 'root', 'branch']);
const ALIAS = { y: 'yes', f: 'follow', h: 'help', v: 'version' };

export function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const key = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
      if (BOOLEAN.has(key)) {
        flags[key] = true;
      } else if (VALUED.has(key)) {
        const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
        if (value === undefined) throw new Fail(`--${key} needs a value.`);
        flags[key] = value;
      } else {
        throw new Fail(`Unknown option --${key}. Run "flareship help".`);
      }
    } else if (/^-[a-zA-Z]$/.test(arg)) {
      const key = ALIAS[arg[1]];
      if (!key) throw new Fail(`Unknown option ${arg}. Run "flareship help".`);
      flags[key] = true;
    } else {
      positional.push(arg);
    }
  }
  return { command: positional[0], args: positional.slice(1), flags };
}

function version() {
  return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
}

export async function run(argv, io = {}) {
  const log = io.log || console.log;
  const err = io.err || console.error;
  const interactive = io.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  try {
    const { command, args, flags } = parseArgs(argv);
    if (flags.version) {
      log(version());
      return 0;
    }
    const name = command || (interactive ? 'import' : 'help');
    if (flags.help || name === 'help') {
      log(HELP);
      return 0;
    }
    const handler = commands[name];
    if (!handler) throw new Fail(`Unknown command "${name}". Run "flareship help".`);
    const code = await handler({
      cwd: io.cwd || process.cwd(),
      env: io.env || process.env,
      log,
      interactive,
      prompts: interactive && !flags.yes,
      args,
      flags,
    });
    return code ?? 0;
  } catch (error) {
    if (error instanceof Fail || error instanceof ApiError) {
      err(`${red('error')} ${error.message}`);
      return 1;
    }
    throw error;
  }
}
