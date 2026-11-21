# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.4.0] - 2026-11-21

### Added

-   A hosted mode, `nera-mcp --http [--port] [--host] [--trust-proxy]`, for MCP clients that cannot start a local process (claude.ai, ChatGPT). It is an OAuth 2.1 authorization server with protected-resource metadata (RFC 9728), authorization-server metadata (RFC 8414, S256 PKCE only), dynamic client registration (RFC 7591) and rotating refresh tokens, in front of a stateless Streamable HTTP endpoint at `/mcp` that requires a bearer token issued for it. The sign-in is delegated to a GitHub App, after a consent page that shows the user which client asks. The hosted server offers the catalog tools (`list_starters`, `list_themes`, `list_plugins`) for now.
-   The hosted mode is configured by `NERA_MCP_ISSUER`, `NERA_MCP_DB`, `NERA_MCP_TOKEN_KEY`, `NERA_MCP_GITHUB_CLIENT_ID` and `NERA_MCP_GITHUB_CLIENT_SECRET`, and stops with exit code 1 and a message naming what is missing or wrong (never a value). It keeps its state in one SQLite file (`node:sqlite`, so it needs Node 22.13 or later; the stdio mode stays on 22.12): our tokens only as SHA-256 hashes, GitHub's tokens AES-256-GCM-encrypted. Its logs go to stderr and never carry a token, the key or the client secret; `SIGTERM` lets running requests finish, closes the database and exits 0.
-   `express` as a dependency, for the SDK's OAuth router the hosted mode is built on; the stdio mode does not load it.

### Changed

-   The stdio mode refuses `--port`, `--host` and `--trust-proxy` without `--http`, and the hosted mode refuses `--root`, each with a message saying which mode the option belongs to. `--root` stays required for the stdio mode, which is otherwise unchanged.

## [1.3.1] - 2026-11-21

### Changed

-   `preview` no longer promises that the page in the browser updates by itself: its description and its result text say the site rebuilds after every change and that the user may need to reload the page to see it. Its inputs and result shape are unchanged.

## [1.3.0] - 2026-11-19

### Changed

-   `publish` learns that `nera publish` waits for the user (the GitHub sign-in code, the app installation, the Netlify authorization) and that the step is done from the CLI's JSON event lines on stderr instead of matching its human log lines, so a change in the CLI's wording no longer breaks it. An event still counts only for a known step, an `https://` page on that step's host and, for the GitHub sign-in, a code of the user-code shape. Its inputs and result shape are unchanged, and the last progress line it reports never shows an event line.
-   `publish` refuses a site whose own `@nera-static/nera` is older than 1.27.0 (or whose version cannot be read) before it starts anything, with a hint to run `npm update` in the site: an older CLI writes no event lines, so the sign-in code would never reach the assistant. A publish already running is still reported.
-   Requires `@nera-static/nera` ^1.27.0 (was ^1.26.0), the first release whose `publish --json` writes the event lines.

## [1.2.1] - 2026-11-19

### Changed

-   `add_plugin` installs the plugin with `addPlugin()` from `@nera-static/nera` inside the server instead of running `npm install`, its own config copy and the package's template script itself. Its inputs, refusals and result shape are unchanged; the result's `log` holds `addPlugin`'s progress lines, while npm's and the template script's output goes to the server's log (stderr). Cancelling the call stops the running command, and with `NERA_MCP_RUNTIME=bundled` it gets the same environment as every other command.
-   `add_plugin` refuses a config folder or `config/<name>.yaml` that is a symbolic link out of the site before anything is installed.
-   Requires `@nera-static/nera` ^1.26.0 (was ^1.25.0), the first release with `addPlugin`.

### Fixed

-   `add_plugin` accepts `plugin-<name>` (e.g. `plugin-tags`) like the CLI; it used to ask npm for `@nera-static/plugin-plugin-tags`.

## [1.2.0] - 2026-11-18

### Added

-   `create_site` returns the starter's `## First steps` (from its README) as `firstSteps`, `null` without a starter, and its text points to them.

### Changed

-   `create_site` creates and installs the site with `createSite()` from `@nera-static/nera` inside the server instead of spawning `nera new`. Cancelling the call stops the install and removes the new folder again; npm's output goes to the server's log (stderr). Its inputs, checks and result shape are unchanged.
-   `list_starters`, `list_themes`, `list_plugins` and the `nera://catalog/*` resources come from `listCatalog()` of `@nera-static/nera` instead of the server's own registry search. Offline, the starters fall back to the official list the CLI bundles; themes and plugins still report the registry error.
-   `validate` calls `validate()` from `@nera-static/nera`, so it runs the validator version the CLI pins; its records are unchanged. `@nera-static/validate` is no longer a direct dependency.
-   With `NERA_MCP_RUNTIME=bundled` (the Desktop extension), `create_site` hands `createSite` the same environment as every other command, shim folder first on the PATH, so its starter download and `npm install` find the bundled `npm`.
-   Requires `@nera-static/nera` ^1.25.0 (was ^1.23.0), the first release whose `createSite` installs without blocking and takes `signal` and `env`.

## [1.1.0] - 2026-11-18

### Added

-   A Claude Desktop extension, `nera-mcp-<version>.mcpb`, attached to every GitHub Release: double-click to install, pick the sites folder in its settings. It runs on the Node that ships with Claude Desktop and brings npm itself, so no Node.js installation is needed. `npm run mcpb` builds it; its manifest is made from `package.json` and lists the tools and prompts the server registers.
-   `NERA_MCP_RUNTIME=bundled` (set by the extension): every command the server starts finds `node`, `npm` and `npx` through a shim folder first on its PATH, even with no Node on the system PATH. Without the variable nothing changes.
-   A Claude Code plugin with the Nera skill (copied from `@nera-static/nera`) and the server, and a marketplace in this repository: `claude plugin marketplace add seebaermichi/nera-mcp`, then `claude plugin install nera@nera`. It asks for the sites folder when it is enabled and starts the server at the plugin's own version.
-   A 512×512 Nera icon (the favicon mark of nera.js.org) for the Desktop extension and the Claude Code plugin.

## [1.0.1] - 2026-11-18

### Added

-   `mcpName` (`io.github.seebaermichi/nera-mcp`) in `package.json`, which the official MCP Registry uses to verify that a server listing belongs to this npm package.

## [1.0.0] - 2026-11-18

### Added

-   A local MCP server for Nera over stdio: `npx -y @nera-static/mcp --root <folder>`. Only JSON-RPC goes to stdout; logs go to stderr. `--root` is required and must be an existing folder; a missing or invalid one exits with code 1 and a message on stderr. SIGINT, SIGTERM and the client closing stdin stop the running previews and publishes, then the server.
-   The root guard: every path a tool or resource takes is resolved, followed through symlinks and must stay inside `--root`; `..`, an absolute path outside it and a symlink leading out are refused with an error that says what to pass instead.
-   Tools `list_sites` and `get_site` (the site model from `@nera-static/core`), `read_page`, `write_page` (refuses frontmatter without `layout`; YAML written through `yaml`, comments kept) and `delete_page`, `read_file` and `write_file`.
-   Tools `create_site` (`nera new`), `build` (`nera build --json`, optionally `--check`), `validate` (`validateSite()` from `@nera-static/validate`, its `{ file, line, severity, rule, message }` records unchanged) and `add_plugin` (`@nera-static/plugin-*` only: install, default config, templates). Commands run through the site's own `@nera-static/nera` when it has one, without a shell and with their output captured; a cancelled call or a closed server stops them with everything they started (their process group on POSIX, `taskkill /T /F` on Windows).
-   Tools `preview` (`nera dev` on a free port, returns the local URL, `stop: true` stops it) and `publish` (`nera publish --yes --json` in the background: returns the GitHub sign-in code and page, the app installation or Netlify authorization step, then the live URL).
-   Tools `list_starters`, `list_themes` and `list_plugins`, from the npm registry by keyword, official `@nera-static` packages first.
-   Resources `nera://docs/llms-full.txt` (the nera.js.org documentation, bundled on `prepack`), `nera://catalog/{starters,themes,plugins}` and each site's `AGENTS.md` (`nera://site/{site}/AGENTS.md`).
-   Prompts `new_business_website`, `new_blog`, `add_page` and `put_site_online`.
