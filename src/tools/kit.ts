/**
 * Shared plumbing every tool uses, now on Slipway.
 *
 * Tool modules keep describing themselves with a Zod shape, a risk and a
 * handler. This adapter turns each into a Slipway tool, so the MCP server, the
 * CLI, the write guard, annotations and errors all come from the framework
 * instead of a copy kept in this repo.
 */

import { toolkit, z, type Risk, type Tool } from "@thenavidm/slipway";
import type { BlueskyClient } from "../api/client.js";
import type { Account, Config } from "../config.js";
import { selectAccount } from "../config.js";

export type ToolContext = {
  client: BlueskyClient;
  config: Config;
  /** Resolve which account this call acts as. */
  account: (hint?: string) => Account;
};

const kit = toolkit<ToolContext>();

/** The optional argument that picks an account, on every account-scoped tool. */
export const accountArg = {
  account: z
    .string()
    .optional()
    .describe(
      "Which connected account to act as, by handle (for example 'alice.bsky.social' or just 'alice'). Defaults to the first connected account. Call list_accounts to see them.",
    ),
};

/**
 * Kept so tool modules read the same, but never sent: Slipway adds `confirm`
 * to every irreversible tool itself, with one description everywhere.
 */
export const confirmArg = {
  confirm: z.boolean().optional(),
};

/** Cursor and limit, on every paginating tool. */
export const pageArgs = {
  limit: z.number().int().min(1).max(100).optional().describe("How many to return per page, 1-100."),
  cursor: z
    .string()
    .optional()
    .describe("Continue from a previous page. Pass the `cursor` attribute from the last result."),
};

type Shape = Record<string, z.ZodType>;

export type ToolSpec<S extends Shape> = {
  name: string;
  /** One line, imperative. Shown in tool pickers. */
  title: string;
  description: string;
  schema: S;
  risk: Risk;
  /** True when the effect is visible to anyone but you. */
  public?: boolean;
  /** True when calling twice has the same effect as calling once. */
  idempotent?: boolean;
  handler: (args: z.infer<z.ZodObject<S>>, ctx: ToolContext) => Promise<unknown>;
  /** One line for the audit log and the confirm message, when this is a write. */
  summary?: (args: z.infer<z.ZodObject<S>>) => string;
};

export type AnyToolSpec = Tool<ToolContext>;

export function defineTool<S extends Shape>(spec: ToolSpec<S>): Tool<ToolContext> {
  const { confirm: _confirm, ...shape } = spec.schema as Shape;
  return kit.defineTool({
    name: spec.name,
    title: spec.title,
    description: spec.description,
    input: z.object(shape),
    risk: spec.risk,
    ...(spec.idempotent !== undefined ? { idempotent: spec.idempotent } : {}),
    ...(spec.summary ? { summary: spec.summary as (args: Record<string, unknown>) => string } : {}),
    handler: spec.handler as (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>,
  });
}

export function makeContext(client: BlueskyClient, config: Config): ToolContext {
  return { client, config, account: (hint?: string) => selectAccount(config, hint) };
}

/** Clamp a caller-supplied limit into a range Bluesky will accept. */
export function clamp(value: number | undefined, fallback: number, max = 100): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), 1), max);
}

/**
 * Page through a cursor endpoint until `max` items or the pages run out.
 *
 * Bluesky caps a page at 100. Asking for "my last 300 posts" is a normal thing
 * to want, and making the model drive the cursor loop by hand costs a round
 * trip per page and usually gets abandoned after the first one.
 */
export async function paginate<T>(
  fetchPage: (cursor: string | undefined, limit: number) => Promise<{ items: T[]; cursor?: string }>,
  max: number,
  options: { pageSize?: number; stop?: (item: T) => boolean } = {},
): Promise<{ items: T[]; cursor?: string; truncated: boolean }> {
  const pageSize = options.pageSize ?? 100;
  const items: T[] = [];
  let cursor: string | undefined;
  // A hard ceiling so a server that keeps returning a cursor cannot spin here.
  const maxPages = Math.max(1, Math.ceil(max / pageSize) + 2);

  for (let page = 0; page < maxPages && items.length < max; page++) {
    const wanted = Math.min(pageSize, max - items.length);
    const result = await fetchPage(cursor, wanted);
    if (result.items.length === 0) return { items, cursor: result.cursor, truncated: false };

    for (const item of result.items) {
      if (options.stop?.(item)) {
        return { items, cursor: undefined, truncated: false };
      }
      items.push(item);
      if (items.length >= max) break;
    }

    cursor = result.cursor;
    if (!cursor) return { items, cursor: undefined, truncated: false };
  }

  return { items, cursor, truncated: Boolean(cursor) };
}
