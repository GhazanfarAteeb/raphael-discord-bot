import "dotenv/config";
import {
  Client,
  GatewayIntentBits,
  Partials,
  Collection,
  EmbedBuilder,
  ShardingManager,
  ShardEvents,
} from "discord.js";
import mongoose from "mongoose";
// import { fileURLToPath } from 'url';
// import { dirname, join } from 'path';
import path from "path";
import { fileURLToPath } from "url";
import { readdirSync } from "fs";
import { initializeSchedulers } from "./utils/schedulers.js";
import { startPollScheduler } from "./events/client/pollButtonHandler.js";
import { setupGlobalErrorHandlers } from "./utils/errorHandlers.js";
import { refundActiveGames } from "./commands/economy/blackjack.js";
import express from "express";
import Guild from "./models/Guild.js";
import logger from "./utils/logger.js";
import ServerData from "./database/server.js";
import Utils from "./structures/Utils.js";
import RiffyManager from "./music/RiffyManager.js";
import redis from "./utils/redis.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Setup global error handlers (a fatal error shuts down cleanly, refunds included)
setupGlobalErrorHandlers({ onFatal: () => shutdown("Uncaught exception", 1) });

// Express app for health checks
const app = express();
const PORT = process.env.PORT || 3001;

// Create Discord client with necessary intents (optimized)
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildInvites,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
  partials: [
    Partials.Message,
    Partials.Channel,
    Partials.Reaction,
    Partials.User,
    Partials.GuildMember,
  ],
  // WebSocket optimizations
  ws: {
    compress: true, // Enable compression for reduced bandwidth
    large_threshold: 50, // Only request offline members for servers < 50 members
  },
  sweepers: {
    // Sweep messages every 2 minutes to free memory (reduced for fresher data)
    messages: {
      interval: 120,
      lifetime: 300,
    },
    // Sweep users every 10 minutes (reduced from 1 hour)
    users: {
      interval: 600,
      filter: () => (user) => {
        // Keep bot users and users in voice channels
        if (user.bot) return false;
        return !client.guilds.cache.some(
          (guild) => guild.members.cache.get(user.id)?.voice?.channel,
        );
      },
    },
    // Sweep guild members every 10 minutes
    guildMembers: {
      interval: 600,
      filter: () => (member) => {
        // Keep members in voice channels and recent interactions
        if (member.user.bot) return false;
        if (member.voice?.channel) return false;
        return true;
      },
    },
  },
});

// Collections for commands and events
client.commands = new Collection();
client.cooldowns = new Collection();
client.invites = new Collection();
client.aliases = new Collection();

// Initialize database
client.db = new ServerData();

// Initialize utils
client.utils = Utils;

// Initialize Riffy Music Manager
const riffyManager = new RiffyManager(client);
client.riffyManager = riffyManager;

// Configuration
client.config = {
  logChannelId: process.env.LOG_CHANNEL_ID || null,
};

// Logger setup
client.logger = logger;

// Add embed builder and colors
client.embed = () => new EmbedBuilder();
client.color = {
  main: "#0099ff",
  red: "#ff0000",
  green: "#00ff00",
  yellow: "#ffff00",
};

// Connect to MongoDB with optimized settings
async function connectDatabase() {
  try {
    const startTime = Date.now();
    await mongoose.connect(process.env.MONGODB_URI, {
      maxPoolSize: 10,
      minPoolSize: 2,
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
      family: 4, // Use IPv4, skip trying IPv6
    });
    const duration = Date.now() - startTime;
    logger.database("MongoDB connection established", true);
    logger.performance("Database connection", duration);
    console.log("[RAPHAEL] Database connection established.");
  } catch (error) {
    logger.database("MongoDB connection failed", false, error);
    logger.error("MongoDB connection error", error);
    console.error("[RAPHAEL] Database connection failure:", error);
    process.exit(1);
  }
}

// Connect to Redis
async function connectRedis() {
  try {
    const connected = await redis.connect();
    if (connected) {
      client.redis = redis;
      logger.startup("Redis cache initialized");
    } else {
      console.log(
        "[RAPHAEL] Redis unavailable, utilizing in-memory cache fallback.",
      );
    }
  } catch (error) {
    console.log(
      "[RAPHAEL] Redis connection failure, utilizing in-memory cache fallback.",
    );
    logger.error("Redis connection error", error);
  }
}

// Load commands in parallel for faster startup
async function loadCommands() {
  const commandFolders = readdirSync(path.join(__dirname, "commands"));
  let totalCommands = 0;

  // Load all commands in parallel
  const commandPromises = [];

  for (const folder of commandFolders) {
    const commandFiles = readdirSync(
      path.join(__dirname, "commands", folder),
    ).filter((file) => file.endsWith(".js"));

    for (const file of commandFiles) {
      commandPromises.push(
        import(`./commands/${folder}/${file}`)
          .then(({ default: CommandClass }) => {
            // Check if it's a Wave-Music Command class (needs instantiation)
            if (
              typeof CommandClass === "function" &&
              CommandClass.prototype.run
            ) {
              const commandInstance = new CommandClass(client);
              if (commandInstance.name) {
                client.commands.set(commandInstance.name, commandInstance);
                if (
                  commandInstance.aliases &&
                  Array.isArray(commandInstance.aliases)
                ) {
                  commandInstance.aliases.forEach((alias) =>
                    client.aliases.set(alias, commandInstance.name),
                  );
                }
                console.log(
                  `[RAPHAEL] Command loaded: ${commandInstance.name}`,
                );
                return 1;
              }
            }
            // Legacy command object format (plain object with execute method)
            else if (
              CommandClass &&
              CommandClass.name &&
              CommandClass.execute
            ) {
              client.commands.set(CommandClass.name, CommandClass);
              if (CommandClass.aliases && Array.isArray(CommandClass.aliases)) {
                CommandClass.aliases.forEach((alias) =>
                  client.aliases.set(alias, CommandClass.name),
                );
              }
              console.log(`[RAPHAEL] Command loaded: ${CommandClass.name}`);
              return 1;
            }
            return 0;
          })
          .catch((error) => {
            logger.error(`Failed to load command ${file}`, error);
            return 0;
          }),
      );
    }
  }

  // Wait for all commands to load
  const results = await Promise.all(commandPromises);
  totalCommands = results.reduce((sum, count) => sum + count, 0);

  logger.startup(`Loaded ${totalCommands} commands`);
}

// Load events
async function loadEvents() {
  const eventsPath = readdirSync(path.join(__dirname, "./events"));
  let totalEvents = 0;

  // Skip these files - they are initialized separately or called from schedulers
  const skipFiles = [
    "antiNuke.js",
    "messageLogging.js",
    "reminderHandler.js",
    "voiceLogging.js",
    "memberLogging.js",
    "serverLogging.js",
  ];

  for (const dir of eventsPath) {
    // Skip music events - they are loaded separately
    if (dir === "music") continue;

    try {
      const events = readdirSync(
        path.join(__dirname, `./events/${dir}`),
      ).filter((file) => file.endsWith(".js"));

      for (const file of events) {
        // Skip special files that are initialized separately
        if (skipFiles.includes(file)) {
          console.log(`⏭️ Skipping ${file} (initialized separately)`);
          continue;
        }

        try {
          console.log("📂 Loading event:", file);
          const EventModule = await import(`./events/${dir}/${file}`);
          const EventClass = EventModule.default || EventModule;

          // Handle both Event class format and plain object format
          let evt, eventName, eventHandler, once;

          if (typeof EventClass === "function") {
            // Event class format (player events)
            evt = new EventClass(client, file);
            eventName = evt.name;
            eventHandler = (...args) => evt.run(...args);
            once = evt.one;
          } else if (typeof EventClass === "object" && EventClass.execute) {
            // Plain object format (client events)
            eventName = EventClass.name;
            eventHandler = (...args) => EventClass.execute(...args, client);
            once = EventClass.once;
          } else {
            throw new Error(`Invalid event format in ${file}`);
          }

          // Register event with client
          if (once) client.once(eventName, eventHandler);
          else client.on(eventName, eventHandler);

          totalEvents++;
        } catch (error) {
          console.error(`Error loading event ${file}:`, error);
          logger.error(`Failed to load event ${file}`, error);
        }
      }
    } catch (error) {
      console.error(`Error reading directory ${dir}:`, error);
      logger.error(`Failed to read events directory ${dir}`, error);
    }
  }

  logger.startup(`Loaded ${totalEvents} events`);
}

// Load music events specifically
async function loadMusicEvents() {
  const musicEventsPath = path.join(__dirname, "./events/music");
  let totalMusicEvents = 0;

  try {
    const events = readdirSync(musicEventsPath).filter((file) =>
      file.endsWith(".js"),
    );

    for (const file of events) {
      try {
        console.log("[RAPHAEL] Loading audio event:", file);
        const EventModule = await import(`./events/music/${file}`);
        const EventClass = EventModule.default || EventModule;

        if (typeof EventClass === "function") {
          const evt = new EventClass(client, file);
          const eventName = evt.name;
          const eventHandler = (...args) => evt.run(...args);

          // Register event with client
          client.on(eventName, eventHandler);
          totalMusicEvents++;
        }
      } catch (error) {
        console.error(`Error loading music event ${file}:`, error);
        logger.error(`Failed to load music event ${file}`, error);
      }
    }
  } catch (error) {
    console.error("Error reading music events directory:", error);
    logger.error("Failed to read music events directory", error);
  }

  logger.startup(`Loaded ${totalMusicEvents} music events`);
  console.log(`[RAPHAEL] Audio system events loaded: ${totalMusicEvents}`);
}

// Initialize bot
async function initialize() {
  const startTime = Date.now();
  logger.startup("Starting RAPHAEL...");
  logger.build("Bot version: 2.1.0");
  logger.build("Node version: " + process.version);
  logger.build("Environment: " + (process.env.NODE_ENV || "production"));
  console.log("[RAPHAEL] Initiating system startup...");

  await connectDatabase();
  await connectRedis();
  await loadCommands();

  // Initialize Moonlink before login so the DiscordJs connector's
  // once("clientReady") listener is registered before the bot connects.
  // The connector calls manager.init() automatically when clientReady fires.
  try {
    riffyManager.initialize();
    console.log("[RAPHAEL] Audio subsystem initialized.");
  } catch (error) {
    logger.error("Failed to initialize music system:", error);
    console.error(
      "[RAPHAEL] Audio subsystem initialization failure:",
      error.message,
    );
  }

  // Event handlers are registered before login, so nothing Discord sends once the
  // bot connects is missed: commands and button clicks that arrive during startup
  // are handled, and ready.js runs on clientReady like any other event file.
  await loadEvents();
  await loadMusicEvents();

  // Startup steps that need the logged-in client and its guild cache. Registered
  // before login too, so clientReady can't fire before anyone is listening.
  client.once("clientReady", async () => {
    console.log("[RAPHAEL] Client connection established.");
    console.log(`   Logged in as: ${client.user.tag}`);
    console.log(`   Guilds: ${client.guilds.cache.size}`);
    console.log(`   WS Status: ${client.ws.status}, Ping: ${client.ws.ping}ms`);

    // Initialize security systems
    await initializeSecuritySystems(client);

    // Register slash commands
    await registerSlashCommandsOnReady(client);

    // Initialize schedulers
    initializeSchedulers(client);
    // Ends overdue polls even when nobody interacts with them
    startPollScheduler(client);

    // Start status monitoring
    startStatusMonitoring();

    // Send initial online message
    notifyStatusChange("online");

    console.log(
      "[RAPHAEL] All systems operational. Awaiting commands, Master.",
    );
  });

  await client.login(process.env.DISCORD_TOKEN);

  const duration = Date.now() - startTime;
  logger.performance("Bot initialization", duration);
  logger.startup(`Bot started successfully in ${duration}ms`);
}

// Initialize security systems (anti-nuke, anti-raid, message logging)
async function initializeSecuritySystems(client) {
  try {
    // Initialize anti-nuke
    const antiNuke = await import("./events/client/antiNuke.js");
    if (antiNuke.default?.initialize) {
      await antiNuke.default.initialize(client);
    }

    // Initialize message logging
    const messageLogging = await import("./events/client/messageLogging.js");
    if (messageLogging.default?.initialize) {
      await messageLogging.default.initialize(client);
    }

    // Initialize voice logging
    const voiceLogging = await import("./events/client/voiceLogging.js");
    if (voiceLogging.default?.initialize) {
      await voiceLogging.default.initialize(client);
    }

    // Initialize member logging
    const memberLogging = await import("./events/client/memberLogging.js");
    if (memberLogging.default?.initialize) {
      await memberLogging.default.initialize(client);
    }

    // Initialize server logging
    const serverLogging = await import("./events/client/serverLogging.js");
    if (serverLogging.default?.initialize) {
      await serverLogging.default.initialize(client);
    }

    console.log("[RAPHAEL] Security and logging subsystems initialized.");
  } catch (error) {
    console.error("[RAPHAEL] Security systems initialization failure:", error);
    logger.error("Failed to initialize security systems", error);
  }
}

// Register slash commands
async function registerSlashCommandsOnReady(client) {
  try {
    const { registerSlashCommands, clearGuildSlashCommands } =
      await import("./utils/slashCommands.js");

    // Clear guild-specific commands to remove duplicates (one-time cleanup)
    console.log("[RAPHAEL] Clearing guild-specific commands...");
    for (const guild of client.guilds.cache.values()) {
      await clearGuildSlashCommands(client, guild.id);
    }

    // Register globally only
    const commandCount = await registerSlashCommands(client);
    console.log(
      `[RAPHAEL] Slash commands registered globally: ${commandCount}`,
    );
  } catch (error) {
    console.error("[RAPHAEL] Slash command registration failure:", error);
    logger.error("Failed to register slash commands", error);
  }
}

// Error handling
process.on("unhandledRejection", (error) => {
  logger.error("Unhandled promise rejection", error);
  console.error("Unhandled promise rejection:", error);
});

process.on("uncaughtException", (error) => {
  logger.error("Uncaught exception", error);
  console.error("Uncaught exception:", error);
  process.exit(1);
});

// Graceful shutdown: docker stop/restart sends SIGTERM, Ctrl+C sends SIGINT, and a
// fatal error comes through setupGlobalErrorHandlers. Runs once, whatever triggers it.
async function shutdown(reason, exitCode = 0) {
  if (shutdown.started) return;
  shutdown.started = true;
  console.log(`\n[RAPHAEL] ${reason}: initiating graceful shutdown...`);
  logger.info(`Bot shutting down (${reason})`);

  // Docker kills the container 10 seconds after SIGTERM: finish (or give up) before that
  setTimeout(() => {
    console.error("[RAPHAEL] Shutdown timed out, exiting.");
    process.exit(exitCode || 1);
  }, 8000).unref();

  try {
    // Blackjack wagers are taken up front and games can't resume after a restart
    const refunded = await refundActiveGames();
    if (refunded) console.log(`[RAPHAEL] Refunded ${refunded} unfinished blackjack game(s).`);
  } catch (error) {
    logger.error("Failed to refund unfinished games during shutdown", error);
  }

  try {
    await client.destroy();
    await mongoose.connection.close();
  } catch (error) {
    logger.error("Error while disconnecting during shutdown", error);
  }

  console.log("[RAPHAEL] Shutdown sequence complete.");
  process.exit(exitCode);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// Health check endpoint
app.get("/health", (req, res) => {
  const uptime = process.uptime();
  const status = {
    status: "online",
    uptime: Math.floor(uptime),
    uptimeFormatted: formatUptime(uptime),
    timestamp: new Date().toISOString(),
    bot: {
      ready: client.readyAt ? true : false,
      guilds: client.guilds.cache.size,
      users: client.guilds.cache.reduce(
        (acc, guild) => acc + guild.memberCount,
        0,
      ),
      ping: client.ws.ping,
    },
    database: {
      connected: mongoose.connection.readyState === 1,
    },
  };

  res.json(status);
});

// Root endpoint
app.get("/", (req, res) => {
  res.json({
    name: "RAPHAEL",
    version: "2.1.0",
    status: "running",
    message: "Bot is online and operational",
    endpoints: {
      health: "/health",
      commands: "/commands",
    },
  });
});

// Commands page endpoint
app.get("/commands", (req, res) => {
  res.sendFile(path.join(__dirname, "../docs/commands.html"));
});

function formatUptime(seconds) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (secs > 0) parts.push(`${secs}s`);

  return parts.join(" ") || "0s";
}

// Start Express server
app.listen(PORT, () => {
  console.log(`🌐 Health check server running on port ${PORT}`);
});

// Monitor bot status and send updates
let lastStatus = "online";
let statusCheckInterval;

function startStatusMonitoring() {
  statusCheckInterval = setInterval(async () => {
    const currentStatus = client.ws.status === 0 ? "online" : "offline";

    if (currentStatus !== lastStatus) {
      lastStatus = currentStatus;
      await notifyStatusChange(currentStatus);
    }
  }, 60000); // Check every minute
}

async function notifyStatusChange(status) {
  logger.event(`Bot status changed to ${status}`);

  try {
    const guilds = await Guild.find({
      "channels.botStatus": { $exists: true, $ne: null },
    });

    for (const guildConfig of guilds) {
      try {
        const guild = client.guilds.cache.get(guildConfig.guildId);
        if (!guild) continue;

        const channel = guild.channels.cache.get(
          guildConfig.channels.botStatus,
        );
        if (!channel) continue;

        const embed = new EmbedBuilder()
          .setTitle(`『 System Status Update 』`)
          .setDescription(
            status === "online"
              ? "**Confirmed:** All systems online and operational, Master."
              : "**Warning:** System offline. Initiating reconnection protocol...",
          )
          .setColor(status === "online" ? "#00FF7F" : "#ff4757")
          .addFields(
            { name: "▸ Status", value: status.toUpperCase(), inline: true },
            {
              name: "▸ Timestamp",
              value: `<t:${Math.floor(Date.now() / 1000)}:F>`,
              inline: true,
            },
          )
          .setTimestamp();

        await channel.send({ embeds: [embed] });
      } catch (error) {
        console.error(
          `Error sending status update to guild ${guildConfig.guildId}:`,
          error,
        );
      }
    }
  } catch (error) {
    console.error("Error notifying status change:", error);
  }
}

// Start the bot
initialize().catch(console.error);

export default client;
