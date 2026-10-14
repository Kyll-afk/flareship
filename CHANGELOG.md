# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-10-13

### Added

- Workers: a repository with a `wrangler.toml` / `wrangler.jsonc` is imported as a Worker
  connected to Workers Builds (build configuration, a placeholder Worker when none exists, and
  the first build). `status`, `logs`, `deploy`, `open` and `list` work on Workers too.
- `--workers` and `--pages` override the detection.
- MIT licence and npm package metadata.

### Fixed

- Cloudflare's error 8000012 (a repository it cannot see) now shows how to give it access and
  says that nothing was created, instead of a raw API error.
- The branch of a repository without commits is read from `HEAD` instead of assumed to be `main`.
- `list` and `whoami` fail when Cloudflare rejects the sign-in, instead of showing an empty
  account.
- A hung wrangler is stopped at its timeout on Windows.

## [0.1.0] - 2026-10-13

### Added

- `flareship import`: detect the framework and build settings of the current repository and
  create a Git-connected Cloudflare Pages project, so every push builds on Cloudflare.
- `status`, `deploy`, `logs`, `open`, `list`, `whoami` and `logout`, and `guide` to print the
  full setup walkthrough with every link.
- Browser sign-in through wrangler with `flareship login`; `login --token` keeps the API token
  path for scripts and CI.
- The browser session is kept between runs (up to 50 minutes) instead of asking wrangler on
  every command.
- A spinner with elapsed time on every wait, and the current stage of a running build.
- Aligned fields, tables, numbered steps and status marks in the output, with plain
  characters in the classic Windows console.

[Unreleased]: https://github.com/Kyll-afk/flareship/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/Kyll-afk/flareship/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Kyll-afk/flareship/releases/tag/v0.1.0
