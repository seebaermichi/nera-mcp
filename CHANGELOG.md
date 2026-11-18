# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2026-11-18

### Added

-   A Claude Desktop extension, `nera-mcp-<version>.mcpb`, attached to every GitHub Release: double-click to install, pick the sites folder in its settings. It runs on the Node that ships with Claude Desktop and brings npm itself, so no Node.js installation is needed. `npm run mcpb` builds it; its manifest is made from `package.json` and lists the tools and prompts the server registers.
-   `NERA_MCP_RUNTIME=bundled` (set by the extension): every command the server starts finds `node`, `npm` and `npx` through a shim folder first on its PATH, even with no Node on the system PATH. Without the variable nothing changes.
-   A Claude Code plugin with the Nera skill (copied from `@nera-static/nera`) and the server, and a marketplace in this repository: `claude plugin marketplace add seebaermichi/nera-mcp`, then `claude plugin install nera@nera`. It asks for the sites folder when it is enabled and starts the server at the plugin's own version.

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
