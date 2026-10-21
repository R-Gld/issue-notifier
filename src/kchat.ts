import { fetchJson, HttpError } from "./http.ts";

/** The root post a reply or edit targets no longer exists. */
export class PostMissingError extends Error {}

export interface Chat {
  createPost(message: string, rootId?: string): Promise<string>;
  /** Throws PostMissingError when the post was deleted. */
  editPost(postId: string, message: string): Promise<void>;
}

/** Minimal kChat (Mattermost API v4) client acting as the bot account. */
export class KChat implements Chat {
  private channelId: string | null = null;

  constructor(private readonly opts: { url: string; token: string; team: string; channel: string }) {}

  private request<T>(method: string, path: string, body?: unknown): Promise<T> {
    return fetchJson<T>(`${this.opts.url}/api/v4${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.opts.token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  async resolveChannel(): Promise<string> {
    if (!this.channelId) {
      const { team, channel } = this.opts;
      const c = await this.request<{ id: string }>(
        "GET",
        `/teams/name/${encodeURIComponent(team)}/channels/name/${encodeURIComponent(channel)}`,
      );
      this.channelId = c.id;
    }
    return this.channelId;
  }

  async createPost(message: string, rootId?: string): Promise<string> {
    const channel_id = await this.resolveChannel();
    try {
      const post = await this.request<{ id: string }>("POST", "/posts", { channel_id, message, root_id: rootId ?? "" });
      return post.id;
    } catch (err) {
      // Mattermost answers 400/404 when root_id points to a deleted post.
      if (rootId && err instanceof HttpError && (err.status === 400 || err.status === 404)) throw new PostMissingError(rootId);
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
}
