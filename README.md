# flareship

Connect a Git repository to Cloudflare Pages or Cloudflare Workers from the terminal. One
command sets up push-to-deploy, the way importing a project on Vercel does:

- every push to the production branch publishes the site;
- every other branch gets its own preview;
- nothing runs on GitHub Actions and it costs nothing on Cloudflare's free plan.

Cloudflare's own CLI (`wrangler`) can upload a build, but connecting a repository so that
Cloudflare builds on every push normally has to be done by hand in the dashboard.
`flareship` does that part through the Cloudflare API, for both products:

| | Pages | Workers |
|---|---|---|
| Chosen when | the repository has no wrangler config | the repository has a `wrangler.toml` / `wrangler.jsonc` |
| Sign-in | browser (`flareship login`) | API token (`flareship login --token`) |
| Address | `<name>.pages.dev` | `<name>.<account>.workers.dev` |
| Git hosts | GitHub, GitLab | GitHub |

`--workers` and `--pages` override the choice.

```
$ flareship import

  1/4  Repository
       github.com/Kyll-afk/ziffy-site  ·  main

  2/4  Cloudflare account
       2824bd06346d60f4326fddc0142d811c

  3/4  Build settings
       Detected Vite

       Project name (ziffy-site):
       Production branch (main):
       Build command, or "none" (npm run build):
       Folder to publish, or "." for the whole repository (dist):

       Project      ziffy-site
       Repository   github.com/Kyll-afk/ziffy-site
       Branch       main  ·  other branches get preview links
       Build        npm run build
       Publish      dist

       Create this project? (Y/n)

  4/4  Create and publish
       ✓ Created ziffy-site
         Every push to main now publishes to https://ziffy-site.pages.dev
       Building ziffy-site from main
       │ Cloning repository...
       │ Success: Your site was deployed!
       ✓ Live at https://ziffy-site.pages.dev
```

```
$ flareship status

  ziffy-site  ✓ live
  https://ziffy-site.pages.dev

  Repository   github.com/Kyll-afk/ziffy-site
  Branch       main
  Build        python3 tools/dist.py
  Publish      dist

     ID        TARGET      BRANCH  COMMIT   MESSAGE                              WHEN
  ✓  0c34d148  production  main    c05737b  Drop the GitHub Actions deploy; Cl…  1h ago
  ✓  fd6fe141  production  main    65dda1f  Ziffy site: scroll-driven tour of …  1h ago
```

## Install

Needs [Node.js](https://nodejs.org) 18.17 or newer and `git`. No other dependencies.

```bash
git clone https://github.com/Kyll-afk/flareship.git
cd flareship
npm link            # makes the "flareship" command available everywhere
```

Or without installing: `npx github:Kyll-afk/flareship import`.

## Setup, step by step

`flareship guide` prints this same walkthrough in the terminal, and `flareship import`
walks you through steps 2 to 4 when something is missing.

Short version for a Pages site, once the repository is on GitHub: `flareship login`, then
`flareship import`. A Worker needs `flareship login --token` instead; see
[Workers](#workers).

### 1. Put the project on GitHub or GitLab

Cloudflare builds what is on the remote, not what is on your machine.

```bash
git remote -v              # must show an "origin" on github.com or gitlab.com
git push -u origin main
```

### 2. Sign in to Cloudflare (once per machine)

```bash
flareship login
```

Your browser opens on Cloudflare: click **Allow**. There is no token to create and no
Account ID to copy.

This is Cloudflare's own sign-in, the one its `wrangler` CLI uses; `flareship` runs it
through `npx wrangler@4`. If wrangler is already signed in on the machine, you can skip
this step: every command just works.

Asking wrangler for the session takes a few seconds, so `flareship` does it at most once
every 50 minutes and keeps the short-lived session token in between, next to the account it
should use, in `~/.config/flareship/` (`%APPDATA%\flareship\` on Windows), readable only by
you. If Cloudflare rejects a kept token, `flareship` fetches a new one by itself and retries.
`flareship logout` deletes both files.

`flareship whoami` shows how you are signed in. `flareship logout` forgets the saved
account; `npx wrangler logout` ends the Cloudflare sign-in itself.

The browser sign-in is enough for Pages. Workers, scripts and CI need an API token: see
[Workers](#workers) and [Scripts and CI](#scripts-and-ci).

### 3. Let Cloudflare read the repository

This is an approval on GitHub's side, so no tool can do it for you.

- **First time ever:** open
  <https://dash.cloudflare.com/?to=/:account/workers-and-pages/create/pages>, choose
  **Import an existing Git repository** → **Connect GitHub**, and pick the repositories.
  You can close the page once the repository shows up in the list.
- **Later repositories:** open <https://github.com/settings/installations> →
  **Cloudflare Workers and Pages** → **Configure** and add the repository. Choosing
  **All repositories** there means you never have to repeat this step.

If you skip this, `flareship import` stops and prints these same links.

### 4. Import the project

Inside the repository:

```bash
flareship import
```

It detects the build, asks you to confirm each setting, connects the repository (creating
the Pages project or the Worker if needed), starts the first build, follows its log and
prints the live address.

### 5. From now on

| Command | What it does |
|---|---|
| `git push` | Publishes (production branch) or creates a preview (any other branch). |
| `flareship status` | The project, its settings and the latest deployments. |
| `flareship logs -f` | Follows the build that is running. `flareship logs <id>` prints an older one. |
| `flareship deploy` | Rebuilds without a new commit. `--branch <name>` builds a preview. |
| `flareship open` | Opens the live site in the browser. |
| `flareship list` | Every Pages project and Worker in the account and where it comes from. |
| `flareship whoami` | How you are signed in, to which account, and whether Workers builds are available. |

## Workers

A repository with a `wrangler.toml`, `wrangler.json` or `wrangler.jsonc` is imported as a
Worker: `flareship` connects it to Cloudflare's Workers Builds, so every push runs your build
command and then `npx wrangler deploy`.

```
$ flareship import

  3/4  Build settings
       Worker edge-api  ·  from wrangler.jsonc

       Worker        edge-api  ·  will be created
       Repository    github.com/acme/edge-api
       Branch        main  ·  other branches get previews
       Build         npm run build
       Deploy        npx wrangler deploy
       Build token   main build token

  4/4  Create and publish
       ✓ Created the Worker edge-api
       ✓ Connected edge-api to github.com/acme/edge-api
       Building edge-api from main
       ✓ Live at https://edge-api.acme.workers.dev
```

What is different from Pages:

- **It needs an API token.** Cloudflare does not let the browser sign-in use the Workers
  Builds API, so `flareship login` is not enough. Create a token as described in
  [Scripts and CI](#scripts-and-ci) and run `flareship login --token`. The same token also
  works for Pages. With only the browser sign-in, Workers still show up in `flareship list`
  and `flareship open` works, but `import`, `status`, `logs` and `deploy` explain that a
  token is needed.
- **The Worker's name comes from the wrangler config.** Cloudflare requires the Worker to
  have the `name` written there, so `--name` cannot change it. If no Worker with that name
  exists, `flareship` creates an empty one for the first build to replace.
- **The published folder comes from the wrangler config too**, so `--out` is ignored. A
  static site needs at least:
  ```jsonc
  { "name": "my-site", "compatibility_date": "2025-01-01", "assets": { "directory": "./dist" } }
  ```
- **GitHub only.** `flareship` looks up the repository's numeric ID on GitHub. Public
  repositories need nothing; for a private one it uses `GH_TOKEN`, the GitHub CLI
  (`gh auth login`) or your Git credentials for github.com.
- **The account needs one build token.** It is the credential Cloudflare's build machine uses
  to deploy, and only the dashboard can create the first one: connect any Worker to a
  repository once there (Settings → Builds → Connect). `flareship` reuses it afterwards.
- **Previews** for other branches run `npx wrangler preview`. `--no-previews` turns them off.

## Progress while it works## Progress while it works

Whenever `flareship` is waiting on Cloudflare it shows a spinner with what it is doing and,
after two seconds, how long it has been waiting:

```
⠹ Checking the Cloudflare sign-in  3s
⠼ Cloning the repository  12s
⠦ Building the site  41s
```

During a build the label follows the real stage (queue, machine setup, clone, build,
publish) and the build log scrolls above it. The spinner is drawn only in a terminal; in
scripts, pipes and CI the output is plain lines. `FLARESHIP_NO_SPINNER=1` turns it off.

Colours are used only in a terminal and are dropped when `NO_COLOR` is set. The symbols
(`✓ ✗ ● │`) fall back to plain characters (`+ x * |`) in the classic Windows console;
`FLARESHIP_ASCII=1` forces the plain ones anywhere.

## Build detection

`import` looks at the repository and proposes a build command and a folder to publish.
You confirm or change both before anything is created.

| Project | Build command | Published folder |
|---|---|---|
| Astro, Vite, Nuxt | `npm run build` | `dist` |
| SvelteKit (with `@sveltejs/adapter-cloudflare`) | `npm run build` | `.svelte-kit/cloudflare` |
| Remix | `npm run build` | `build/client` |
| Gatsby | `npm run build` | `public` |
| Docusaurus, Create React App | `npm run build` | `build` |
| Eleventy | `npx @11ty/eleventy` | `_site` |
| Next.js (static export only) | `npm run build` | `out` |
| Hugo | `hugo` | `public` |
| Jekyll | `jekyll build` | `_site` |
| MkDocs | `mkdocs build` | `site` |
| `index.html` in `public/`, `dist/`, `build/`, `site/`, `docs/` or `www/` | none | that folder |
| `index.html` in the repository root | none | the whole repository (with a warning) |

`npm run build` becomes `pnpm run build`, `yarn build` or `bun run build` when the matching
lock file is present.

Publishing the whole repository makes every file in it public, including scripts and
config. If the site has its own build script, pass it explicitly:

```bash
flareship import --build "python3 tools/dist.py" --out dist
```

## Options

| Option | Meaning |
|---|---|
| `--name <name>` | Pages: project name, which becomes `<name>.pages.dev` (default: the repository name). With `status`, `logs`, `deploy` and `open`: pick a project or Worker by name from any folder. |
| `--build <command>` | Build command. `none` for no build step. |
| `--out <folder>` | Folder to publish after the build (Pages only). |
| `--root <folder>` | Folder to build from, for monorepos. |
| `--branch <branch>` | Production branch (`import`) or branch to build (`deploy`). |
| `--no-previews` | Do not build previews for other branches. |
| `--workers`, `--pages` | Treat the project as a Worker or as a Pages project, whatever is in the repository. |
| `-y`, `--yes` | Accept the detected settings without asking. |
| `-f`, `--follow` | Keep following a running build (`logs`). |
| `--token` | With `login`: save an API token instead of signing in through the browser. |

## Scripts and CI

Without a browser, authenticate with an API token. Environment variables win over
everything else, so nothing has to be stored on the machine:

```bash
export CLOUDFLARE_API_TOKEN=...
export CLOUDFLARE_ACCOUNT_ID=...
flareship import --yes --build "npm run build" --out dist
```

To create the token:

1. Open <https://dash.cloudflare.com/profile/api-tokens>.
2. **Create Token** → **Custom token** → **Get started**. Do not use one of the templates:
   they grant far more than this tool needs.
3. Add only the permissions you need:

   | Permission | Level | Needed for |
   |---|---|---|
   | Account · Cloudflare Pages | Edit | Pages projects |
   | Account · Workers Builds Configuration | Edit | Workers |
   | Account · Workers Scripts | Edit | Workers |
   | Account · Account Settings | Read | finding your account by itself |

4. Account Resources: **Include** | your account.
5. **Continue to summary**, check that only those permissions are listed, then
   **Create Token** and copy it. It is shown only once.

It must be a user token (created under **My Profile**): Cloudflare's Workers Builds API
rejects account-owned tokens.

**Account Settings: Read** lets `flareship` find the account by itself. Without it, set
`CLOUDFLARE_ACCOUNT_ID`; the ID is the 32-character part of any dashboard address, such as
<https://dash.cloudflare.com/?to=/:account/workers-and-pages> after it redirects.

`flareship login --token` saves a token on a machine instead of using the browser. It asks
for the token with hidden input and, if needed, for the account: paste a dashboard address
or the bare ID.

Set `FLARESHIP_NO_WRANGLER=1` to make sure the browser sign-in is never used.

Without a terminal attached, `flareship` never asks questions: it uses the options and the
detected settings, and fails with a clear message when it would have to guess.

## Troubleshooting

| Message | Cause and fix |
|---|---|
| `Cloudflare cannot see github.com/...` | Step 3 was not done for this repository, or it is not pushed yet. Nothing was created; follow the links it prints and run `flareship import` again. |
| `Not signed in to Cloudflare` | Run `flareship login`. In scripts, set `CLOUDFLARE_API_TOKEN`. |
| `Authentication error` | An API token is wrong, expired, or lacks **Cloudflare Pages: Edit**. Check `flareship whoami`; a `CLOUDFLARE_API_TOKEN` in the environment wins over the browser sign-in. |
| `This token cannot find your account by itself` | The token lacks **Account Settings: Read**. Paste a dashboard address when `login --token` asks, or set `CLOUDFLARE_ACCOUNT_ID`. |
| The first command is slow | `npx` is downloading wrangler. It is cached after that. |
| `Workers builds need an API token` | You are on the browser sign-in. Create a token and run `flareship login --token`. |
| `A Worker needs a wrangler configuration file` | Commit a `wrangler.jsonc`, or import as Pages with `--pages`. |
| `This account has no Workers build token yet` | Connect any Worker to a repository once in the dashboard; see [Workers](#workers). |
| `Could not read github.com/... from GitHub` | The repository is private and no GitHub sign-in was found. Run `gh auth login` or set `GH_TOKEN`. |
| `Could not detect the build settings` | Pass `--build` and `--out`. |
| `A project with this name already exists` | Pick another with `--name`. |
| The build fails | The log is printed in full. Fix the project, push, and Cloudflare builds again on its own. |

## Reference links

- Cloudflare API tokens (Workers, scripts and CI): <https://dash.cloudflare.com/profile/api-tokens>
- wrangler sign-in docs: <https://developers.cloudflare.com/workers/wrangler/commands/#login>
- Workers & Pages in the dashboard (Account ID, projects): <https://dash.cloudflare.com/?to=/:account/workers-and-pages>
- Cloudflare's GitHub app (repository access): <https://github.com/settings/installations>
- Pages Git integration docs: <https://developers.cloudflare.com/pages/configuration/git-integration/>
- Pages build configuration and framework presets: <https://developers.cloudflare.com/pages/configuration/build-configuration/>
- Pages API reference: <https://developers.cloudflare.com/api/resources/pages/>
- Pages limits on the free plan: <https://developers.cloudflare.com/pages/platform/limits/>
- Workers Builds: <https://developers.cloudflare.com/workers/ci-cd/builds/>
- Workers Builds API guide: <https://developers.cloudflare.com/workers/ci-cd/builds/api-reference/>
- Wrangler configuration file: <https://developers.cloudflare.com/workers/wrangler/configuration/>

## Development

```bash
npm test      # node --test: unit tests plus the full flow against a local mock of the API
```

The Cloudflare API calls are in `src/api.js`. `src/detect.js` holds the build detection table
and reads the wrangler config, `src/git.js` reads the repository, `src/github.js` looks up
repository IDs, `src/wrangler.js` handles the browser sign-in, and `src/commands.js` has one
function per command, with Pages and Workers behind the same small interface.
