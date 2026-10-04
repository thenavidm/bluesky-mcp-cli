/**
 * The Bluesky app: everything Slipway needs to ship the MCP server and the CLI.
 *
 * This file only describes. It never starts anything, so `slipway check` and
 * tests can import it; `index.ts` is what runs.
 */

import { createRequire } from "node:module";
import { slipway, type DoctorCheck } from "@thenavidm/slipway";
import { BlueskyClient } from "./api/client.js";
import { AtpError } from "./api/errors.js";
import { loadConfig } from "./config.js";
import { CONCEPTS, INSTRUCTIONS, OUTPUT_FORMAT, PROMPTS } from "./guide.js";
import { ALL_TOOLS } from "./tools/index.js";
import { makeContext, type ToolContext } from "./tools/kit.js";

const require = createRequire(import.meta.url);
export const VERSION: string = (require("../package.json") as { version: string }).version;

/**
 * Network checks only run with `doctor --network`. The failure people actually
 * hit is using the account password instead of an app password: createSession
 * returns a generic 401, so this names the real cause instead of the status.
 */
async function doctor(ctx: ToolContext, options: { network: boolean }): Promise<DoctorCheck[]> {
  const { client, config } = ctx;
  const checks: DoctorCheck[] = [];
  if (config.accounts.length) {
    checks.push({ name: "Accounts", ok: true, detail: config.accounts.map((a) => `${a.handle} @ ${a.service}`).join(", ") });
  }
  if (config.preferred.length) checks.push({ name: "Default account", ok: true, detail: config.preferred.join(", ") });
  if (!options.network) return checks;

  try {
    await client.publicCall("app.bsky.actor.getProfile", { actor: "bsky.app" });
    checks.push({ name: "Public API", ok: true, detail: config.publicApi });
  } catch (error) {
    checks.push({ name: "Public API", ok: false, detail: (error as Error).message, fix: `Check the network, or BLUESKY_PUBLIC_API (${config.publicApi}).` });
  }

  for (const account of config.accounts) {
    try {
      const session = await client.session(account);
      checks.push({ name: `${account.handle} sign-in`, ok: true, detail: session.did });
      const profile = await client.call<{ postsCount?: number; followersCount?: number }>(account, "app.bsky.actor.getProfile", {
        query: { actor: session.did },
      });
      checks.push({ name: `${account.handle} read`, ok: true, detail: `${profile.followersCount ?? 0} followers, ${profile.postsCount ?? 0} posts` });
      // An app password with no write scope authenticates and then fails on the
      // first post. getServiceAuth is the cheapest call that needs real scope.
      try {
        await client.serviceAuth(account, config.videoServiceDid, "app.bsky.video.getUploadLimits", 60);
        checks.push({ name: `${account.handle} write`, ok: true });
      } catch (error) {
        checks.push({ name: `${account.handle} write`, ok: false, warn: true, detail: (error as Error).message, fix: "If posting fails, regenerate the app password." });
      }
    } catch (error) {
      checks.push({
        name: `${account.handle} sign-in`,
        ok: false,
        detail: error instanceof AtpError && error.status === 401 ? "Bluesky rejected these credentials." : (error as Error).message,
        fix: "Use an app password from bsky.app/settings/app-passwords, never the account password.",
      });
    }
  }
  return checks;
}

export const app = slipway<ToolContext>({
  name: "bluesky",
  title: "Bluesky",
  version: VERSION,
  package: "@thenavidm/bluesky-mcp-cli",
  description: "posting, threads, replies, the timeline, search, custom feeds, lists, notifications and the social graph",
  instructions: INSTRUCTIONS,
  context: () => {
    const config = loadConfig();
    return makeContext(new BlueskyClient(config), config);
  },
  configured: (ctx) => ctx.config.accounts.length > 0,
  secrets: (ctx) => ctx.config.accounts.map((account) => account.appPassword),
  tools: ALL_TOOLS,
  resources: [
    {
      name: "bluesky-accounts",
      uri: "bluesky://accounts",
      title: "Connected accounts",
      read: (ctx) => ({
        count: ctx.config.accounts.length,
        accounts: ctx.config.accounts.map((a) => ({ handle: a.handle, service: a.service })),
        read_only: ctx.config.readOnly,
      }),
    },
    { name: "bluesky-concepts", uri: "bluesky://concepts", title: "Bluesky and the AT Protocol", mimeType: "text/markdown", read: () => CONCEPTS },
    { name: "bluesky-output-format", uri: "bluesky://output-format", title: "How posts are returned", mimeType: "text/markdown", read: () => OUTPUT_FORMAT },
  ],
  prompts: PROMPTS.map((prompt) => ({ name: prompt.name, description: prompt.description, render: () => prompt.text })),
  doctor,
  login: [
    "Bluesky needs an app password, never your account password.",
    "",
    "1. Open bsky.app/settings/app-passwords and create one.",
    "2. Set BLUESKY_IDENTIFIER to your full handle, for example you.bsky.social.",
    "3. Set BLUESKY_APP_PASSWORD to the app password.",
    "",
    "For several accounts, set BLUESKY_ACCOUNTS to a JSON array of {handle, app_password}.",
    "Public reads work with nothing set. Run `bluesky-cli doctor --network` to check.",
  ].join("\n"),
  settings: [
    { env: "BLUESKY_IDENTIFIER", description: "Your full handle, for example you.bsky.social." },
    { env: "BLUESKY_APP_PASSWORD", description: "An app password from bsky.app/settings/app-passwords.", secret: true },
    { env: "BLUESKY_ACCOUNTS", description: 'Several accounts at once: [{"handle":"…","app_password":"…"}].', secret: true },
    { env: "BLUESKY_SERVICE_URL", description: "Your PDS. Defaults to https://bsky.social." },
    { env: "BLUESKY_DEFAULT_ACCOUNT", description: "Which handle acts when a tool names none." },
    { env: "BLUESKY_REQUEST_TIMEOUT_MS", description: "Per-request deadline. Defaults to 30000." },
    { env: "BLUESKY_MIN_REQUEST_INTERVAL_MS", description: "Spacing between requests. Defaults to 120." },
    { env: "BLUESKY_MAX_RETRIES", description: "Retries on 429 and 5xx. Defaults to 3." },
    { env: "BLUESKY_PUBLIC_API", description: "Public API for reads that need no account. Defaults to https://public.api.bsky.app." },
    { env: "BLUESKY_VIDEO_SERVICE", description: "Video upload service. Defaults to https://video.bsky.app." },
    { env: "BLUESKY_VIDEO_SERVICE_DID", description: "The video service's DID. Defaults to did:web:video.bsky.app." },
    { env: "BLUESKY_USER_AGENT", description: "Sent on every request. Defaults to bluesky-mcp." },
  ],
  links: { repository: "https://github.com/thenavidm/bluesky-mcp-cli" },
});
