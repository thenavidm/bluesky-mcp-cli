/**
 * Getting images and video onto Bluesky.
 *
 * Images are a blob upload with a hard 1,000,000-byte ceiling that the server
 * enforces with an unhelpful error, so the size is checked here and reported in
 * megabytes with the actual limit named.
 *
 * Video is the interesting one. Bluesky's docs give two ways
 * (https://bsky.network/docs/about-bluesky-content/video). Uploading it to the
 * PDS with `com.atproto.repo.uploadBlob` works, but the video service only
 * starts processing once the post is in the firehose, so the post shows a
 * missing video for a while. The recommended way, used here, sends it to the
 * video service first: a service-auth token whose audience is the account's own
 * PDS and whose scope is `com.atproto.repo.uploadBlob`, 30 minutes long, the
 * bytes POSTed to `app.bsky.video.uploadVideo` on video.bsky.app, then
 * `app.bsky.video.getJobStatus` until it hands back the blob, which the post
 * embeds with the video's aspect ratio.
 *
 * The video comes from a public URL, a data: URI, or a file on this machine.
 * A file is read as a Blob, so it streams from disk instead of sitting in memory.
 */

import { openAsBlob } from "node:fs";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, isAbsolute, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { BlueskyClient } from "../api/client.js";
import type { Account, Config } from "../config.js";
import { AtpError, NotFoundError, ValidationError } from "../api/errors.js";
import { probeVideoBytes, probeVideoFile } from "./mp4.js";

/** The `{$type: blob, ref, mimeType, size}` record a post embed points at. */
export type BlobRef = Record<string, unknown>;

export type Fetched = { bytes: Uint8Array; contentType: string; source: string };

/** Bluesky rejects image blobs over this. The message it returns does not say so. */
export const MAX_IMAGE_BYTES = 1_000_000;

/**
 * `app.bsky.embed.video` takes a video "up to 300mb, formerly limited to 100mb"
 * (maxSize 300000000). The service enforces length and the daily allowance,
 * which getUploadLimits reports before anything is sent.
 */
export const MAX_VIDEO_BYTES = 300_000_000;

/** The types Bluesky's own app sends to the video service. */
const VIDEO_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mpeg": "video/mpeg",
  ".mpg": "video/mpeg",
};

/**
 * Read media from a public URL or a data: URI.
 *
 * A `data:` URI is accepted because a model that just generated an image has
 * bytes, not a URL, and making it find somewhere to host them first is a
 * pointless detour.
 */
export async function fetchMedia(source: string, timeoutMs = 30_000): Promise<Fetched> {
  const trimmed = source.trim();

  if (trimmed.startsWith("data:")) {
    // [\s\S] rather than the `s` flag: dotAll needs an ES2018 target and this
    // file also compiles inside an app that targets ES2017.
    const match = trimmed.match(/^data:([^;,]+)?(;base64)?,([\s\S]*)$/);
    if (!match) throw new ValidationError("Malformed data: URI.", 400, "(local)", "InvalidRequest");
    const contentType = match[1] || "application/octet-stream";
    const bytes = match[2]
      ? new Uint8Array(Buffer.from(match[3] ?? "", "base64"))
      : new TextEncoder().encode(decodeURIComponent(match[3] ?? ""));
    return { bytes, contentType, source: "data: URI" };
  }

  if (!/^https?:\/\//i.test(trimmed)) {
    throw new ValidationError(
      `Media must be a public http(s) URL or a data: URI. Got "${source.slice(0, 80)}".`,
      400,
      "(local)",
      "InvalidRequest",
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(trimmed, { signal: controller.signal });
    if (!response.ok) {
      throw new AtpError(
        `Could not fetch media at ${trimmed} (HTTP ${response.status}). It must be reachable without authentication.`,
        response.status,
        "(fetch)",
        "MediaUnreachable",
      );
    }
    return {
      bytes: new Uint8Array(await response.arrayBuffer()),
      contentType: response.headers.get("content-type")?.split(";")[0]?.trim() || "application/octet-stream",
      source: trimmed,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Pixel dimensions from the file header, for the embed's `aspectRatio`.
 *
 * Without it Bluesky guesses, and a tall screenshot gets letterboxed into a
 * square in the timeline. PNG, JPEG, GIF and WebP cover essentially everything
 * a post carries; anything else returns undefined and Bluesky falls back to
 * exactly the behavior it has today.
 */
export function imageSize(bytes: Uint8Array): { width: number; height: number } | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u8 = bytes;

  // PNG: 8-byte signature, then an IHDR chunk whose width/height are at 16..24.
  if (u8.length > 24 && u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4e && u8[3] === 0x47) {
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }

  // GIF: "GIF8", then little-endian width and height.
  if (u8.length > 10 && u8[0] === 0x47 && u8[1] === 0x49 && u8[2] === 0x46) {
    return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
  }

  // WebP: "RIFF"…"WEBP", then one of three chunk layouts.
  if (
    u8.length > 30 &&
    u8[0] === 0x52 && u8[1] === 0x49 && u8[2] === 0x46 && u8[3] === 0x46 &&
    u8[8] === 0x57 && u8[9] === 0x45 && u8[10] === 0x42 && u8[11] === 0x50
  ) {
    const chunk = String.fromCharCode(u8[12]!, u8[13]!, u8[14]!, u8[15]!);
    if (chunk === "VP8 ") {
      return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
    }
    if (chunk === "VP8L") {
      const bits = view.getUint32(21, true);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (chunk === "VP8X") {
      const w = 1 + (u8[24]! | (u8[25]! << 8) | (u8[26]! << 16));
      const h = 1 + (u8[27]! | (u8[28]! << 8) | (u8[29]! << 16));
      return { width: w, height: h };
    }
  }

  // JPEG: walk the segment chain to the SOFn frame header that carries the size.
  if (u8.length > 4 && u8[0] === 0xff && u8[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < u8.length) {
      if (u8[offset] !== 0xff) {
        offset++;
        continue;
      }
      const marker = u8[offset + 1]!;
      // SOF0-SOF3, SOF5-SOF7, SOF9-SOF11, SOF13-SOF15 carry dimensions.
      // DHT (c4), JPG (c8) and DAC (cc) sit in the same range and do not.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: view.getUint16(offset + 5), width: view.getUint16(offset + 7) };
      }
      const length = view.getUint16(offset + 2);
      if (length < 2) break;
      offset += 2 + length;
    }
  }

  return undefined;
}

/** Reduce a width/height to the smallest equivalent ratio, which is what the lexicon wants. */
export function aspectRatio(size: { width: number; height: number } | undefined) {
  if (!size || !size.width || !size.height) return undefined;
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  const d = gcd(size.width, size.height) || 1;
  return { width: Math.round(size.width / d), height: Math.round(size.height / d) };
}

/** Upload an image and return its blob ref plus the aspect ratio to embed with it. */
export async function uploadImage(
  client: BlueskyClient,
  account: Account,
  source: string,
  timeoutMs: number,
): Promise<{ blob: BlobRef; aspectRatio?: { width: number; height: number } }> {
  const media = await fetchMedia(source, timeoutMs);

  if (media.bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new ValidationError(
      `Image is ${(media.bytes.byteLength / 1e6).toFixed(2)}MB; Bluesky's limit is 1MB. Resize or re-encode it before posting. The server's own error for this does not say what went wrong.`,
      400,
      "com.atproto.repo.uploadBlob",
      "BlobTooLarge",
    );
  }
  if (!media.contentType.startsWith("image/")) {
    throw new ValidationError(
      `${media.source} is ${media.contentType}, not an image.`,
      400,
      "(local)",
      "InvalidRequest",
    );
  }

  const result = await client.call<{ blob: BlobRef }>(account, "com.atproto.repo.uploadBlob", {
    method: "POST",
    blob: { bytes: media.bytes, contentType: media.contentType },
  });

  return { blob: result.blob, aspectRatio: aspectRatio(imageSize(media.bytes)) };
}

type JobStatus = {
  jobId: string;
  did: string;
  state: string;
  progress?: number;
  blob?: BlobRef;
  error?: string;
  failureCode?: string;
  message?: string;
};

/** `~/clip.mp4` and relative paths as the shell would read them. */
export function localPath(raw: string): string {
  const trimmed = raw.trim();
  const expanded = trimmed === "~" || trimmed.startsWith("~/") ? `${homedir()}${trimmed.slice(1)}` : trimmed;
  return isAbsolute(expanded) ? expanded : resolve(expanded);
}

/** What `uploadVideo` sends: the bytes, or a file to stream, with its type and shape. */
type VideoBody = { body: Blob | Uint8Array; size: number; contentType: string; name: string; aspectRatio?: { width: number; height: number } };

/** Read a video from a URL, a data: URI or a local file, and check it before anything is sent. */
export async function loadVideo(source: { url?: string; path?: string }, timeoutMs: number): Promise<VideoBody> {
  if (source.path) {
    const path = localPath(source.path);
    const contentType = VIDEO_TYPES[extname(path).toLowerCase()];
    if (!contentType) {
      throw new ValidationError(`${basename(path)} is not a video Bluesky takes: MP4, MOV, WebM or MPEG.`, 400, "(local)", "InvalidRequest");
    }
    let size: number;
    try {
      const info = await stat(path);
      if (!info.isFile()) throw new ValidationError(`${path} is not a file.`, 400, "(local)", "InvalidRequest");
      size = info.size;
    } catch (error) {
      if (error instanceof AtpError) throw error;
      throw new NotFoundError(`${path} does not exist or cannot be read on the machine running this server.`, 404, "(local)", "FileNotFound");
    }
    checkVideoSize(size);
    const shape = await probeVideoFile(path, size);
    return { body: await openAsBlob(path, { type: contentType }), size, contentType, name: basename(path), aspectRatio: aspectRatio(shape) };
  }

  const media = await fetchMedia(source.url ?? "", timeoutMs);
  if (!media.contentType.startsWith("video/")) {
    throw new ValidationError(`${media.source} is ${media.contentType}, not a video.`, 400, "(local)", "InvalidRequest");
  }
  checkVideoSize(media.bytes.byteLength);
  const ext = Object.entries(VIDEO_TYPES).find(([, type]) => type === media.contentType)?.[0] ?? ".mp4";
  return {
    body: media.bytes,
    size: media.bytes.byteLength,
    contentType: media.contentType,
    name: `video${ext}`,
    aspectRatio: aspectRatio(await probeVideoBytes(media.bytes)),
  };
}

function checkVideoSize(size: number): void {
  if (size === 0) throw new ValidationError("The video is empty.", 400, "(local)", "InvalidRequest");
  if (size > MAX_VIDEO_BYTES) {
    throw new ValidationError(
      `Video is ${(size / 1e6).toFixed(1)}MB, over the ${MAX_VIDEO_BYTES / 1e6}MB that app.bsky.embed.video allows.`,
      400,
      "app.bsky.video.uploadVideo",
      "VideoTooLarge",
    );
  }
}

/**
 * Upload a video through the video service and wait for the blob.
 *
 * Four steps, as Bluesky's docs give them:
 *   1. `getUploadLimits`, with a token for the video service. Refuses early
 *      when the daily allowance is spent or the account's email is unverified
 *   2. `getServiceAuth` addressed to the account's own PDS, scoped to
 *      `com.atproto.repo.uploadBlob`, for 30 minutes: the video service uses it
 *      to store the processed video on the PDS for you
 *   3. `uploadVideo`, which returns a job, not a blob
 *   4. `getJobStatus` until a blob comes back. The docs say to look for the
 *      blob whatever the state: a video the service has seen before comes back
 *      as `already_exists` with the earlier blob
 */
export async function uploadVideo(
  client: BlueskyClient,
  account: Account,
  config: Config,
  source: { url?: string; path?: string },
  options: { signal?: AbortSignal; onProgress?: (status: JobStatus) => void; pollMs?: number } = {},
): Promise<{ blob: BlobRef; aspectRatio?: { width: number; height: number } }> {
  const video = await loadVideo(source, config.requestTimeoutMs);

  const session = await client.session(account);
  const limitsToken = await client.serviceAuth(account, config.videoServiceDid, "app.bsky.video.getUploadLimits");
  const limits = await client.call<{
    canUpload: boolean;
    message?: string;
    error?: string;
    remainingDailyVideos?: number;
    remainingDailyBytes?: number;
  }>(account, "app.bsky.video.getUploadLimits", {
    service: config.videoService,
    token: limitsToken,
  });

  if (!limits.canUpload) {
    throw new ValidationError(
      `Bluesky will not accept a video upload right now: ${limits.message ?? limits.error ?? "the daily limit is spent"}. Bluesky-hosted accounts must also have verified their email before posting video.`,
      400,
      "app.bsky.video.getUploadLimits",
      "UploadLimitReached",
    );
  }
  if (limits.remainingDailyBytes !== undefined && video.size > limits.remainingDailyBytes) {
    throw new ValidationError(
      `This video is ${(video.size / 1e6).toFixed(1)}MB, and Bluesky allows ${(limits.remainingDailyBytes / 1e6).toFixed(1)}MB more video today.`,
      400,
      "app.bsky.video.getUploadLimits",
      "UploadLimitReached",
    );
  }

  const pds = new URL(await client.pdsUrl(account));
  const uploadToken = await client.serviceAuth(account, `did:web:${pds.hostname}`, "com.atproto.repo.uploadBlob", 30 * 60);

  const url = new URL(`${config.videoService}/xrpc/app.bsky.video.uploadVideo`);
  url.searchParams.set("did", session.did);
  url.searchParams.set("name", `${Date.now()}-${Math.random().toString(36).slice(2, 10)}${extname(video.name).toLowerCase() || ".mp4"}`);
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${uploadToken}`,
        "content-type": video.contentType,
        "user-agent": config.userAgent,
      },
      body: video.body instanceof Uint8Array ? Buffer.from(video.body) : video.body,
      signal: options.signal,
    });
  } catch (error) {
    throw new AtpError(
      `Could not reach ${config.videoService} to upload the video: ${(error as Error)?.message ?? String(error)}`,
      0,
      "app.bsky.video.uploadVideo",
      "NetworkError",
    );
  }
  const text = await response.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    // Not JSON; the status below says what happened.
  }
  // The lexicon wraps the job in `jobStatus`; the service has also answered with the job itself.
  let status = ((parsed.jobStatus as JobStatus | undefined) ?? parsed) as JobStatus;
  if (!status.jobId && !status.blob) {
    throw new AtpError(
      `Bluesky's video service did not take the upload (HTTP ${response.status}): ${String(parsed.message ?? parsed.error ?? (text.slice(0, 200) || "no reason given"))}.`,
      response.status || 400,
      "app.bsky.video.uploadVideo",
      String(parsed.error ?? "UploadFailed"),
    );
  }
  options.onProgress?.(status);

  // Transcoding a short clip takes seconds; the ceiling is here so a stuck job
  // fails with an explanation instead of holding the tool call open forever.
  const pollMs = options.pollMs ?? 2_000;
  const deadline = Date.now() + 5 * 60_000;
  let statusToken: string | undefined;
  for (let poll = 0; !status.blob && status.state !== "JOB_STATE_FAILED"; poll++) {
    if (Date.now() > deadline) {
      throw new AtpError(
        `Video is still ${status.state} after 5 minutes. Job ${status.jobId} may still finish; check it with get_video_job_status.`,
        408,
        "app.bsky.video.getJobStatus",
        "Timeout",
      );
    }
    // Ask at once, then every pollMs, as Bluesky's own sample does.
    if (poll > 0) await delay(pollMs, undefined, { signal: options.signal });
    statusToken ??= await client.serviceAuth(account, config.videoServiceDid, "app.bsky.video.getJobStatus");
    const polled = await client.call<{ jobStatus: JobStatus }>(account, "app.bsky.video.getJobStatus", {
      service: config.videoService,
      token: statusToken,
      query: { jobId: status.jobId },
    });
    status = polled.jobStatus;
    options.onProgress?.(status);
  }

  if (!status.blob) {
    throw new AtpError(
      `Bluesky could not process the video: ${status.error ?? status.message ?? status.failureCode ?? "unknown failure"}.`,
      400,
      "app.bsky.video.uploadVideo",
      status.failureCode ?? "VideoProcessingFailed",
    );
  }

  return { blob: status.blob, ...(video.aspectRatio ? { aspectRatio: video.aspectRatio } : {}) };
}
