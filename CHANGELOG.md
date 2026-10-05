# Bluesky MCP Server & CLI changelog

| Component | Version | Last Updated |
|-----------|---------|--------------|
| bluesky-mcp-cli | 2.0.1 | 2026-10-05 |
| @thenavidm/slipway | 0.1.17 | 2026-10-05 |

---

## 2.0.1, 2026-10-05

- **Built on Slipway 0.1.17**, which a fresh install of 2.0.0 already used. Since the Slipway 2.0.0 was measured on, 0.1.5, `which` also reads a tool's argument names and prints a title once where a description opens with it, and the general help names the settings that connect an account and the safety switches and counts the rest, which `agent-context` describes one by one. [Slipway's changelog](https://github.com/thenavidm/slipway/blob/main/CHANGELOG.md) lists the rest.
- **The README documents `BLUESKY_HTTP_ALLOWED_ORIGINS`**, the browser origins `--http` accepts, which Slipway reads.
- **A test checks that every setting is named in `--help` or described by `agent-context`**, where it asked `--help` to name each one.

## 2.0.0, 2026-10-04

Built on [Slipway](https://github.com/thenavidm/slipway) 0.1.5. The 45 tools keep their names and arguments, and every difference below was measured against 1.2.3 before release.

- **A person approves each post, thread, delete and block over MCP.** Claude Code (2.1.246 and later) shows its own prompt for each one, and a client that can show forms asks with an approval form whose one box starts unticked. Approvals are signed, bound to the exact call and work once. Where a client can do neither, the model's `confirm: true` still counts, and `BLUESKY_CONFIRM=model` makes it enough everywhere, for an agent with no person to ask. The audit log records who approved each write.
- **A smaller tool list.** 14,220 tokens in Claude Code with every tool loaded, down from 15,880: the per-tool `$schema` line, an `execution` field and `additionalProperties: false` are gone. The last one advertised strict input while unknown keys were dropped anyway; the schema now says what happens.
- **Exit codes follow the house contract everywhere.** An unknown command and a write in read-only mode exit 2 instead of 1, and `doctor` with nothing configured exits 10 instead of 1. 1 now means an unexpected error, and a network failure still exits 5.
- **Cheaper through the CLI.** The same Codex task took 105,064 input tokens instead of 106,219 (median of five): `which <words>` finds a command without the full list, and a command's help shows only the flags it can use.
- **`install <client>`** adds the server to Claude Code, Codex, Claude Desktop, Cursor, VS Code or Gemini CLI in each one's own format.
- **Faster from the second launch.** The entry turns on Node's compile cache, so once it is warm the server answers a client in 207 ms where 1.2.3 took 235 (median of 21 runs, taking turns on one busy Mac). npx installs 4 dependencies instead of 94.
- **`--help` lists every setting the server reads**, Slipway's own included, and restored tests keep the README and `--help` in step with the code.
- **README fixes.** Section links that pointed one way and were labeled another now agree, the exit-code example script no longer reads the status of `!`, the four analytics tools are documented, and images load from cdn.navid.me. THIRD_PARTY_NOTICES.md lists the production dependencies' licenses.

### Upgrading

Node 22 or newer. Scripts keep working for success, usage errors and missing setup; a script that treated exit 1 as "unknown command" or "read-only" should read 2. Over MCP, expect an approval prompt or form for each post; a headless agent that should post with `confirm: true` alone needs `BLUESKY_CONFIRM=model`. A script that pipes JSON-RPC into the server must keep stdin open until it reads the answer: the server now stops when its input ends, as the MCP stdio binding asks. Over MCP in Codex, the same task reads 54 more input tokens out of about 108,000, from the standard `confirm` wording.

## 1.2.3, 2026-10-04

- **`npx -y @thenavidm/bluesky-mcp-cli` starts the MCP server whatever order npm keeps.** npx starts whichever binary the npm registry lists first when they share one file, and the registry does not keep the published order. For this package that happened to be the server; for 23 others it was the CLI. A third binary named after the package, on its own file, now always starts the server, and npx picks it by name.

## 1.2.2

Two real bugs, and honest numbers.

`--select posts.uri,posts.text` returned only the text. Two paths under one head
overwrote each other, so the flag whose entire purpose is choosing what you keep
was quietly dropping most of it. Paths are grouped by their first segment now,
with regression tests at three depths.

`--port 8787` was ignored. Only `--port=8787` parsed, and the space form fell
through to the default without complaining, which looks exactly like the flag
doing nothing, because it was.

The context cost in the README was characters divided by four. Counted properly
with a tokeniser against a live handshake it is 10,969 a turn, not 11,400, and
55% of it is JSON Schema structure rather than the 61% claimed. The CLI side
said "roughly a hundred tokens" and is 108.

---

## 1.2.1

Every link in the package pointed at a GitHub account that no longer exists.

The account was renamed, so the clone command, the issues link, the security
advisory link, the release download and the setup URL inside `src/` were all
resolving through GitHub's rename redirect. That redirect stops working the
moment someone else claims the old name.

npm serves whatever was in the published tarball, so fixing GitHub did not fix
the package page. This release is what actually corrects it.

---

## 1.2.0

Analytics, and the flags an agent needs.

### Analytics

Bluesky publishes no analytics API, so every dashboard builds its own. It turns
out not to need one: `likeCount`, `repostCount`, `replyCount` and `quoteCount`
already ride along on every post the feed returns, and this server was rendering
them and throwing them away.

`rank_posts` sorts your posts by engagement. `get_post_stats` does one post.
`get_engagement_summary` gives totals, averages, an engagement rate against
followers, and a breakdown by format so you can see whether images earn their
effort. `get_posting_patterns` crosses your posting times with the engagement
they got, by hour and by weekday.

All four run on any public account with no credentials, the same way the
reading tools do. 45 tools now, 30 of them reads.

Deliberately absent: follower growth, which is a trend and cannot come from a
snapshot; impressions, which Bluesky exposes to nobody; and bookmarks, which are
not confirmed publicly readable.

### Agent mode

`--agent` is `--json --compact --no-input --no-color --yes` in one flag.
`--select uri,author.handle` keeps only the fields named: dotted paths descend
and arrays traverse element-wise.

### Exit codes

0 success, 2 usage, 3 not found, 4 auth, 5 API, 7 rate limited, 10 config, so a
script branches on a number instead of parsing a message. It returned 0 or 1
before.

### Fixed

`schema <command>` printed the Zod object's internals rather than the JSON
Schema an MCP client actually receives.

CI asserted a hardcoded tool count, so adding a tool turned the build red with
nothing wrong. It compares against `ALL_TOOLS` now.

---

## 1.1.0

A CLI, and a rename to match.

### Every tool is now a shell command

All 41 tools run from the terminal. The command is the tool name: `create_post`
runs as `create-post`, and the underscore spelling works too. Flags, help text
and validation come from the same schema the MCP tool declares, so both surfaces
accept the same arguments and a tool added tomorrow is a command tomorrow.

`--confirm`, `BLUESKY_READ_ONLY`, `BLUESKY_ALLOW_DESTRUCTIVE` and the audit log
behave identically whichever surface you use.

### Two binaries

`bluesky-mcp` is the server your AI app runs. `bluesky-cli` is the one you type,
and run bare it lists every command. Help output names the binary you actually
typed.

### Renamed to bluesky-mcp-cli

So the name says both surfaces. The npm scope is unchanged and the server binary
is still `bluesky-mcp`, so existing client configs keep working.

### Known gap

Read commands return the tagged text, so `--json` gives that text as a JSON
string rather than fields to filter on. Writes and the account commands return
real objects you can pipe into `jq`.

21 new tests, 82 total.

---

## 1.0.0

First release. 41 tools, 61 tests.

### Posting

Links, hashtags and mentions are marked up before publishing, with each mention
resolved to an account ID. Bluesky renders nothing on its own: post the raw
string and every link and mention is inert grey text, with no error to notice.

A reply names the thread's root, not just its parent. Naming only the parent
produces a post Bluesky accepts and then never lists in the thread it belongs to.

Images carry alt text and a measured aspect ratio, so a tall screenshot is not
letterboxed. Video goes through Bluesky's transcoding service and is polled to
completion. Uploading it as a plain file publishes cleanly and then plays for
nobody.

`create_thread` validates every part before posting any of them, so a thread
never half-publishes because part four was too long.

### The character limit

300 *graphemes* and 3,000 *bytes*, checked separately, which is what Bluesky
actually enforces. Counting JavaScript string length instead rejects legal
posts: one family emoji is one character to Bluesky and eleven to JavaScript.

### Output

Feeds, threads and search results come back as tagged text rather than raw API
JSON. Measured on a 50-post feed: 49,839 characters against 521,426, roughly
12,500 tokens instead of 130,000. Timestamps are ISO-8601 UTC so two can be
compared, a repost wraps the original rather than flattening it, deleted and
blocked posts get placeholders, and moderation labels are surfaced.

### Tools

41. Every action has its inverse: `unlike_post`, `unrepost`, `unfollow`,
`unmute_account`, `unblock_account`. Plus `create_thread`, `delete_post`,
`set_reply_permissions`, `get_quotes`, `get_relationships`, `get_lists`,
`get_notifications`, `mark_notifications_seen`, `get_suggested_follows`,
`list_accounts`, `whoami`.

### Safety

`create_post`, `create_thread`, `delete_post` and `block_account` need
`confirm: true`. `BLUESKY_READ_ONLY=1` removes every write from the tool list,
leaving 26 read tools. `BLUESKY_ALLOW_DESTRUCTIVE=0` keeps likes and follows but
blocks posting and deleting. `BLUESKY_AUDIT_LOG` records every attempted write,
mode 0600. Every tool carries MCP annotations.

### Multi-account

`BLUESKY_ACCOUNTS` takes a JSON array, and every tool that acts as someone takes
an optional `account`. `BLUESKY_DEFAULT_ACCOUNT` decides which acts when none is
named, with exact handle matches beating prefix matches so two similar handles
cannot be confused.

### Reliability

Sessions are cached per account and refreshed rather than re-created, because
creating one is rate limited hard and a session lasts about two hours. Rate
limits and server errors are retried with backoff that honours the reset header.
Requests have a timeout and a minimum interval between them, so a paginating
command stays polite. Reads that need no login go to the public API, so the
server is useful before it is configured.
