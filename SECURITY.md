# Security

## Reporting a vulnerability

[Report it privately](https://github.com/thenavidm/bluesky-mcp-cli/security/advisories/new).
Please do not open a public issue for a security problem: an issue is visible to
everyone the moment you file it, including whoever would use the bug.

Include what you did, what happened, and what you expected. A proof of concept
helps. Reporters are credited in the fix notes unless they would rather not be.

## What this server holds

**An app password**, in `BLUESKY_APP_PASSWORD`. Not your account password, and
that distinction is the point: an app password can be revoked on its own
from Bluesky's settings without changing your real password or touching any
other app.

Use one. Never put your account password in that variable. If you already have,
change your password and issue an app password instead.

**A session cache and an audit log**, in the data directory. The session is a
live credential, so treat that directory the way you would treat a password
manager file.

Nothing leaves your machine except calls to your PDS. No telemetry.

## Write safety

Writes work by default, because posting is the point of the server. A server
where every write needs a flag teaches the operator to set that flag
permanently, which is worse than no protection because it looks like protection.

Three graduated mechanisms instead:

**Approval on the operations that reach other people.** Posting, threads,
deleting, blocking. Over MCP a person approves each one where the client can
ask, in Claude Code's own prompt or an approval form; elsewhere the model must
pass `confirm: true`, and `BLUESKY_CONFIRM=model` allows that everywhere. A post is public the instant it lands, and deleting it does
not pull it out of the feeds, caches and clients that already have it. There is
no unsend.

Likes, reposts, follows and mutes are not guarded. Each is one click to undo,
and approving everything trains people to click yes without reading, which is
worse than not asking.

**`BLUESKY_READ_ONLY=1` removes every write from the tool list.** Not a refusal
at call time: the tools are never registered. A model cannot call a tool it
cannot see, and cannot argue with a refusal it never receives. This is the
setting for pointing an untrusted agent at an account.

**`BLUESKY_AUDIT_LOG=<path>` records every attempted write**, allowed and
blocked alike, one line each, with who approved it. The model has no tool to read or edit that file.

## Untrusted content

Posts, replies, quotes, display names and bios are written by other people.
Anything the timeline or a search returns is text a stranger chose, and
"summarise my notifications" is one of the first things anyone asks.

Treat that content as data to report on, never as instructions. The risk is
highest when writes are enabled, because a reply is a text field aimed at an
agent that can post.

## Running it over HTTP

Over HTTP the server refuses to listen on any address but localhost without
`BLUESKY_HTTP_TOKEN`, and then requires it as a bearer token. It still belongs
behind TLS and a reverse proxy.

Do not expose it directly. It holds a live credential for your account, and an
open endpoint hands it to anyone who finds it.

## Good-faith research

Read, run and pull apart anything here. Nobody but the maintainer can change
this repository, so nothing you do while investigating puts it at risk.

The care is owed to the service the tool talks to, not to the code. When
testing, use your own account and your own data. Do not point it at somebody
else's, and do not hammer a shared API to the point where other people notice.
If a test could affect anyone but you, stop and send a private report first.

Research done in that spirit is welcome, and nothing here is a trap.

## Supported versions

The latest published version gets fixes. Given the size of this project, older
versions do not.
