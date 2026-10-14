import fs from 'node:fs';
import path from 'node:path';

const FRAMEWORKS = [
  { name: 'Astro', dep: 'astro', out: 'dist' },
  { name: 'SvelteKit', dep: '@sveltejs/kit', out: '.svelte-kit/cloudflare', note: 'needs @sveltejs/adapter-cloudflare' },
  { name: 'Nuxt', dep: 'nuxt', out: 'dist' },
  { name: 'Remix', dep: '@remix-run/dev', out: 'build/client' },
  { name: 'Gatsby', dep: 'gatsby', out: 'public' },
  { name: 'Docusaurus', dep: '@docusaurus/core', out: 'build' },
  { name: 'Eleventy', dep: '@11ty/eleventy', out: '_site', build: 'npx @11ty/eleventy' },
  { name: 'Create React App', dep: 'react-scripts', out: 'build' },
  { name: 'Next.js', dep: 'next', out: 'out', confident: false, note: 'only static export (output: "export") works without a Cloudflare adapter' },
  { name: 'Angular', dep: '@angular/core', out: 'dist', confident: false, note: 'check the real folder under dist/' },
  { name: 'Vite', dep: 'vite', out: 'dist' },
];

const STATIC_FOLDERS = ['public', 'dist', 'build', 'site', 'docs', 'www'];

function runScript(dir, script) {
  const has = (file) => fs.existsSync(path.join(dir, file));
  if (has('pnpm-lock.yaml')) return `pnpm run ${script}`;
  if (has('yarn.lock')) return `yarn ${script}`;
  if (has('bun.lockb') || has('bun.lock')) return `bun run ${script}`;
  return `npm run ${script}`;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function detect(dir) {
  const has = (file) => fs.existsSync(path.join(dir, file));
  const pkg = has('package.json') ? readJson(path.join(dir, 'package.json')) : null;

  if (pkg) {
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const hasBuild = Boolean(pkg.scripts?.build);
    const framework = FRAMEWORKS.find((f) => deps[f.dep]);
    if (framework) {
      return {
        name: framework.name,
        build: framework.build || (hasBuild ? runScript(dir, 'build') : ''),
        out: framework.out,
        confident: framework.confident !== false && (hasBuild || Boolean(framework.build)),
        note: framework.note || null,
      };
    }
    if (hasBuild) {
      return { name: 'Node project', build: runScript(dir, 'build'), out: 'dist', confident: false, note: 'output folder is a guess' };
    }
  }

  if (has('hugo.toml') || has('hugo.yaml') || has('hugo.json') || (has('config.toml') && has('content') && has('layouts'))) {
    return { name: 'Hugo', build: 'hugo', out: 'public', confident: true, note: null };
  }
  if (has('_config.yml')) return { name: 'Jekyll', build: 'jekyll build', out: '_site', confident: true, note: null };
  if (has('mkdocs.yml')) return { name: 'MkDocs', build: 'mkdocs build', out: 'site', confident: true, note: null };

  if (has('index.html')) {
    return { name: 'Static site', build: '', out: '', confident: false, note: 'no build step found: the whole repository would be published' };
  }
  const folder = STATIC_FOLDERS.find((f) => has(path.join(f, 'index.html')));
  if (folder) return { name: 'Static site', build: '', out: folder, confident: true, note: null };

  return { name: null, build: null, out: null, confident: false, note: null };
}

function stripJsonComments(text) {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const next = text[i + 1];
    if (inString) {
      out += char;
      if (char === '\\') out += text[++i] ?? '';
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
      out += char;
    } else if (char === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (char === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++;
    } else {
      out += char;
    }
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

export function readWranglerConfig(dir) {
  for (const file of ['wrangler.jsonc', 'wrangler.json', 'wrangler.toml']) {
    const full = path.join(dir, file);
    if (!fs.existsSync(full)) continue;
    const text = fs.readFileSync(full, 'utf8');
    if (file.endsWith('.toml')) {
      const top = text.split(/^\s*\[/m)[0];
      return {
        file,
        name: top.match(/^\s*name\s*=\s*["']([^"']+)["']/m)?.[1] || null,
        pages: /^\s*pages_build_output_dir\s*=/m.test(top),
      };
    }
    try {
      const json = JSON.parse(stripJsonComments(text));
      return { file, name: typeof json.name === 'string' ? json.name : null, pages: 'pages_build_output_dir' in json };
    } catch {
      return { file, name: null, pages: false };
    }
  }
  return null;
}
