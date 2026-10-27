/**
 * The XRPC client: one session per account, refreshed rather than re-minted.
 *
 * Three things worth knowing.
 *
 * Sessions are cached and refreshed. `createSession` is rate limited hard by
 * Bluesky, and an access JWT lasts about two hours while a refresh JWT lasts
 * months. Logging in on every tool call burns the create-session budget and
 * starts failing on a busy day. Here a session is minted once per account,
 * refreshed with
 * `com.atproto.server.refreshSession` when it expires, and only re-minted from
 * the app password if the refresh itself fails.
 *
 * Reads that need no session go to the public appview. That is not just
 * politeness. It means `get_profile` and `get_author_feed` work before you
 * have configured any credentials at all, which is the difference between a
 * server that is useless until set up and one that is useful immediately.
 *
 * 429 and 5xx are retried with backoff that honours `ratelimit-reset`, which
 * Bluesky does actually send.
 */

import { setTimeout as delay } from "node:timers/promises";
import type { Account, Config } from "../config.js";
import { AtpError, errorFor, isExpiredToken, parseErrorBody, TimeoutError } from "./errors.js";

export type Session = {
  accessJwt: string;
  refreshJwt: string;
  did: string;
  handle: string;
  service: string;
  /** Unix ms when the access JWT expires, read from its `exp` claim. */
  expiresAt: number;
  /** The account's own PDS, from the DID document the session carried. Not the entryway, such as bsky.social. */
  pdsUrl?: string;
};

/** The `#atproto_pds` endpoint of a DID document, if it names one. */
export function pdsFromDidDoc(doc: unknown): string | undefined {
  const services = (doc as { service?: { id?: string; type?: string; serviceEndpoint?: unknown }[] } | undefined)?.service;
  if (!Array.isArray(services)) return undefined;
  const pds = services.find((s) => typeof s?.id === "string" && s.id.endsWith("#atproto_pds"));
  return typeof pds?.serviceEndpoint === "string" ? pds.serviceEndpoint.replace(/\/+$/, "") : undefined;
}

type CallInit = {
  method?: "GET" | "POST";
  query?: Record<string, unknown>;
  body?: unknown;
  /** Raw bytes plus their content type, for blob uploads. */
  blob?: { bytes: Uint8Array; contentType: string };
  /** Override the bearer token, for service-auth calls. */
  token?: string;
  /** Override the host, for the video service. */
  service?: string;
};

/** Decode a JWT's `exp` claim without verifying it. We only need the clock. */
function expiryOf(jwt: string): number {
  const part = jwt.split(".")[1];
  if (!part) return 0;
  try {
    const json = Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const claims = JSON.parse(json) as { exp?: number };
    return typeof claims.exp === "number" ? claims.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

/** Refresh a minute early, so a call never races the expiry it just checked. */
const EXPIRY_SKEW_MS = 60_000;

export class BlueskyClient {
  private readonly config: Config;
  private readonly sessions = new Map<string, Session>();
  /** In-flight logins, so N concurrent tool calls mint one session, not N. */
  private readonly pending = new Map<string, Promise<Session>>();
  private lastRequestAt = 0;

  constructor(config: Config) {
    this.config = config;
  }

  /** Every account this client can act as. */
  get accounts(): Account[] {
    return this.config.accounts;
  }

  /** A live session for `account`, minting or refreshing as needed. */
  async session(account: Account): Promise<Session> {
    const key = `${account.service}|${account.handle}`;

    const cached = this.sessions.get(key);
    if (cached && cached.expiresAt - EXPIRY_SKEW_MS > Date.now()) return cached;

    const inFlight = this.pending.get(key);
    if (inFlight) return inFlight;

    const work = (async (): Promise<Session> => {
      if (cached) {
        try {
          const refreshed = await this.refresh(cached);
          this.sessions.set(key, refreshed);
          return refreshed;
        } catch {
          // The refresh token is gone too. Fall through to a full login.
        }
      }
      const fresh = await this.login(account);
      this.sessions.set(key, fresh);
      return fresh;
    })().finally(() => this.pending.delete(key));

    this.pending.set(key, work);
    return work;
  }

  /** Discard the cached session for an account. Used by `doctor` and tests. */
  forget(account: Account): void {
    this.sessions.delete(`${account.service}|${account.handle}`);
  }

  private async login(account: Account): Promise<Session> {
    const data = (await this.raw("com.atproto.server.createSession", {
      method: "POST",
      service: account.service,
      body: { identifier: account.handle, password: account.appPassword },
    })) as { accessJwt: string; refreshJwt: string; did: string; handle: string; didDoc?: unknown };

    const pdsUrl = pdsFromDidDoc(data.didDoc);
    return {
      accessJwt: data.accessJwt,
      refreshJwt: data.refreshJwt,
      did: data.did,
      handle: data.handle,
      service: account.service,
      expiresAt: expiryOf(data.accessJwt) || Date.now() + 90 * 60_000,
      ...(pdsUrl ? { pdsUrl } : {}),
    };
  }

  private async refresh(session: Session): Promise<Session> {
    const data = (await this.raw("com.atproto.server.refreshSession", {
      method: "POST",
      service: session.service,
      token: session.refreshJwt,
    })) as { accessJwt: string; refreshJwt: string; did: string; handle: string; didDoc?: unknown };

    const pdsUrl = pdsFromDidDoc(data.didDoc) ?? session.pdsUrl;
    return {
      ...session,
      accessJwt: data.accessJwt,
      refreshJwt: data.refreshJwt,
      did: data.did,
      handle: data.handle,
      expiresAt: expiryOf(data.accessJwt) || Date.now() + 90 * 60_000,
      ...(pdsUrl ? { pdsUrl } : {}),
    };
  }

  /**
   * The account's own PDS. A session from bsky.social names it in the DID
   * document it carries; failing that, the DID document is read from the PLC
   * directory or the did:web host, and failing that, the service signed in to.
   * The video service's upload token is addressed to this, not to bsky.social.
   */
  async pdsUrl(account: Account): Promise<string> {
    const session = await this.session(account);
    if (session.pdsUrl) return session.pdsUrl;
    try {
      const did = session.did;
      const url = did.startsWith("did:plc:")
        ? `https://plc.directory/${did}`
        : did.startsWith("did:web:")
          ? `https://${decodeURIComponent(did.slice("did:web:".length))}/.well-known/did.json`
          : undefined;
      if (url) {
        const response = await fetch(url, { headers: { "user-agent": this.config.userAgent } });
        const found = response.ok ? pdsFromDidDoc(await response.json()) : undefined;
        if (found) {
          session.pdsUrl = found;
          return found;
        }
      }
    } catch {
      // Fall back to the service the account signs in to, which is its PDS when it is self-hosted.
    }
    return session.service;
  }

  /**
   * Call an authenticated endpoint as `account`.
   *
   * One retry on `ExpiredToken` after forcing a refresh, because a session can
   * expire between the check and the call.
   */
  async call<T = Record<string, unknown>>(
    account: Account,
    nsid: string,
    init: CallInit = {},
  ): Promise<T> {
    const session = await this.session(account);
    try {
      return (await this.raw(nsid, {
        ...init,
        service: init.service ?? session.service,
        token: init.token ?? session.accessJwt,
      })) as T;
    } catch (error) {
      if (error instanceof AtpError && isExpiredToken(error.status, error.code) && !init.token) {
        this.forget(account);
        const retried = await this.session(account);
        return (await this.raw(nsid, {
          ...init,
          service: init.service ?? retried.service,
          token: retried.accessJwt,
        })) as T;
      }
      throw error;
    }
  }

  /** Call a read endpoint on the public appview. No session, no credentials. */
  async publicCall<T = Record<string, unknown>>(
    nsid: string,
    query: Record<string, unknown> = {},
  ): Promise<T> {
    return (await this.raw(nsid, { query, service: this.config.publicApi })) as T;
  }

  /**
   * Mint a short-lived service-auth token, for calls to a service that is not
   * the account's own PDS. The video service is the only user today.
   */
  async serviceAuth(account: Account, aud: string, lxm: string, ttlSec = 1800): Promise<string> {
    const data = (await this.call(account, "com.atproto.server.getServiceAuth", {
      query: { aud, lxm, exp: Math.floor(Date.now() / 1000) + Math.floor(ttlSec) },
    })) as { token: string };
    return data.token;
  }

  /** The one place a request actually leaves the process. */
  private async raw(nsid: string, init: CallInit): Promise<unknown> {
    const service = init.service ?? this.config.publicApi;
    const url = new URL(`${service}/xrpc/${nsid}`);
    for (const [key, value] of Object.entries(init.query ?? {})) {
      if (value === undefined || value === null || value === "") continue;
      if (Array.isArray(value)) {
        for (const v of value) url.searchParams.append(key, String(v));
      } else {
        url.searchParams.set(key, String(value));
      }
    }

    const method = init.method ?? (init.body || init.blob ? "POST" : "GET");
    const headers: Record<string, string> = { "user-agent": this.config.userAgent };
    if (init.token) headers.authorization = `Bearer ${init.token}`;

    let body: RequestInit["body"];
    if (init.blob) {
      headers["content-type"] = init.blob.contentType;
      body = Buffer.from(init.blob.bytes) as unknown as RequestInit["body"];
    } else if (init.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(init.body);
    }

    let lastError: AtpError | undefined;
    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      await this.throttle();

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
      let response: Response;
      try {
        response = await fetch(url, { method, headers, body, signal: controller.signal });
      } catch (error) {
        clearTimeout(timer);
        const aborted = (error as Error)?.name === "AbortError";
        lastError = aborted
          ? new TimeoutError(
              `${nsid} did not respond within ${this.config.requestTimeoutMs}ms.`,
              408,
              nsid,
              "Timeout",
            )
          : new AtpError(
              `Could not reach ${service}: ${(error as Error)?.message ?? String(error)}`,
              0,
              nsid,
              "NetworkError",
            );
        if (attempt < this.config.maxRetries) {
          await delay(backoffMs(attempt));
          continue;
        }
        throw lastError;
      }
      clearTimeout(timer);

      const text = await response.text();

      if (response.ok) {
        // uploadBlob and a few others answer with an empty body on success.
        if (!text) return {};
        try {
          return JSON.parse(text) as unknown;
        } catch {
          return { raw: text };
        }
      }

      const error = errorFor(response.status, nsid, text, response.headers);
      lastError = error;

      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt === this.config.maxRetries) throw error;

      const reset = response.headers.get("ratelimit-reset");
      const waitMs =
        response.status === 429 && reset && /^\d+$/.test(reset)
          ? Math.max(0, Number(reset) * 1000 - Date.now()) + 250
          : backoffMs(attempt);
      // A reset an hour out is not something to sit on inside a tool call.
      if (waitMs > 60_000) throw error;
      await delay(waitMs);
    }

    throw lastError ?? new AtpError(`${nsid} failed.`, 0, nsid);
  }

  /** Keep a minimum gap between requests, so a paginating tool stays polite. */
  private async throttle(): Promise<void> {
    const gap = this.config.minRequestIntervalMs;
    if (gap <= 0) return;
    const wait = this.lastRequestAt + gap - Date.now();
    if (wait > 0) await delay(wait);
    this.lastRequestAt = Date.now();
  }
}

/** 400ms, 800ms, 1600ms, with jitter, so parallel callers do not resynchronise. */
function backoffMs(attempt: number): number {
  return 400 * 2 ** attempt + Math.floor(Math.random() * 200);
}

/** Turn an unknown error into the `{error, message}` pair a tool can report. */
export function describeError(error: unknown): Record<string, unknown> {
  if (error instanceof AtpError) return error.toJSON();
  const message = (error as Error)?.message ?? String(error);
  const parsed = parseErrorBody(message);
  return { error: message, ...(parsed.code ? { code: parsed.code } : {}) };
}
