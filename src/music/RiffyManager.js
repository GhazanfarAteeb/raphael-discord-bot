/**
 * Moonlink Music Manager
 * Handles all music functionality using moonlink.js (NodeLink v3 compatible)
 */

import { createRequire } from "module";
import musicConfig from "./config.js";
import logger from "../utils/logger.js";

const require = createRequire(import.meta.url);
const { Manager, Connectors } = require("moonlink.js");

// moonlink's search.defaultPlatform takes its own platform keys; a raw search
// prefix such as "ytmsearch" is not one of them and silently falls back to
// "ytsearch" (plain YouTube). Map the prefixes the config documents to keys.
const SEARCH_PLATFORM_KEYS = {
  ytsearch: "youtube",
  ytmsearch: "youtubemusic",
  scsearch: "soundcloud",
};

// Pending auto-leave countdowns: guildId -> Map(kind -> Timeout)
const autoLeaveTimers = new Map();

/**
 * Deletes the player's now-playing message (the one with live control buttons).
 * The reference is cleared first, so concurrent callers never delete it twice
 * or wipe a newer message stored by trackStart.
 */
export async function clearNowPlaying(player) {
  const message = player?.message;
  if (!message) return;
  player.message = null;
  await message.delete().catch(() => {});
}

/**
 * Cancels pending auto-leave countdowns for a guild (one kind, or all of them).
 */
export function cancelAutoLeave(guildId, kind) {
  const timers = autoLeaveTimers.get(guildId);
  if (!timers) return;
  for (const [timerKind, timer] of timers) {
    if (kind && timerKind !== kind) continue;
    clearTimeout(timer);
    timers.delete(timerKind);
  }
  if (timers.size === 0) autoLeaveTimers.delete(guildId);
}

/**
 * Destroys the guild's player after `delay` ms unless `shouldLeave(player)` says
 * otherwise when the countdown ends. A countdown of the same kind that is already
 * running is kept (unrelated events must not keep resetting it).
 * `onLeave(player)` runs after the player has been destroyed.
 */
export function scheduleAutoLeave(client, guildId, kind, delay, shouldLeave, onLeave) {
  let timers = autoLeaveTimers.get(guildId);
  if (timers?.has(kind)) return false;
  if (!timers) {
    timers = new Map();
    autoLeaveTimers.set(guildId, timers);
  }

  const timer = setTimeout(async () => {
    const pending = autoLeaveTimers.get(guildId);
    if (pending?.get(kind) === timer) {
      pending.delete(kind);
      if (pending.size === 0) autoLeaveTimers.delete(guildId);
    }

    const player = client.moonlink?.players.get(guildId);
    if (!player || player.destroyed) return;

    try {
      if (!(await shouldLeave(player))) return;
      await clearNowPlaying(player);
      await player.destroy(`Auto-leave: ${kind}`);
      if (onLeave) await onLeave(player);
    } catch (error) {
      logger.error(`[MOONLINK] Auto-leave (${kind}) failed for guild ${guildId}`, error);
    }
  }, delay);
  timer.unref?.();
  timers.set(kind, timer);
  return true;
}

/**
 * Skips the current track. When nothing follows, moonlink's skip() only stops the
 * player (TrackEnd "stopped" bypasses its queue-end handling), leaving the bot idle
 * in the channel indefinitely, so the session is ended instead.
 * Resolves to { ok, ended, track } where track is the skipped track.
 */
export async function skipCurrent(player) {
  const track = player.current;

  // Queue loop: moonlink re-queues the current track only when it finishes
  // naturally, so a skipped track would otherwise drop out of the loop.
  if (player.loop === "queue" && track) player.queue.add(track);

  if (player.queue.isEmpty && !player.autoPlay) {
    await clearNowPlaying(player);
    await player.destroy("Skipped the final track");
    return { ok: true, ended: true, track };
  }

  const ok = await player.skip();
  return { ok, ended: false, track };
}

class MoonlinkManager {
  constructor(client) {
    this.client = client;
    this.moonlink = null;
  }

  /**
   * Initialize moonlink.js Manager with the client
   */
  initialize() {
    logger.info("Initializing Moonlink Music Manager...");

    const searchPlatform = musicConfig.defaultSearchPlatform ?? "ytmsearch";
    const autoLeave = musicConfig.autoLeave ?? {};

    // moonlink merges these option groups shallowly: each object passed here
    // replaces its default entirely, so every field is spelled out.
    this.moonlink = new Manager({
      nodes: musicConfig.nodes.map((n) => ({
        host: n.host,
        port: n.port,
        password: n.password,
        secure: n.secure ?? false,
        identifier: `${n.host}:${n.port}`,
        // moonlink's default (5) permanently destroys the node after ~1 minute
        // of downtime, leaving music dead until the bot restarts. Keep retrying
        // (backoff is capped at 5 minutes) so a NodeLink restart self-heals.
        retryAmount: Infinity,
      })),
      options: {
        search: {
          defaultPlatform: SEARCH_PLATFORM_KEYS[searchPlatform] ?? searchPlatform,
          resultLimit: 10,
        },
        defaultPlayer: {
          volume: musicConfig.defaultVolume ?? 100,
          autoPlay: false,
          // Queue-end leaving is handled (with a grace period) by the musicQueueEnd event
          autoLeave: false,
          selfDeaf: true,
          selfMute: false,
          loop: "off",
          historySize: 10,
        },
        // Destroy players that sit idle, paused or stopped for the auto-leave timeout
        playerDestruction: {
          autoDestroyOnIdle: autoLeave.enabled !== false,
          idleTimeout: autoLeave.timeout ?? 300000,
        },
        autoResume: false,
        resume: false,
      },
    });

    // DiscordJs Connector registers client.on("raw", ...) to forward voice
    // state packets to moonlink, and client.once("clientReady", ...) for init.
    // We call manager.init() manually in initializePlayer() so we never need
    // to emit "clientReady" ourselves.
    this.moonlink.use(new Connectors.DiscordJs(), this.client);

    // Attach to client for global access in commands/events
    this.client.moonlink = this.moonlink;

    this.setupEvents();

    logger.info("Moonlink Music Manager initialized successfully");
    return this.moonlink;
  }

  /**
   * Finish initialization with the bot user ID (call after client is ready)
   */
  initializePlayer() {
    if (this.moonlink && this.client.user) {
      this.moonlink.init(this.client.user.id);
      logger.info(
        "Moonlink player initialized with bot ID: " + this.client.user.id,
      );
    }
  }

  /**
   * Setup moonlink.js event listeners and bridge to client events
   */
  setupEvents() {
    this.moonlink.on("nodeConnected", (node) => {
      logger.info(`[MOONLINK] Node "${node.identifier}" connected.`);
      console.log(`[RAPHAEL] Audio node ${node.identifier} connected.`);
    });

    this.moonlink.on("nodeDisconnect", (node) => {
      logger.warn(`[MOONLINK] Node "${node.identifier}" disconnected.`);
      console.log(`[RAPHAEL] Audio node ${node.identifier} disconnected.`);
    });

    this.moonlink.on("nodeReady", (node) => {
      logger.info(`[MOONLINK] Node "${node.identifier}" ready.`);
      console.log(`[RAPHAEL] Audio node ${node.identifier} ready.`);
    });

    this.moonlink.on("nodeError", (node, error) => {
      logger.error(`[MOONLINK] Node "${node.identifier}" error:`, error);
    });

    this.moonlink.on("nodeReconnecting", (node, attempt) => {
      logger.warn(
        `[MOONLINK] Reconnecting to node "${node.identifier}" (attempt ${attempt}).`,
      );
    });

    this.moonlink.on("nodeDestroy", (identifier) => {
      logger.error(`[MOONLINK] Node "${identifier}" destroyed.`);
    });

    // Discord voice WebSocket closed for a player (kicked, region move, etc.)
    this.moonlink.on("socketClosed", (player, code, reason, byRemote) => {
      logger.warn(
        `[MOONLINK] Voice socket closed for guild ${player.guildId}: ${code} ${reason} (byRemote=${byRemote})`,
      );
    });

    this.moonlink.on("trackStuck", (player, track, threshold) => {
      logger.warn(
        `[MOONLINK] Track stuck in guild ${player.guildId}: ${track?.title} (${threshold}ms)`,
      );
    });

    // Every destroy path (stop, auto-leave, idle timeout, failed voice recovery)
    // ends here: drop pending countdowns and the now-playing card's live buttons.
    this.moonlink.on("playerDestroy", (player, reason) => {
      logger.info(
        `[MOONLINK] Player destroyed for guild ${player.guildId}: ${reason ?? "no reason given"}`,
      );
      cancelAutoLeave(player.guildId);
      clearNowPlaying(player).catch(() => {});
    });

    this.moonlink.on("trackStart", (player, track) => {
      this.client.emit("musicTrackStart", player, track);
    });

    this.moonlink.on("trackEnd", (player, track, reason) => {
      this.client.emit("musicTrackEnd", player, track, reason);
    });

    // moonlink emits "trackException" (not "trackError")
    this.moonlink.on("trackException", (player, track, exception, payload) => {
      this.client.emit("musicTrackError", player, track, {
        exception,
        payload,
      });
    });

    this.moonlink.on("queueEnd", (player, lastTrack) => {
      this.client.emit("musicQueueEnd", player, lastTrack);
    });
  }
}

export default MoonlinkManager;
