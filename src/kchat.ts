import { fetchJson, HttpError } from "./http.ts";

/** The root post a reply or edit targets no longer exists. */
export class PostMissingError extends Error {}

export interface Chat {
  /** Channel id from team and channel names. */
  resolveChannel(team: string, channel: string): Promise<string>;
  createPost(channelId: string, message: string, rootId?: string): Promise<string>;
  /** Throws PostMissingError when the post was deleted. */
  editPost(postId: string, message: string): Promise<void>;
  /** Channel holding a post, or null if the post is gone. */
  postChannel(postId: string): Promise<string | null>;
  /** Whether a custom emoji of that name exists. */
  emojiExists(name: string): Promise<boolean>;
  /** Creates a custom emoji from a PNG image. */
  createEmoji(name: string, png: Uint8Array<ArrayBuffer>): Promise<void>;
}

/** Minimal kChat (Mattermost API v4) client acting as the bot account. */
export class KChat implements Chat {
  private readonly channels = new Map<string, string>();

  constructor(private readonly opts: { url: string; token: string }) {}

  private request<T>(method: string, path: string, body?: unknown): Promise<T> {
    return fetchJson<T>(`${this.opts.url}/api/v4${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.opts.token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  async resolveChannel(team: string, channel: string): Promise<string> {
    const key = `${team}/${channel}`.toLowerCase();
    let id = this.channels.get(key);
    if (!id) {
      const c = await this.request<{ id: string }>(
        "GET",
        `/teams/name/${encodeURIComponent(team)}/channels/name/${encodeURIComponent(channel)}`,
      );
      id = c.id;
      this.channels.set(key, id);
    }
    return id;
  }

  async createPost(channel_id: string, message: string, rootId?: string): Promise<string> {
    try {
      const post = await this.request<{ id: string }>("POST", "/posts", { channel_id, message, root_id: rootId ?? "" });
      return post.id;
    } catch (err) {
      // Mattermost answers 400/404 when root_id points to a deleted post.
      if (rootId && err instanceof HttpError && (err.status === 400 || err.status === 404)) throw new PostMissingError(rootId);
      throw err;
    }
  }

  async postChannel(postId: string): Promise<string | null> {
    try {
      return (await this.request<{ channel_id: string }>("GET", `/posts/${postId}`)).channel_id;
    } catch (err) {
      if (err instanceof HttpError && (err.status === 404 || err.status === 403)) return null;
      throw err;
    }
  }

  async editPost(postId: string, message: string): Promise<void> {
    try {
      await this.request("PUT", `/posts/${postId}/patch`, { message });
    } catch (err) {
      if (err instanceof HttpError && (err.status === 404 || err.status === 403)) throw new PostMissingError(postId);
      throw err;
    }
  }

  async emojiExists(name: string): Promise<boolean> {
    try {
      await this.request("GET", `/emoji/name/${encodeURIComponent(name)}`);
      return true;
    } catch (err) {
      // 501: custom emojis are disabled on the server.
      if (err instanceof HttpError && (err.status === 404 || err.status === 501)) return false;
      throw err;
    }
  }

  /** Created in the bot's name, which needs the permission to create emojis. */
  async createEmoji(name: string, png: Uint8Array<ArrayBuffer>): Promise<void> {
    const me = await this.request<{ id: string }>("GET", "/users/me");
    const form = new FormData();
    form.append("emoji", JSON.stringify({ name, creator_id: me.id }));
    form.append("image", new Blob([png], { type: "image/png" }), `${name}.png`);
    // No Content-Type: fetch sets the multipart boundary.
    await fetchJson(`${this.opts.url}/api/v4/emoji`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.opts.token}` },
      body: form,
    });
  }
}
