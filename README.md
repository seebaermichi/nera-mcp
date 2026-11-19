# @nera-static/mcp

[![Test](https://github.com/seebaermichi/nera-mcp/actions/workflows/test.yml/badge.svg)](https://github.com/seebaermichi/nera-mcp/actions/workflows/test.yml)
[![npm version](https://img.shields.io/npm/v/@nera-static/mcp)](https://www.npmjs.com/package/@nera-static/mcp)

A local [MCP](https://modelcontextprotocol.io) server for the [Nera](https://github.com/seebaermichi/nera) static site generator. It lets an AI assistant (Claude Code, Claude Desktop, Cursor, Codex or any other MCP client) create, edit, build, validate, preview and publish Nera sites in one folder on your computer, and nowhere else.

📖 **Documentation:** [nera.js.org](https://nera.js.org)

```bash
npx -y @nera-static/mcp --root ~/Sites
```

The client starts this command itself; you only add it to the client's configuration (below). `--root` is the folder the server may work in: every site it creates lands there, and every path a tool takes is checked against it (no `..`, no absolute path outside it, no symlink leading out).

## Requirements

-   Node.js **22.12 or later** (`node --version`), with `npx`. Not needed for the Claude Desktop extension, which brings its own.
-   For `publish`: a GitHub account (and a Netlify account if you host there)

## Install

### Claude Desktop extension

The easiest way, and no Node.js needed: Claude Desktop runs the server on the Node it ships, and the extension brings npm along.

1. Download `nera-mcp-<version>.mcpb` from the [latest release](https://github.com/seebaermichi/nera-mcp/releases/latest).
2. Double-click it and choose **Install** in Claude Desktop.
3. Pick your **Sites folder** when Claude Desktop asks for it: the folder your sites live in.

The extension runs on macOS and Windows. To update, install the `.mcpb` of a newer release.

### Claude Code plugin

The plugin brings the server and the Nera skill, which teaches Claude how a Nera site is built, in one install:

```bash
claude plugin marketplace add seebaermichi/nera-mcp
claude plugin install nera@nera
```

or, inside Claude Code 2.1.275 or later, in one step:

```text
/plugin install nera --marketplace seebaermichi/nera-mcp
```

Claude Code asks for your **Sites folder** when the plugin is enabled. The plugin starts the server with `npx`, so it needs Node.js (see Requirements).

### Manual configuration

To add the server to a client yourself, replace `/Users/you/Sites` below with the folder your sites should live in. It must exist. Use an absolute path: clients do not expand `~` in their configuration files.

#### Claude Code

```bash
claude mcp add --transport stdio nera -- npx -y @nera-static/mcp --root /Users/you/Sites
```

Add `--scope user` to have it in every project, or `--scope project` to share it through the project's `.mcp.json`.

#### Claude Desktop

Without the extension: Settings → Developer → **Edit Config** opens `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/`, Windows: `%APPDATA%\Claude\`). Add the server and restart Claude Desktop:

```json
{
    "mcpServers": {
        "nera": {
            "command": "npx",
            "args": ["-y", "@nera-static/mcp", "--root", "/Users/you/Sites"]
        }
    }
}
```

#### Cursor

Add the same `mcpServers` entry to `~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` (one project).

#### Codex

```bash
codex mcp add nera -- npx -y @nera-static/mcp --root /Users/you/Sites
```

or in `~/.codex/config.toml`:

```toml
[mcp_servers.nera]
command = "npx"
args = ["-y", "@nera-static/mcp", "--root", "/Users/you/Sites"]
```

## What the assistant gets

A **site** is a folder under the root (or the root itself) whose `package.json` depends on `@nera-static/nera`. Tools that work on a site take `site`, its path relative to the root (`.` for the root itself); file tools take a path relative to the site.

### Tools

| Tool | Does |
| --- | --- |
| `list_starters`, `list_themes`, `list_plugins` | The starter kits, themes and plugins on npm, official ones first; offline, `list_starters` falls back to the official starters |
| `create_site` | Creates a site as `nera new` does (`name`, optional `starter`, `theme`, `title`, `lang`) and installs its packages; returns the starter's first steps as `firstSteps` |
| `list_sites` | The Nera sites under the root |
| `get_site` | A site's configuration, pages, plugins and theme |
| `read_page`, `write_page`, `delete_page` | A Markdown page with its frontmatter; `write_page` refuses frontmatter without `layout` |
| `read_file`, `write_file` | Configuration, templates and assets inside a site |
| `add_plugin` | Installs an official plugin (`@nera-static/plugin-<name>`, `plugin-<name>` or `<name>`) as `nera add` does: the package, its default config and its templates |
| `build` | `nera build`, optionally with the output checks (`check: true`) |
| `validate` | `nera validate`: the site's layouts, includes and YAML, as `{ file, line, severity, rule, message }` records |
| `preview` | Starts `nera dev` and returns the local address; `stop: true` stops it |
| `publish` | `nera publish` to GitHub Pages or Netlify; returns the sign-in code for you, then the live address |

`create_site`, `add_plugin`, `validate` and the catalogs call `@nera-static/nera`'s own functions inside the server; `build`, `preview` and `publish` run commands, through the site's own `@nera-static/nera` when it has one installed, so the assistant gets the same results as you do in a terminal. A preview or a publish keeps running between calls and stops when the client closes the server.

### Resources

| URI | Holds |
| --- | --- |
| `nera://docs/llms-full.txt` | The complete Nera documentation, bundled with this release |
| `nera://catalog/starters`, `nera://catalog/themes`, `nera://catalog/plugins` | The catalogs as JSON |
| `nera://site/{site}/AGENTS.md` | A site's `AGENTS.md` (`nera://site/AGENTS.md` for a site in the root itself) |

### Prompts

| Prompt | Walks through |
| --- | --- |
| `new_business_website` | A new business website from the business starter |
| `new_blog` | A new blog from the blog starter |
| `add_page` | Adding a page or a post to a site |
| `put_site_online` | Building, checking and publishing a site |

## Privacy and safety

-   The server only touches files below `--root`. A path outside it is refused with an error, never quietly corrected.
-   It never asks for input and never prompts in a terminal; long-running commands run in the background and are stopped when the server exits.
-   `publish` signs in through GitHub's device flow: you enter the code in your browser. Tokens stay where `nera publish` keeps them (the system keychain, or a file only you can read) and are never returned to the assistant or written into a site.
-   The catalogs are read from the public npm registry (the starters fall back to the official list when it cannot be reached). `create_site` and `add_plugin` install packages from npm. Nothing else leaves your computer unless you publish.

## Compatibility

-   Node.js 22.12 or later
-   Brings `@nera-static/nera` 1.25.0 for sites that have none installed. A site with its own CLI installed runs that one: `build` needs 1.9.0 or later (`--json`), `publish` 1.19.0 (1.20.0 for Netlify). `npm update` in the site brings it up to date.

## License

MIT
