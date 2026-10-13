# flareship

Connect a Git repository to Cloudflare Pages from the terminal. One command sets up
push-to-deploy, the way importing a project on Vercel does:

- every push to the production branch publishes the site;
- every other branch gets its own preview address;
- nothing runs on GitHub Actions and it costs nothing on Cloudflare's free plan.

Cloudflare's own CLI (`wrangler`) can only create upload-only Pages projects. Git-connected
projects normally have to be created by hand in the dashboard. `flareship` does that part
through the Cloudflare API.

```
$ flareship import

[1/4] Repository
github.com/Kyll-afk/ziffy-site  on main

[2/4] Cloudflare account
account 2824bd06…

[3/4] Build settings
Detected Vite
Project name (ziffy-site):
Production branch (main):
Build command, or "none" (npm run build):
Folder to publish, or "." for the whole repository (dist):

  project   ziffy-site
  repo      github.com/Kyll-afk/ziffy-site
  branch    main  (other branches get preview links)
  build     npm run build
  publish   dist

Create this project? (Y/n)

[4/4] Create and publish
created ziffy-site. Every push to main now publishes to https://ziffy-site.pages.dev
Building ziffy-site from main...
  | Cloning repository...
  | Success: Your site was deployed!
done live at https://ziffy-site.pages.dev
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

### 1. Put the project on GitHub or GitLab

Cloudflare builds what is on the remote, not what is on your machine.

```bash
git remote -v              # must show an "origin" on github.com or gitlab.com
git push -u origin main
```

### 2. Create a Cloudflare API token (once per machine)

1. Open <https://dash.cloudflare.com/profile/api-tokens>.
2. **Create Token** → **Custom token** → **Get started**.
3. Permissions: **Account** | **Cloudflare Pages** | **Edit**.
4. Account Resources: **Include** | your account.
5. **Continue to summary** → **Create Token**, then copy it. It is shown only once.
6. Run `flareship login` and paste it. The input is hidden.

If the token cannot list accounts, `login` asks for the **Account ID**. It is on
<https://dash.cloudflare.com/?to=/:account/workers-and-pages>, in the right column under
"Account details".

The token and account ID are saved in `~/.config/flareship/config.json`
(`%APPDATA%\flareship\config.json` on Windows), readable only by you. `flareship logout`
deletes the file.

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

It detects the build, asks you to confirm each setting, creates the Pages project, starts
the first build, follows its log and prints the live address.

### 5. From now on

| Command | What it does |
|---|---|
| `git push` | Publishes (production branch) or creates a preview (any other branch). |
| `flareship status` | The project, its settings and the latest deployments. |
| `flareship logs -f` | Follows the build that is running. `flareship logs <id>` prints an older one. |
| `flareship deploy` | Rebuilds without a new commit. `--branch <name>` builds a preview. |
| `flareship open` | Opens the live site in the browser. |
| `flareship list` | Every Pages project in the account and where it comes from. |
| `flareship whoami` | Which token and account are in use. |

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
| `--name <name>` | Project name. Default: the repository name. It becomes `<name>.pages.dev`. |
| `--build <command>` | Build command. `none` for no build step. |
| `--out <folder>` | Folder to publish after the build. |
| `--root <folder>` | Folder to build from, for monorepos. |
| `--branch <branch>` | Production branch (`import`) or branch to build (`deploy`). |
| `--no-previews` | Do not build preview deployments for other branches. |
| `-y`, `--yes` | Accept the detected settings without asking. |
| `-f`, `--follow` | Keep following a running build (`logs`). |

## Scripts and CI

Environment variables win over the saved login, so nothing has to be stored on the machine:

```bash
export CLOUDFLARE_API_TOKEN=...
export CLOUDFLARE_ACCOUNT_ID=...
flareship import --yes --build "npm run build" --out dist
```

Without a terminal attached, `flareship` never asks questions: it uses the options and the
detected settings, and fails with a clear message when it would have to guess.

## Troubleshooting

| Message | Cause and fix |
|---|---|
| `Cloudflare has no access to github.com/...` | Step 3 was not done for this repository. Follow the links it prints. |
| `Authentication error` | The token is wrong, expired, or lacks **Cloudflare Pages: Edit**. Run `flareship login` again. |
| `This token cannot list accounts` | Normal for a Pages-only token. Enter the Account ID in `flareship login` or set `CLOUDFLARE_ACCOUNT_ID`. |
| `Could not detect the build settings` | Pass `--build` and `--out`. |
| `A project with this name already exists` | Pick another with `--name`. |
| The build fails | The log is printed in full. Fix the project, push, and Cloudflare builds again on its own. |

## Reference links

- Cloudflare API tokens: <https://dash.cloudflare.com/profile/api-tokens>
- Workers & Pages in the dashboard (Account ID, projects): <https://dash.cloudflare.com/?to=/:account/workers-and-pages>
- Cloudflare's GitHub app (repository access): <https://github.com/settings/installations>
- Pages Git integration docs: <https://developers.cloudflare.com/pages/configuration/git-integration/>
- Pages build configuration and framework presets: <https://developers.cloudflare.com/pages/configuration/build-configuration/>
- Pages API reference: <https://developers.cloudflare.com/api/resources/pages/>
- Pages limits on the free plan: <https://developers.cloudflare.com/pages/platform/limits/>

## Development

```bash
npm test      # node --test: unit tests plus the full flow against a local mock of the API
```

The Cloudflare-specific code is in `src/api.js`. `src/detect.js` holds the build detection
table, `src/git.js` reads the repository, and `src/commands.js` has one function per command.
