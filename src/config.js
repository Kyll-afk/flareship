import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function configPath(env = process.env) {
  if (env.FLARESHIP_CONFIG) return env.FLARESHIP_CONFIG;
  const base = env.XDG_CONFIG_HOME || (process.platform === 'win32' && env.APPDATA) || path.join(os.homedir(), '.config');
  return path.join(base, 'flareship', 'config.json');
}

export function loadConfig(env = process.env) {
  try {
    return JSON.parse(fs.readFileSync(configPath(env), 'utf8')) || {};
  } catch {
    return {};
  }
}

export function saveConfig(config, env = process.env) {
  const file = configPath(env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {}
  return file;
}

export function clearConfig(env = process.env) {
  const file = configPath(env);
  if (!fs.existsSync(file)) return false;
  fs.rmSync(file);
  return true;
}
