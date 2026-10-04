# Install

One npm package, `@thenavidm/bluesky-mcp-cli`, contains two programs:

| | What it is | Who runs it |
|---|---|---|
| **`bluesky-mcp`** | the MCP server | your AI app launches it, you never do |
| **`bluesky-cli`** | the command line tool | you, in a terminal |

They are the same 45 tools. Install one, the other, or both.

This page is the complete guide. The README carries a short version of the three
most common routes, and they are repeated here so you never have to read both.

## Before you start

| What you need | Why |
|---|---|
| **Node 22 or newer** | the only thing you have to install |
| **A Bluesky app password** | needed for anything that acts as you |

Get the app password first, in [the README](README.md#2-set-up-your-account). It takes a
minute and there is no OAuth app to register.

**You can skip it and still read.** Profiles, other people's posts, threads,
custom feeds and trends all work with no credentials. Posting, liking,
following, your own timeline and your notifications do not, and `search_posts`
does not either, because Bluesky's public API refuses that one endpoint without
a session.

---

# 1. The MCP server, for AI apps

Pick your app. Each one is a single command or a single pasted block, and they
all run `npx`, so **you do not have to install anything first**.

### Claude Code

```bash
claude mcp add bluesky \
  -e BLUESKY_IDENTIFIER=you.bsky.social \
  -e BLUESKY_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx \
  -- npx -y @thenavidm/bluesky-mcp-cli
```

### Claude Desktop

**1. Open the config file.**

In Claude Desktop, go to **Settings**, then **Developer**, then click **Edit Config**. That reveals `claude_desktop_config.json` in your file manager. Open it in any text editor.

If you would rather go straight there:

| System | Config file |
|---|---|
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |
| Linux | `~/.config/Claude/claude_desktop_config.json` |

On macOS you can open it from a terminal with:

```bash
open -e ~/Library/Application\ Support/Claude/claude_desktop_config.json
```

**2. Add the server.**

If the file is empty or does not exist, paste this in:

```json
{
  "mcpServers": {
    "bluesky": {
      "command": "npx",
      "args": ["-y", "@thenavidm/bluesky-mcp-cli"],
      "env": {
        "BLUESKY_IDENTIFIER": "you.bsky.social",
        "BLUESKY_APP_PASSWORD": "xxxx-xxxx-xxxx-xxxx"
      }
    }
  }
}
```

If you already have other servers, add only the `"bluesky": {{ ... }}` part inside your existing `"mcpServers"`, and put a comma after the entry before it. The file has to stay valid JSON. A single missing comma or a trailing one stops every server from loading, not just this one.

Replace the two values with your own. [Section 2](README.md#2-set-up-your-account) covers where to get them.

**3. Restart properly.**

Quit Claude Desktop completely and reopen it. On macOS closing the window is not enough, use **Cmd+Q**. On Windows quit it from the system tray. Claude only reads that file at startup.

**4. Check it worked.**

Look for the tools icon in the message box and click it. You should see `bluesky` with its tools listed. Then ask it something from [the README](README.md#1-what-you-can-ask-it).

If nothing appears, Claude Desktop's own log is the fastest way in:

| System | Log file |
|---|---|
| macOS | `~/Library/Logs/Claude/mcp-server-bluesky.log` |
| Windows | `%APPDATA%\Claude\logs\mcp-server-bluesky.log` |

```bash
tail -n 50 ~/Library/Logs/Claude/mcp-server-bluesky.log
```

Two things account for most failures. Node is not installed, or not on the PATH that Claude Desktop sees, in which case use the full path to `node` as the `command`. Or the JSON is malformed, which you can check by pasting the file into any JSON validator.

### Cursor

Create `~/.cursor/mcp.json` for every project, or `.cursor/mcp.json` inside a single project. Use the same JSON as Claude Desktop. Then reload the window, or open **Settings**, **MCP**, and toggle the server.

### Windsurf

`~/.codeium/windsurf/mcp_config.json`, same JSON, then reload.

### VS Code

`.vscode/mcp.json` in a project, or run **MCP: Add Server** from the command palette.

### Everything else

Zed, Cline, Continue and anything else that speaks MCP over stdio all work. They each keep their config somewhere different, but they all want the same things: the `command`, the `args`, and the `env`.

### Docker

```bash
docker build -t bluesky-mcp .
docker run --rm -i \
  -e BLUESKY_IDENTIFIER=you.bsky.social \
  -e BLUESKY_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx \
  bluesky-mcp
```

### Self-hosting over HTTP

For a machine that is always on:

```bash
BLUESKY_HTTP_PORT=8787 \
BLUESKY_HTTP_TOKEN=$(openssl rand -hex 32) \
bluesky-mcp --http
```

Binds `127.0.0.1` by default. An app password can do anything your account can, so put it behind a reverse proxy with TLS before you change `BLUESKY_HTTP_HOST`, and set `BLUESKY_HTTP_TOKEN` so the endpoint is not open. `GET /health` returns the tool and account count without authentication.

### Did it work

```bash
npx -y @thenavidm/bluesky-mcp-cli doctor
```

It checks the network, then each account's credentials, then a real read and a real write scope, and names the fix for whichever one fails.

---

# 2. The CLI, for your terminal

This one you do install, because a shell needs the binary on your `PATH`.

**Skip this if you only use an AI app.** The AI app configs above run `npx`,
which fetches the package on demand, so nothing has to be installed first.

Do this when you want `bluesky-cli` in your own terminal, or in a script or a
cron job. It puts both binaries on your `PATH`:

```bash
npm install -g @thenavidm/bluesky-mcp-cli
```

Other package managers:

```bash
pnpm add -g @thenavidm/bluesky-mcp-cli     # pnpm
yarn global add @thenavidm/bluesky-mcp-cli # yarn
bun add -g @thenavidm/bluesky-mcp-cli      # bun
```

Or run it without installing anything, which is what the client configs below
do. `@latest` means you get new versions with no action on your part:

```bash
npx -y @thenavidm/bluesky-mcp-cli@latest --version
bunx @thenavidm/bluesky-mcp-cli --version
```

| Command | What it is |
|---|---|
| `bluesky-mcp` | the MCP server. What Claude Desktop, Claude Code and Cursor launch, and not something you run yourself. |
| `bluesky-cli` | the same 45 tools as shell commands. This is the one you type. |

They are one program under two names, and the name only decides what happens
when you pass no arguments: `bluesky-mcp` waits for a client, `bluesky-cli`
lists the commands. Either name will run any command.

Check it:

```bash
bluesky-cli                    # lists every command
bluesky-cli get-profile bsky.app
```

### Building it yourself instead

```bash
git clone https://github.com/thenavidm/bluesky-mcp-cli.git
cd bluesky-mcp-cli
npm install
npm run build
npm link                       # puts both binaries on your PATH
```

Point a client at `node /path/to/bluesky-mcp-cli/dist/index.js` if you would
rather not link.

---

# Keeping it current

## Upgrading

```bash
npm install -g @thenavidm/bluesky-mcp-cli@latest   # npm
pnpm add -g @thenavidm/bluesky-mcp-cli@latest      # pnpm
yarn global upgrade @thenavidm/bluesky-mcp-cli     # yarn
bun add -g @thenavidm/bluesky-mcp-cli@latest       # bun
```

If your client config uses `npx -y ...@latest`, there is nothing to upgrade.
It fetches the current version the next time the server starts.

Restart your AI tool afterwards so it reconnects to the new server:

| Client | How to reconnect |
|---|---|
| Claude Code | `/mcp` to reconnect, or restart |
| Claude Desktop | quit and reopen, not just close the window |
| Cursor, Windsurf, VS Code | restart the application |

## Uninstalling

```bash
npm uninstall -g @thenavidm/bluesky-mcp-cli
```

Remove the server from any client that has it. In Claude Code:

```bash
claude mcp remove bluesky
```

Elsewhere, delete the `bluesky` entry from the config file you edited during
install.

Nothing else is left behind. This server keeps no cache, no database and no
state directory. The one file it can create is the audit log, and only if you
pointed `BLUESKY_AUDIT_LOG` at a path, so delete that yourself if you set one.

---

Back to [the README](README.md).
