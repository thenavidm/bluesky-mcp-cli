/**
 * Publishing.
 *
 * `create_post` is the tool that carries the most difference from the reference
 * servers. Theirs is text plus an optional reply URI. This one also carries
 * images with alt text and measured aspect ratios, a transcoded video, a link
 * card, a quote, reply controls, and the part that actually decides whether a
 * post looks broken: facets, so links and mentions render.
 *
 * `create_thread` exists because a 300-character limit means threads are the
 * normal way to say anything, and building one by hand is four tool calls where
 * every call after the first has to thread the previous URI back through.
 */

import { z } from "zod";
import { buildFacets } from "../content/facets.js";
import { uploadImage, uploadVideo } from "../content/media.js";
import { assertPostLength, graphemeLength } from "../content/text.js";
import { parseAtUri, resolvePostUri, strongRef, webUrl, type StrongRef } from "../api/identity.js";
import { renderThread } from "../format/posts.js";
import type { Account } from "../config.js";
import { ValidationError } from "../api/errors.js";
import { accountArg, clamp, confirmArg, defineTool, type ToolContext, type AnyToolSpec } from "./kit.js";
import type { ToolContext as RunContext } from "@thenavidm/slipway";

const imageSchema = z.object({
  url: z.string().describe("Public http(s) URL, or a data: URI. Must be under 1MB."),
  alt: z
    .string()
    .default("")
    .describe("Alt text. Write real alt text, because an empty string makes the post unreadable to screen readers."),
});

const linkSchema = z.object({
  uri: z.string().describe("The URL the card links to."),
  title: z.string().describe("Card headline."),
  description: z.string().default("").describe("Card subtitle."),
  thumb_url: z.string().optional().describe("Public URL of the card image, under 1MB."),
});

/** Who may reply, expressed the way a person would say it. */
const replyControlSchema = z
  .enum(["everyone", "nobody", "mentioned", "following", "followers"])
  .describe(
    "Who can reply. 'following' means accounts you follow; 'followers' means accounts that follow you; 'mentioned' means only accounts named in the post.",
  );

type PostArgs = {
  text: string;
  images?: { url: string; alt: string }[];
  video_url?: string;
  video_path?: string;
  video_alt?: string;
  link?: { uri: string; title: string; description: string; thumb_url?: string };
  quote?: string;
  reply_to?: string;
  langs?: string[];
  tags?: string[];
  reply_control?: "everyone" | "nobody" | "mentioned" | "following" | "followers";
  allow_quotes?: boolean;
};

/** Build the `app.bsky.feed.post` record, uploading whatever media it references. */
async function buildRecord(
  ctx: ToolContext,
  chosen: Account,
  args: PostArgs,
): Promise<Record<string, unknown>> {
  assertPostLength(args.text);

  const record: Record<string, unknown> = {
    $type: "app.bsky.feed.post",
    text: args.text,
    createdAt: new Date().toISOString(),
  };

  const langs = (args.langs ?? ["en"]).slice(0, 3);
  if (langs.length) record.langs = langs;
  if (args.tags?.length) record.tags = args.tags.slice(0, 8);

  const facets = await buildFacets(ctx.client, args.text);
  if (facets.length) record.facets = facets;

  if (args.video_url && args.video_path) {
    throw new ValidationError(
      "Pass video_url or video_path, not both.",
      400,
      "(local)",
      "InvalidRequest",
    );
  }
  const video = args.video_url || args.video_path;
  const embedCount = [args.images?.length, video, args.link, args.quote].filter(
    Boolean,
  ).length;
  if (args.images?.length && video) {
    throw new ValidationError(
      "A post carries either images or a video, not both.",
      400,
      "(local)",
      "InvalidRequest",
    );
  }
  if (embedCount > 2 || (embedCount === 2 && !args.quote)) {
    throw new ValidationError(
      "A post carries one embed, or a quote plus one piece of media. Pick one of images, video or link.",
      400,
      "(local)",
      "InvalidRequest",
    );
  }

  let media: Record<string, unknown> | undefined;
  if (args.images?.length) {
    const uploaded = await Promise.all(
      args.images.slice(0, 4).map(async (image) => {
        const { blob, aspectRatio } = await uploadImage(
          ctx.client,
          chosen,
          image.url,
          ctx.config.requestTimeoutMs,
        );
        return { alt: image.alt ?? "", image: blob, ...(aspectRatio ? { aspectRatio } : {}) };
      }),
    );
    media = { $type: "app.bsky.embed.images", images: uploaded };
  } else if (video) {
    const uploaded = await uploadVideo(
      ctx.client,
      chosen,
      ctx.config,
      args.video_path ? { path: args.video_path } : { url: args.video_url },
      { signal: (ctx as Partial<RunContext<ToolContext>>).signal },
    );
    media = {
      $type: "app.bsky.embed.video",
      video: uploaded.blob,
      ...(args.video_alt ? { alt: args.video_alt } : {}),
      // Without it Bluesky guesses, and a 9:16 video is shown in a box of the wrong shape.
      ...(uploaded.aspectRatio ? { aspectRatio: uploaded.aspectRatio } : {}),
    };
  } else if (args.link) {
    const thumb = args.link.thumb_url
      ? (await uploadImage(ctx.client, chosen, args.link.thumb_url, ctx.config.requestTimeoutMs)).blob
      : undefined;
    media = {
      $type: "app.bsky.embed.external",
      external: {
        uri: args.link.uri,
        title: args.link.title,
        description: args.link.description ?? "",
        ...(thumb ? { thumb } : {}),
      },
    };
  }

  if (args.quote) {
    const quoted = await strongRef(ctx.client, chosen, args.quote);
    record.embed = media
      ? {
          $type: "app.bsky.embed.recordWithMedia",
          record: { $type: "app.bsky.embed.record", record: quoted },
          media,
        }
      : { $type: "app.bsky.embed.record", record: quoted };
  } else if (media) {
    record.embed = media;
  }

  if (args.reply_to) {
    record.reply = await replyRefs(ctx, chosen, args.reply_to);
  }

  return record;
}

/**
 * The `{root, parent}` pair a reply needs.
 *
 * A reply must name the thread **root**, not just its parent. Setting root to
 * the parent produces a post that detaches from the conversation: it shows as a
 * reply to one post while the thread it belongs to never lists it.
 */
async function replyRefs(
  ctx: ToolContext,
  chosen: Account,
  ref: string,
): Promise<{ root: StrongRef; parent: StrongRef }> {
  const parent = await strongRef(ctx.client, chosen, ref);
  const { repo, collection, rkey } = parseAtUri(parent.uri);
  const record = await ctx.client.call<{ value?: { reply?: { root?: StrongRef } } }>(
    chosen,
    "com.atproto.repo.getRecord",
    { query: { repo, collection, rkey } },
  );
  const root = record.value?.reply?.root;
  return { root: root?.uri && root?.cid ? root : parent, parent };
}

/** The two arguments that produce gate records, on both create_post and create_thread. */
type GateArgs = Pick<PostArgs, "reply_control" | "allow_quotes">;

/**
 * Write the threadgate and postgate records that carry reply and quote controls.
 *
 * A threadgate only has an effect on a thread's **root**. Bluesky accepts one
 * written against a reply and then ignores it forever, so a post made with
 * `reply_to` reports that the control was not applied rather than pretending
 * it was. `postUri` is always a post we just created, so the repo is ours.
 */
async function applyGates(
  ctx: ToolContext,
  chosen: Account,
  postUri: string,
  args: GateArgs,
  isReply: boolean,
): Promise<Record<string, unknown>> {
  const applied: Record<string, unknown> = {};
  const { repo, rkey } = parseAtUri(postUri);

  if (isReply && args.reply_control && args.reply_control !== "everyone") {
    applied.reply_control_ignored =
      "Reply controls only apply to the post that starts a thread. This is a reply, so the thread's original author controls who can reply.";
  } else if (args.reply_control && args.reply_control !== "everyone") {
    const allow =
      args.reply_control === "nobody"
        ? []
        : args.reply_control === "mentioned"
          ? [{ $type: "app.bsky.feed.threadgate#mentionRule" }]
          : args.reply_control === "following"
            ? [{ $type: "app.bsky.feed.threadgate#followingRule" }]
            : [{ $type: "app.bsky.feed.threadgate#followerRule" }];

    // The threadgate's rkey must equal the post's rkey and live in the same
    // repo. Any other key is accepted by the write and then ignored forever.
    await ctx.client.call(chosen, "com.atproto.repo.putRecord", {
      method: "POST",
      body: {
        repo,
        collection: "app.bsky.feed.threadgate",
        rkey,
        record: {
          $type: "app.bsky.feed.threadgate",
          post: postUri,
          allow,
          createdAt: new Date().toISOString(),
        },
      },
    });
    applied.reply_control = args.reply_control;
  }

  if (args.allow_quotes === false) {
    await ctx.client.call(chosen, "com.atproto.repo.putRecord", {
      method: "POST",
      body: {
        repo,
        collection: "app.bsky.feed.postgate",
        rkey,
        record: {
          $type: "app.bsky.feed.postgate",
          post: postUri,
          embeddingRules: [{ $type: "app.bsky.feed.postgate#disableRule" }],
          createdAt: new Date().toISOString(),
        },
      },
    });
    applied.quotes_disabled = true;
  }

  return applied;
}

const createPost = defineTool({
  name: "create_post",
  title: "Post to Bluesky",
  description:
    "Publish a post. Handles plain text, up to four images with alt text, a video from a URL or a file on this machine, a link card, a quote, and replies. URLs, #hashtags and @mentions in the text are turned into real links automatically. You do not need to format them. The limit is 300 characters; for anything longer use create_thread. Public the moment it runs, so it needs confirm: true.",
  schema: {
    text: z
      .string()
      .describe("The post body. Up to 300 characters, counted the way Bluesky counts them."),
    ...accountArg,
    images: z.array(imageSchema).max(4).optional().describe("Up to four images."),
    video_url: z
      .string()
      .optional()
      .describe("Public URL of a video, or a data: URI. Sent through Bluesky's video service, which takes a few seconds. Pass this or video_path."),
    video_path: z
      .string()
      .optional()
      .describe("A video file on the machine running this server: MP4, MOV, WebM or MPEG, up to 300MB. Its aspect ratio is read from the file, so a 9:16 video shows upright. Pass this or video_url."),
    video_alt: z.string().optional().describe("Alt text for the video."),
    link: linkSchema.optional().describe("A link preview card."),
    quote: z
      .string()
      .optional()
      .describe("The post to quote, as an at:// URI or a bsky.app link."),
    reply_to: z
      .string()
      .optional()
      .describe("The post being replied to, as an at:// URI or a bsky.app link."),
    langs: z
      .array(z.string())
      .max(3)
      .optional()
      .describe("BCP-47 language codes for the post text. Defaults to ['en']."),
    tags: z
      .array(z.string())
      .max(8)
      .optional()
      .describe("Extra hashtags that should apply without appearing in the text."),
    reply_control: replyControlSchema.optional(),
    allow_quotes: z
      .boolean()
      .optional()
      .describe("Set false to stop anyone quoting this post."),
    ...confirmArg,
  },
  risk: "destructive",
  public: true,
  consequence:
    "publishes a post on your Bluesky account that anyone can see the moment it runs, and deleting it later does not pull it out of feeds that already have it",
  summary: (a) =>
    `post ${graphemeLength(a.text)} chars${a.video_path ? ` with ${a.video_path.split(/[\\/]/).pop()}` : ""}: ${a.text.slice(0, 80)}`,
  handler: async (args, ctx) => {
    const chosen = ctx.account(args.account);
    const session = await ctx.client.session(chosen);
    const record = await buildRecord(ctx, chosen, args as PostArgs);

    const result = await ctx.client.call<{ uri: string; cid: string }>(
      chosen,
      "com.atproto.repo.createRecord",
      {
        method: "POST",
        body: { repo: session.did, collection: "app.bsky.feed.post", record },
      },
    );

    const gates = await applyGates(ctx, chosen, result.uri, args, Boolean(args.reply_to));

    return {
      uri: result.uri,
      cid: result.cid,
      url: webUrl(result.uri, session.handle),
      posted_as: session.handle,
      characters: graphemeLength(args.text),
      facets: (record.facets as unknown[] | undefined)?.length ?? 0,
      ...gates,
    };
  },
});

const createThread = defineTool({
  name: "create_thread",
  title: "Post a thread",
  description:
    "Publish several posts as one thread, each replying to the last. Every part is checked against the 300-character limit before anything is posted, so a thread never half-publishes because part four was too long. Media, quotes and reply controls apply to the first post. Public the moment it runs, so it needs confirm: true.",
  schema: {
    posts: z
      .array(z.string())
      .min(1)
      .max(25)
      .describe("The parts, in order. Each up to 300 characters."),
    ...accountArg,
    images: z.array(imageSchema).max(4).optional().describe("Images on the first post."),
    link: linkSchema.optional().describe("A link card on the first post."),
    quote: z.string().optional().describe("A post quoted by the first post."),
    reply_to: z
      .string()
      .optional()
      .describe("Start the thread as a reply to this post."),
    langs: z.array(z.string()).max(3).optional(),
    reply_control: replyControlSchema.optional(),
    ...confirmArg,
  },
  risk: "destructive",
  public: true,
  summary: (a) => `post a ${a.posts.length}-part thread starting: ${a.posts[0]?.slice(0, 60)}`,
  handler: async (args, ctx) => {
    const chosen = ctx.account(args.account);
    const session = await ctx.client.session(chosen);

    // Validate every part first. A thread that publishes three posts and then
    // fails on the fourth leaves a public, truncated argument behind.
    args.posts.forEach((text, index) => {
      try {
        assertPostLength(text);
      } catch (error) {
        throw new ValidationError(
          `Part ${index + 1} of ${args.posts.length}: ${(error as Error).message}`,
          400,
          "(local)",
          "InvalidRequest",
        );
      }
    });

    const posted: { uri: string; cid: string; url: string }[] = [];
    let parent: StrongRef | undefined;
    let root: StrongRef | undefined;

    for (const [index, text] of args.posts.entries()) {
      const first = index === 0;
      const record = await buildRecord(ctx, chosen, {
        text,
        langs: args.langs,
        images: first ? args.images : undefined,
        link: first ? args.link : undefined,
        quote: first ? args.quote : undefined,
        reply_to: first ? args.reply_to : undefined,
      });

      if (!first && parent && root) {
        record.reply = { root, parent };
      } else if (first && record.reply) {
        root = (record.reply as { root: StrongRef }).root;
      }

      const result = await ctx.client.call<{ uri: string; cid: string }>(
        chosen,
        "com.atproto.repo.createRecord",
        { method: "POST", body: { repo: session.did, collection: "app.bsky.feed.post", record } },
      );

      parent = { uri: result.uri, cid: result.cid };
      root = root ?? parent;
      posted.push({ uri: result.uri, cid: result.cid, url: webUrl(result.uri, session.handle) });
    }

    // Gate the first post *we* made. When the thread is a reply, `root` is
    // someone else's post and writing a threadgate keyed to it would target
    // their repository.
    const ours = posted[0];
    const gates = ours
      ? await applyGates(ctx, chosen, ours.uri, args, Boolean(args.reply_to))
      : {};

    return {
      parts: posted.length,
      thread_root: root?.uri,
      url: posted[0]?.url,
      posted_as: session.handle,
      posts: posted,
      ...gates,
    };
  },
});

const deletePost = defineTool({
  name: "delete_post",
  title: "Delete a post",
  description:
    "Delete one of your own posts. This cannot be undone, and it does not remove the post from feeds and caches that already have it. Needs confirm: true.",
  schema: {
    uri: z.string().describe("at:// URI or bsky.app link of the post to delete."),
    ...accountArg,
    ...confirmArg,
  },
  risk: "destructive",
  summary: (a) => `delete ${a.uri}`,
  handler: async ({ uri, account }, ctx) => {
    const chosen = ctx.account(account);
    const session = await ctx.client.session(chosen);
    const resolved = await resolvePostUri(ctx.client, uri, session.did);
    const parts = parseAtUri(resolved);

    if (parts.repo !== session.did) {
      throw new ValidationError(
        `That post belongs to ${parts.repo}, not to ${session.handle}. You can only delete your own posts.`,
        400,
        "(local)",
        "InvalidRequest",
      );
    }

    await ctx.client.call(chosen, "com.atproto.repo.deleteRecord", {
      method: "POST",
      body: { repo: parts.repo, collection: parts.collection, rkey: parts.rkey },
    });
    return { deleted: resolved };
  },
});

const getPostThread = defineTool({
  name: "get_post_thread",
  title: "Read a thread",
  description:
    "Read a post together with the conversation around it: everything above it and the replies below. Accepts an at:// URI or a bsky.app link. Use this before replying, so the reply lands with context.",
  schema: {
    uri: z.string().describe("at:// URI or bsky.app link of any post in the thread."),
    depth: z
      .number()
      .int()
      .min(0)
      .max(100)
      .optional()
      .describe("How many levels of replies to include. Default 6."),
    parent_height: z
      .number()
      .int()
      .min(0)
      .max(100)
      .optional()
      .describe("How far up the ancestor chain to walk. Default 20."),
    ...accountArg,
  },
  risk: "read",
  handler: async ({ uri, depth, parent_height, account }, ctx) => {
    const resolved = await resolvePostUri(ctx.client, uri);
    const query = {
      uri: resolved,
      depth: clamp(depth, 6),
      parentHeight: clamp(parent_height, 20),
    };

    // Authenticated where possible: the public appview hides posts from
    // accounts with restricted visibility, so a thread can come back with holes.
    const data = ctx.client.accounts.length
      ? await ctx.client.call<{ thread: Record<string, unknown> }>(
          ctx.account(account),
          "app.bsky.feed.getPostThread",
          { query },
        )
      : await ctx.client.publicCall<{ thread: Record<string, unknown> }>(
          "app.bsky.feed.getPostThread",
          query,
        );

    return renderThread(data.thread, resolved);
  },
});

export const postTools: AnyToolSpec[] = [
  createPost as AnyToolSpec,
  createThread as AnyToolSpec,
  deletePost as AnyToolSpec,
  getPostThread as AnyToolSpec,
];
