/**
 * Music voice-state housekeeping (moonlink players)
 * - Ends the audio session when the bot is disconnected or removed from voice
 * - Leaves after musicConfig.autoLeave.timeout once no listeners remain in the bot's channel
 * - Takes the stage (unsuppresses) when the bot joins a Stage channel
 */

import { ChannelType, PermissionFlagsBits } from "discord.js";
import Event from "../../structures/Event.js";
import musicConfig from "../../music/config.js";
import { infoEmbed } from "../../utils/embeds.js";
import { cancelAutoLeave, scheduleAutoLeave } from "../../music/RiffyManager.js";

// moonlink briefly drops and re-joins voice while recovering a connection;
// a disconnect only ends the session if the bot is still out of voice after this.
const DISCONNECT_GRACE_MS = 5000;
const MS_PER_MINUTE = 60000;

function countListeners(channel) {
  return channel?.members?.filter((member) => !member.user.bot).size ?? 0;
}

class VoiceStateUpdate extends Event {
  constructor(client, file) {
    super(client, file, {
      name: "voiceStateUpdate",
    });
  }

  async run(oldState, newState) {
    try {
      const guild = newState.guild ?? oldState.guild;
      if (!guild) return;

      const player = this.client.moonlink?.players.get(guild.id);
      if (!player || player.destroyed) return;

      const botId = this.client.user.id;

      if (newState.id === botId) {
        if (!newState.channelId) {
          this.handleBotDisconnected(guild);
          return;
        }

        // Back in voice (or moved): a pending disconnect clean-up no longer applies
        cancelAutoLeave(guild.id, "disconnected");
        await this.takeStage(newState);
      }

      this.checkListeners(guild, oldState, newState);
    } catch (error) {
      this.client.logger.error("Error in music voiceStateUpdate handler:", error);
    }
  }

  /**
   * The bot was disconnected (kicked, channel deleted, moved out by a moderator).
   * moonlink only marks its voice connection as disconnected and keeps the player,
   * queue and now-playing buttons alive, so the session is ended here.
   */
  handleBotDisconnected(guild) {
    cancelAutoLeave(guild.id, "alone");
    scheduleAutoLeave(
      this.client,
      guild.id,
      "disconnected",
      DISCONNECT_GRACE_MS,
      (player) => {
        if (guild.members.me?.voice?.channelId) return false;
        // moonlink is re-establishing the connection itself; its recovery destroys the player on failure
        const recovering =
          player.get("voiceCloseRecoveryInProgress") ||
          player.voice?.isMoving ||
          Boolean(player.voice?.connectPromise);
        return !recovering;
      },
    );
  }

  /**
   * Starts (or cancels) the countdown that ends the session when only bots remain
   * in the bot's voice channel. Only events touching that channel are considered.
   */
  checkListeners(guild, oldState, newState) {
    const botChannelId = guild.members.me?.voice?.channelId;
    if (!botChannelId) return;

    const botId = this.client.user.id;
    const relevant =
      newState.id === botId ||
      oldState.channelId === botChannelId ||
      newState.channelId === botChannelId;
    if (!relevant) return;

    const channel = guild.channels.cache.get(botChannelId);
    if (countListeners(channel) > 0) {
      cancelAutoLeave(guild.id, "alone");
      return;
    }

    const autoLeave = musicConfig.autoLeave ?? {};
    if (autoLeave.enabled === false) return;
    const timeout = autoLeave.timeout ?? 300000;

    scheduleAutoLeave(
      this.client,
      guild.id,
      "alone",
      timeout,
      () => {
        const currentId = guild.members.me?.voice?.channelId;
        return !currentId || countListeners(guild.channels.cache.get(currentId)) === 0;
      },
      (player) => this.announceAutoLeave(player, timeout),
    );
  }

  async announceAutoLeave(player, timeout) {
    const channel = this.client.channels.cache.get(player.textChannelId);
    if (!channel) return;

    const minutes = Math.max(1, Math.round(timeout / MS_PER_MINUTE));
    await channel
      .send({
        embeds: [
          await infoEmbed(
            player.guildId,
            "Audio Session Concluded",
            `**Notice:** The voice channel has had no listeners for ${minutes} minute${minutes !== 1 ? "s" : ""}. I have disconnected to conserve resources, Master.`,
          ),
        ],
      })
      .catch(() => {});
  }

  /**
   * In a Stage channel the bot joins as an audience member; become a speaker
   * (or request to speak when lacking the permission to do so directly).
   */
  async takeStage(state) {
    if (state.channel?.type !== ChannelType.GuildStageVoice || !state.suppress) return;

    const permissions = state.channel.permissionsFor(state.guild.members.me);
    if (permissions?.has(PermissionFlagsBits.MuteMembers)) {
      await state.setSuppressed(false).catch((error) => {
        this.client.logger.warn(`Could not unsuppress in stage channel ${state.channelId}: ${error.message}`);
      });
    } else if (
      permissions?.has(PermissionFlagsBits.RequestToSpeak) &&
      !state.requestToSpeakTimestamp
    ) {
      await state.setRequestToSpeak(true).catch((error) => {
        this.client.logger.warn(`Could not request to speak in stage channel ${state.channelId}: ${error.message}`);
      });
    }
  }
}

export default VoiceStateUpdate;
