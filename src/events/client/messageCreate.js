
import Event from "../../structures/Event.js";
import { ChannelType, Collection, PermissionFlagsBits } from "discord.js";
import Context from "../../structures/Context.js";
import { Raphael, getRandomFooter } from "../../utils/raphael.js";
import { hasModPerms } from "../../utils/helpers.js";

class MessageCreate extends Event {
  constructor(client, file) {
    super(client, file, {
      name: "messageCreate",
    });
  }
  async run(message) {
    // Early returns for performance
    if (message.author.bot || !message.guild) return;

    const mention = new RegExp(`^<@!?${this.client.user.id}>( |)$`);

    // Get prefix (cached) - removed hardcoded check to support custom prefixes
    const currentPrefix = await this.client.db.getPrefix(message.guildId);

    // Check setup (don't await unless needed)
    const setupPromise = this.client.db.getSetup(message.guildId);

    // Helper to safely reply (handles deleted messages)
    const safeReply = async (options) => {
      try {
        return await message.reply(options);
      } catch (error) {
        // Message was deleted (e.g., by automod) - try channel.send instead
        if (error.code === 50035 || error.code === 10008) {
          return await message.channel.send(options).catch(() => null);
        }
        throw error;
      }
    };

    if (message.content.match(mention)) {
      await safeReply({
        content: `**Answer:** Greetings, Master. My activation prefix for this server is \`${currentPrefix}\`\n\nFor a comprehensive list of my capabilities, use \`${currentPrefix}help\`\n\n*I await your commands.*`,
      });
      return;
    }

    const escapeRegex = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const prefixRegex = new RegExp(
      `^(<@!?${this.client.user.id}>|${escapeRegex(currentPrefix)})\\s*`,
      'i' // Case insensitive flag
    );
    if (!prefixRegex.test(message.content)) return;

    // Check setup now
    const setup = await setupPromise;
    if (setup && setup.textId && setup.textId === message.channelId) {
      return this.client.emit("setupSystem", message);
    }

    const [matchedPrefix] = message.content.match(prefixRegex);
    const args = message.content
      .slice(matchedPrefix.length)
      .trim()
      .split(/ +/g);
    const cmd = args.shift().toLowerCase();
    const command =
      this.client.commands.get(cmd) ||
      this.client.commands.get(this.client.aliases.get(cmd));
    if (!command) return;

    // Owner-only commands are bot-wide tools (server invites, bot logs); ignore everyone else
    if (command.ownerOnly && message.author.id !== process.env.BOT_OWNER_ID) return;

    // Check channel restrictions (skip for config commands to prevent lockout)
    const guildConfig = await this.client.db.getGuild(message.guildId);

    // Check if text command is disabled (skip for 'command' command to prevent lockout)
    if (command.name !== 'command' && guildConfig?.textCommands?.disabledCommands?.includes(command.name)) {
      const msg = await message.reply({
        content: `**Notice:** The \`${command.name}\` skill has been deactivated by server administration, Master.`
      }).catch(() => null);
      if (msg) setTimeout(() => msg.delete().catch(() => { }), 5000);
      return;
    }

    // Only channels that still exist count: if every allowed channel was deleted, the
    // restriction is skipped instead of blocking all non-config commands server-wide
    const allowedChannels = (guildConfig?.commandChannels?.channels || [])
      .filter(id => message.guild.channels.cache.has(id));
    if (guildConfig?.commandChannels?.enabled && allowedChannels.length > 0 && command.category !== 'config') {
      const isAllowedChannel = allowedChannels.includes(message.channel.id);
      const hasBypassRole = guildConfig.commandChannels.bypassRoles?.some(roleId =>
        message.member.roles.cache.has(roleId)
      );
      // Allow music commands in voice channel text chats
      const isVoiceChannelChat = message.channel.isVoiceBased?.() || message.channel.type === 2;
      const isMusicCommandInVoice = command.category === 'music' && isVoiceChannelChat;

      if (!isAllowedChannel && !hasBypassRole && !isMusicCommandInVoice) {
        // Silently ignore commands in non-allowed channels
        // Or optionally send a warning (delete after 5 seconds)
        const allowedChannelsList = allowedChannels
          .slice(0, 3)
          .map(id => `<#${id}>`)
          .join(', ');
        const msg = await safeReply({
          content: `**Notice:** Commands are restricted to designated channels: ${allowedChannelsList}${allowedChannels.length > 3 ? '...' : ''}`
        });
        if (msg) setTimeout(() => msg.delete().catch(() => { }), 5000);
        return;
      }
    }

    // Cache bot member for permission checks
    const botMember = message.guild.members.me;
    const botPerms = botMember.permissions;

    // Quick permission checks - exit early if missing critical permissions
    if (!botPerms.has(PermissionFlagsBits.SendMessages)) return;
    if (!botPerms.has(PermissionFlagsBits.EmbedLinks)) {
      return safeReply({ content: "**Warning:** I lack the **`EmbedLinks`** permission, Master." });
    }

    const ctx = new Context(message, args);
    ctx.setArgs(args);
    // Array form lists the Discord permissions a member needs. Configured
    // admin/moderator/staff roles also qualify, matching the commands' own checks.
    if (
      Array.isArray(command.permissions) &&
      !message.member.permissions.has(command.permissions) &&
      !hasModPerms(message.member, guildConfig)
    ) {
      return await safeReply({
        content: "**Notice:** Your authority level is insufficient for this skill, Master.",
      });
    }
    if (command.permissions) {
      if (command.permissions.client) {
        if (
          !message.guild.members.me.permissions.has(command.permissions.client)
        )
          return await safeReply({
            content: "**Alert:** I lack the required permissions to execute this skill, Master.",
          });
      }
      if (command.permissions.user) {
        if (!message.member.permissions.has(command.permissions.user))
          return await safeReply({
            content: "**Notice:** Your authority level is insufficient for this skill, Master.",
          });
      }
      if (command.permissions.dev) {
        if (this.client.config.owners) {
          const findDev = this.client.config.owners.find(
            (x) => x === message.author.id
          );
          if (!findDev) return;
        }
      }
    }
    if (command.player) {
      if (command.player.voice) {
        if (!message.member.voice.channel)
          return await safeReply({
            content: `**Notice:** Voice channel connection required for the \`${command.name}\` skill, Master.`,
          });
        if (
          !message.guild.members.me.permissions.has(PermissionFlagsBits.Connect)
        )
          return await safeReply({
            content: `**Warning:** I lack \`CONNECT\` permissions for the \`${command.name}\` skill, Master.`,
          });
        if (
          !message.guild.members.me.permissions.has(PermissionFlagsBits.Speak)
        )
          return await safeReply({
            content: `**Warning:** I lack \`SPEAK\` permissions for the \`${command.name}\` skill, Master.`,
          });
        if (
          message.member.voice.channel.type === ChannelType.GuildStageVoice &&
          !message.guild.members.me.permissions.has(
            PermissionFlagsBits.RequestToSpeak
          )
        )
          return await safeReply({
            content: `**Warning:** I lack \`REQUEST TO SPEAK\` permissions for the \`${command.name}\` skill, Master.`,
          });
        if (message.guild.members.me.voice.channel) {
          if (
            message.guild.members.me.voice.channelId !==
            message.member.voice.channelId
          )
            return await safeReply({
              content: `**Notice:** Please connect to <#${message.guild.members.me.voice.channel.id}> to use the \`${command.name}\` skill, Master.`,
            });
        }
      }
      if (command.player.active) {
        const player = this.client.moonlink?.players.get(message.guildId);
        if (!player)
          return await safeReply({
            content: "**Notice:** No audio is currently playing, Master.",
          });
        if ((!player.queue || player.queue.size === 0) && !player.current)
          return await safeReply({
            content: "**Notice:** The playback queue is empty, Master.",
          });
      }
      if (command.player.dj) {
        const dj = await this.client.db.getDj(message.guildId);
        if (dj && dj.mode) {
          const djRole = await this.client.db.getRoles(message.guildId);
          if (!djRole)
            return await safeReply({
              content: "**Warning:** DJ role has not been configured.",
            });
          const findDJRole = message.member.roles.cache.find((x) =>
            djRole.map((y) => y.roleId).includes(x.id)
          );
          if (!findDJRole) {
            if (
              !message.member.permissions.has(PermissionFlagsBits.ManageGuild)
            ) {
              const msg = await safeReply({
                content: "**Notice:** DJ role required for this skill, Master.",
              });
              if (msg) setTimeout(() => msg.delete().catch(() => { }), 5000);
              return;
            }
          }
        }
      }
    }
    if (command.args) {
      if (!args.length) {
        const embed = this.client
          .embed()
          .setColor('#00CED1')
          .setTitle("『 Missing Parameters 』")
          .setDescription(
            `**Notice:** Additional parameters are required for the \`${command.name}\` skill, Master.\n\n**Usage Examples:**\n${command.description.examples
              ? command.description.examples.map(e => `▸ \`${e}\``).join("\n")
              : "None available"
            }`
          )
          .setFooter({ text: `${getRandomFooter()} | Syntax: [] = optional, <> = required` });
        return await safeReply({ embeds: [embed] });
      }
    }
    // Keyed by command name, not the alias typed: otherwise !bj, !21 and !blackjack
    // each had their own cooldown
    if (!this.client.cooldowns.has(command.name)) {
      this.client.cooldowns.set(command.name, new Collection());
    }
    const now = Date.now();
    const timestamps = this.client.cooldowns.get(command.name);
    const cooldownAmount = Math.floor(command.cooldown || 10) * 1000;
    if (!timestamps.has(message.author.id)) {
      timestamps.set(message.author.id, now);
      setTimeout(() => timestamps.delete(message.author.id), cooldownAmount);
    } else {
      const expirationTime = timestamps.get(message.author.id) + cooldownAmount;
      const timeLeft = (expirationTime - now) / 1000;
      if (now < expirationTime && timeLeft > 0.9) {
        return await safeReply({
          content: `**Notice:** Skill cooldown in effect, Master. Please wait \`${timeLeft.toFixed(1)}\` seconds before using \`${cmd}\` again.`,
        });
      }
      timestamps.set(message.author.id, now);
      setTimeout(() => timestamps.delete(message.author.id), cooldownAmount);
    }
    if (args.includes("@everyone") || args.includes("@here"))
      return await safeReply({
        content: "**Warning:** Mass mention parameters are not permitted, Master.",
      });
    try {
      if (command.run) {
        return await command.run(this.client, ctx, ctx.args);
      } else if (command.execute) {
        // Awaited so errors from async commands reach the catch below
        return await command.execute(message, args, this.client);
      }
    } catch (error) {
      this.client.logger.error(error);
      await safeReply({ content: `**Alert:** An anomaly occurred during execution: \`${error}\`` });
      return;
    }
  }
};

export default MessageCreate;