# Working on bluesky-mcp

For agents editing this repository. Users read the README. Driving the server is
`SKILL.md`.

This repo is the reference implementation for the house standard, so a shortcut
taken here gets copied into every server built afterwards.

## Layout

```
src/app.ts      the Slipway app: tools, settings, doctor. Slipway owns both surfaces, the guard and the audit log
src/guide.ts    server instructions, resources and prompts
src/api/        client, errors, identity resolution
src/content/    facets, media, text. The AT Protocol specifics
src/tools/      one module per group, registered in tools/index.ts
```

## Non-negotiables

**Commit as `n@navid.me`.** Never pass `-c user.email=`. The global config is
correct and the override is the bug: the wrong address credits a blocked account
and the Contributors panel reads 0.

**Writes are on by default.** `BLUESKY_READ_ONLY=1` is the opt-out and it works
by not registering the write tools, not by refusing at call time. A model cannot
call a tool it cannot see.

**`confirm: true` on operations that reach other people only.** Posting,
threads, deleting, blocking. Not likes, reposts, follows or mutes. The test is
not "does it write" but "can the person undo it in one action from their own
client". Confirming everything is what makes the confirmation on a delete
worthless.

**Every anticipated failure is an `AtpError` subclass** from `api/errors.ts`.
Slipway maps its HTTP status to the exit code and keeps its message, so a plain
`Error` reaches the model as an unexpected failure with your explanation lost.

**Facets are computed, never accepted from the caller.** `content/facets.ts`
turns URLs, hashtags and mentions into real links. Byte offsets, not character
offsets: the AT Protocol counts UTF-8 bytes, so an emoji shifts every facet
after it if you count characters.

**`create_thread` validates every part before posting any**, so a thread cannot
half-publish because part four was too long.

**Never add anything that automates the follow graph.** It is what gets accounts
limited.

## Before claiming it works

```bash
npm run build && npm test && npm run typecheck
npx @modelcontextprotocol/inspector node dist/index.js
```

A green suite is not a working server. Run the handshake.
