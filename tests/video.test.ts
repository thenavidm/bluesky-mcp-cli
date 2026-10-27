/**
 * A post's video from a file on this machine, against a fake Bluesky: nothing
 * here reaches the network or a real account.
 *
 * What matters: the upload token is addressed to the account's own PDS and
 * scoped to com.atproto.repo.uploadBlob, as Bluesky's docs say; the bytes go to
 * the video service and the post waits for the blob; the embed carries the
 * file's aspect ratio, so a 9:16 video shows upright; a bad file fails before
 * anything is sent; and posting still asks first.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cli } from "@thenavidm/slipway/testing";
import { pdsFromDidDoc } from "../src/api/client.js";
import { app } from "../src/app.js";
import { loadVideo, MAX_VIDEO_BYTES } from "../src/content/media.js";
import { probeVideoBytes } from "../src/content/mp4.js";

const scratch = mkdtempSync(join(tmpdir(), "bluesky-video-"));

// A real MP4 header, built box by box.
const ascii = (s: string) => new TextEncoder().encode(s);
const u32 = (n: number) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0);
  return b;
};
const cat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
};
const box = (type: string, ...payload: Uint8Array[]) => {
  const body = cat(...payload);
  return cat(u32(8 + body.byteLength), ascii(type), body);
};
const zeros = (n: number) => new Uint8Array(n);
const ONE16 = 0x10000;

function mp4(width: number, height: number, turned = false): Uint8Array {
  const matrix = turned ? [0, ONE16, 0, -ONE16, 0, 0, 0, 0, 0x40000000] : [ONE16, 0, 0, 0, ONE16, 0, 0, 0, 0x40000000];
  const mvhd = box("mvhd", zeros(4), zeros(8), u32(1000), u32(30_000), zeros(80));
  const tkhd = box("tkhd", u32(3), zeros(20), zeros(16), ...matrix.map(u32), u32(width * ONE16), u32(height * ONE16));
  const hdlr = box("hdlr", zeros(4), zeros(4), ascii("vide"), zeros(12), zeros(1));
  return cat(box("ftyp", ascii("isom"), zeros(4), ascii("isom")), box("moov", mvhd, box("trak", tkhd, box("mdia", hdlr))), box("mdat", zeros(1024)));
}

function file(name: string, bytes: Uint8Array): string {
  const path = join(scratch, name);
  writeFileSync(path, bytes);
  return path;
}

describe("reading a local video", () => {
  it("finds the PDS in a DID document", () => {
    expect(pdsFromDidDoc({ service: [{ id: "#atproto_pds", type: "AtprotoPersonalDataServer", serviceEndpoint: "https://morel.us-east.host.bsky.network/" }] })).toBe(
      "https://morel.us-east.host.bsky.network",
    );
    expect(pdsFromDidDoc({})).toBeUndefined();
  });

  it("reads a 9:16 aspect ratio from the file, upright even when the phone stored it turned", async () => {
    expect((await loadVideo({ path: file("v.mp4", mp4(1080, 1920)) }, 1000)).aspectRatio).toEqual({ width: 9, height: 16 });
    expect((await loadVideo({ path: file("turned.mov", mp4(1920, 1080, true)) }, 1000))).toMatchObject({ aspectRatio: { width: 9, height: 16 }, contentType: "video/quicktime" });
    expect(await probeVideoBytes(ascii("plain text"))).toBeUndefined();
  });

  it("refuses what Bluesky will not take, before anything is sent", async () => {
    await expect(loadVideo({ path: file("clip.avi", zeros(10)) }, 1000)).rejects.toThrow(/MP4, MOV, WebM or MPEG/);
    await expect(loadVideo({ path: join(scratch, "missing.mp4") }, 1000)).rejects.toThrow(/does not exist/);
    await expect(loadVideo({ path: file("empty.mp4", zeros(0)) }, 1000)).rejects.toThrow(/empty/);
    expect(MAX_VIDEO_BYTES).toBe(300_000_000);
  });
});

type Seen = { url: URL; method: string; headers: Record<string, string>; body?: unknown };

/** A fake PDS and video service. */
function fakeBluesky() {
  const seen: Seen[] = [];
  const jwt = `x.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.y`;
  const blob = { $type: "blob", ref: { $link: "bafkreivideo" }, mimeType: "video/mp4", size: 1234 };
  let polls = 0;
  const fn = vi.fn(async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    seen.push({ url, method: init.method ?? "GET", headers, body: init.body });
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    switch (url.pathname) {
      case "/xrpc/com.atproto.server.createSession":
        return json({
          accessJwt: jwt,
          refreshJwt: jwt,
          did: "did:plc:alice",
          handle: "alice.bsky.social",
          didDoc: { service: [{ id: "#atproto_pds", type: "AtprotoPersonalDataServer", serviceEndpoint: "https://morel.us-east.host.bsky.network" }] },
        });
      case "/xrpc/com.atproto.server.getServiceAuth":
        return json({ token: `token:${url.searchParams.get("aud")}:${url.searchParams.get("lxm")}` });
      case "/xrpc/app.bsky.video.getUploadLimits":
        return json({ canUpload: true, remainingDailyVideos: 20, remainingDailyBytes: 10_000_000_000 });
      case "/xrpc/app.bsky.video.uploadVideo":
        // The service answers with the job itself, as Bluesky's own app reads it.
        return json({ jobId: "job-1", did: "did:plc:alice", state: "JOB_STATE_CREATED" });
      case "/xrpc/app.bsky.video.getJobStatus":
        polls++;
        return json({ jobStatus: { jobId: "job-1", did: "did:plc:alice", state: "JOB_STATE_COMPLETED", blob } });
      case "/xrpc/com.atproto.repo.createRecord":
        return json({ uri: "at://did:plc:alice/app.bsky.feed.post/3kpost", cid: "bafypost" });
    }
    throw new Error(`unexpected request to ${url}`);
  });
  return { fn, seen, blob, polls: () => polls };
}

const saved = { ...process.env };
afterEach(() => {
  vi.unstubAllGlobals();
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
});

/** The app reads its account from process.env, not from the env a test hands the in-process CLI. */
function signIn(): void {
  for (const key of Object.keys(process.env)) if (key.startsWith("BLUESKY_")) delete process.env[key];
  Object.assign(process.env, { BLUESKY_IDENTIFIER: "alice.bsky.social", BLUESKY_APP_PASSWORD: "app-pass", BLUESKY_MIN_REQUEST_INTERVAL_MS: "1" });
}

describe("create_post with a local video", () => {
  it("refuses without --confirm, naming the file and what posting does, before anything is sent", async () => {
    signIn();
    const bluesky = fakeBluesky();
    vi.stubGlobal("fetch", bluesky.fn);
    const run = await cli(app, ["create-post", "--text", "hello", "--video-path", file("clip.mp4", mp4(1080, 1920))], { env: {} });
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("with clip.mp4");
    expect(run.stderr).toContain("does not pull it out of feeds");
    expect(bluesky.fn).not.toHaveBeenCalled();
  });

  it("uploads through the video service with a token for the PDS, then posts the blob at 9:16", async () => {
    signIn();
    const bluesky = fakeBluesky();
    vi.stubGlobal("fetch", bluesky.fn);
    const path = file("short.mp4", mp4(1080, 1920));
    const run = await cli(app, ["create-post", "--text", "hello", "--video-path", path, "--video-alt", "A short clip", "--confirm", "--json"], { env: {} });
    expect(run.stderr).toBe("");
    expect(run.code).toBe(0);

    const auths = bluesky.seen.filter((s) => s.url.pathname.endsWith("getServiceAuth")).map((s) => [s.url.searchParams.get("aud"), s.url.searchParams.get("lxm")]);
    expect(auths).toContainEqual(["did:web:video.bsky.app", "app.bsky.video.getUploadLimits"]);
    expect(auths).toContainEqual(["did:web:morel.us-east.host.bsky.network", "com.atproto.repo.uploadBlob"]);

    const upload = bluesky.seen.find((s) => s.url.pathname.endsWith("uploadVideo"))!;
    expect(upload.url.origin).toBe("https://video.bsky.app");
    expect(upload.url.searchParams.get("did")).toBe("did:plc:alice");
    expect(upload.url.searchParams.get("name")).toMatch(/\.mp4$/);
    expect(upload.headers.authorization).toBe("Bearer token:did:web:morel.us-east.host.bsky.network:com.atproto.repo.uploadBlob");
    expect(upload.headers["content-type"]).toBe("video/mp4");
    expect((upload.body as Blob).size).toBe(mp4(1080, 1920).byteLength);

    const create = bluesky.seen.find((s) => s.url.pathname.endsWith("createRecord"))!;
    expect(JSON.parse(String(create.body)).record.embed).toEqual({
      $type: "app.bsky.embed.video",
      video: bluesky.blob,
      alt: "A short clip",
      aspectRatio: { width: 9, height: 16 },
    });
    expect(bluesky.polls()).toBe(1);
  });

  it("takes one video, not a URL and a file at once", async () => {
    signIn();
    vi.stubGlobal("fetch", fakeBluesky().fn);
    const run = await cli(
      app,
      ["create-post", "--text", "hello", "--video-url", "https://example.com/a.mp4", "--video-path", file("both.mp4", mp4(1080, 1920)), "--confirm"],
      { env: {} },
    );
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("not both");
  });
});
