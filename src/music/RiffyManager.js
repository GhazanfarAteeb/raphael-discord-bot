/**
 * Moonlink Music Manager
 * Handles all music functionality using moonlink.js (NodeLink v3 compatible)
 */

import { createRequire } from "module";
import musicConfig from "./config.js";
import logger from "../utils/logger.js";

const require = createRequire(import.meta.url);
const { Manager, Connectors } = require("moonlink.js");

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
          defaultPlatform: musicConfig.defaultSearchPlatform ?? "ytmsearch",
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

    this.moonlink.on("trackStart", (player, track) => {
      this.client.emit("musicTrackStart", player, track);
    });

    this.moonlink.on("trackEnd", (player, track) => {
      this.client.emit("musicTrackEnd", player, track);
    });

    // moonlink emits "trackException" (not "trackError")
    this.moonlink.on("trackException", (player, track, exception, payload) => {
      this.client.emit("musicTrackError", player, track, {
        exception,
        payload,
      });
    });

    this.moonlink.on("queueEnd", (player) => {
      this.client.emit("musicQueueEnd", player);
    });
  }
}

export default MoonlinkManager;
