import { AttachmentBuilder, ChannelType, PermissionFlagsBits } from 'discord.js';
import { errorEmbed, successEmbed, warningEmbed, infoEmbed, GLYPHS } from '../../utils/embeds.js';
import { formatNumber } from '../../utils/helpers.js';
import logger from '../../utils/logger.js';

const NEW_INVITE_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
// An existing invite is reused only if it stays valid at least this long
const MIN_REMAINING_MS = 24 * 60 * 60 * 1000;
const INVITE_PERMISSIONS = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.CreateInstantInvite];

export default {
  name: 'exportinvites',
  category: 'admin',
  description: 'Export all server invites to a text file (Owner only)',
  ownerOnly: true,

  async execute(message) {
    const guildId = message.guild.id;

    try {
      const guilds = [...message.client.guilds.cache.values()].sort((a, b) => b.memberCount - a.memberCount);

      if (guilds.length === 0) {
        return message.reply({
          embeds: [await errorEmbed(guildId, 'No Servers Found', 'I am not currently present in any servers, Master.')]
        });
      }

      const statusMessage = await message.reply({
        embeds: [await infoEmbed(guildId, 'Compiling Invites', `Processing ${formatNumber(guilds.length)} servers, Master...`)]
      });

      const rows = [];
      const counts = { reused: 0, created: 0, failed: 0 };

      for (const guild of guilds) {
        let inviteUrl;
        try {
          const result = await resolveInvite(guild);
          if (result) {
            inviteUrl = result.url;
            counts[result.reused ? 'reused' : 'created']++;
          } else {
            inviteUrl = 'PERMISSION_DENIED';
            counts.failed++;
          }
        } catch (error) {
          inviteUrl = `ERROR: ${error.message}`;
          counts.failed++;
        }

        rows.push({ name: guild.name, id: guild.id, members: guild.memberCount, owner: guild.ownerId, inviteUrl });
      }

      const generated = counts.reused + counts.created;
      let content = 'Raphael Server Invite Export\n';
      content += `Generated: ${new Date().toISOString()}\n`;
      content += `Total Servers: ${guilds.length}\n`;
      content += `Invites: ${generated} (${counts.reused} reused, ${counts.created} newly created with a 7-day expiry)\n`;
      content += `Failed/Restricted: ${counts.failed}\n`;
      content += `\n${'='.repeat(80)}\n\n`;
      rows.forEach((row, index) => {
        content += `${index + 1}. ${row.name}\n`;
        content += `   Server ID: ${row.id}\n`;
        content += `   Members: ${row.members}\n`;
        content += `   Owner ID: ${row.owner}\n`;
        content += `   Invite: ${row.inviteUrl}\n\n`;
      });

      const fileName = `raphael-invites-${Date.now()}.txt`;
      const attachment = () => new AttachmentBuilder(Buffer.from(content, 'utf-8')).setName(fileName);

      const summary = await successEmbed(guildId, 'Export Complete',
        `Compiled invite links for **${formatNumber(generated)}** of **${formatNumber(guilds.length)}** servers, Master.`);
      summary.addFields(
        { name: `${GLYPHS.ARROW_RIGHT} Reused`, value: formatNumber(counts.reused), inline: true },
        { name: `${GLYPHS.ARROW_RIGHT} Newly Created`, value: formatNumber(counts.created), inline: true },
        { name: `${GLYPHS.ARROW_RIGHT} Failed/Restricted`, value: formatNumber(counts.failed), inline: true }
      );

      // The invite file goes to the owner's DMs; the channel only gets a confirmation
      const delivered = await message.author.send({ embeds: [summary], files: [attachment()] }).catch(() => null);
      if (delivered) {
        return statusMessage.edit({
          embeds: [await successEmbed(guildId, 'Delivered', 'The invite export has been sent to your direct messages, Master.')]
        });
      }

      const notice = await warningEmbed(guildId, 'Direct Messages Closed',
        'I could not reach your direct messages, so the export is posted here instead, Master.');
      return statusMessage.edit({ embeds: [notice, summary], files: [attachment()] });
    } catch (error) {
      logger.error('[ExportInvites] Command failed', error);
      const embed = await errorEmbed(guildId, 'Export Failed',
        'An anomaly occurred while exporting invites, Master. The incident has been logged.').catch(() => null);
      return message.reply(embed ? { embeds: [embed] } : { content: '**Alert:** The invite export failed, Master.' }).catch(() => null);
    }
  }
};

// The vanity URL, else an existing long-lived invite, else a new 7-day invite; null when none is possible
async function resolveInvite(guild) {
  if (guild.vanityURLCode) return { url: `https://discord.gg/${guild.vanityURLCode}`, reused: true };

  const me = guild.members.me;
  if (!me) return null;

  // Listing invites needs Manage Server; without it a new invite is created instead
  if (me.permissions.has(PermissionFlagsBits.ManageGuild)) {
    const invites = await guild.invites.fetch().catch(() => null);
    const reusable = invites
      ?.filter(isReusable)
      .sort((a, b) => remainingMs(b) - remainingMs(a))
      .first();
    if (reusable) return { url: reusable.url, reused: true };
  }

  const channel = pickInviteChannel(guild);
  if (!channel) return null;

  const invite = await channel.createInvite({
    maxAge: NEW_INVITE_MAX_AGE_SECONDS,
    maxUses: 0,
    reason: 'Invite export by the bot owner'
  });
  return { url: invite.url, reused: false };
}

function remainingMs(invite) {
  return invite.maxAge === 0 ? Infinity : (invite.expiresTimestamp ?? 0) - Date.now();
}

function isReusable(invite) {
  if (invite.temporary) return false;
  if (invite.maxUses && invite.uses >= invite.maxUses) return false;
  return remainingMs(invite) >= MIN_REMAINING_MS;
}

// The system channel when usable, otherwise the topmost text channel I can invite from
function pickInviteChannel(guild) {
  const me = guild.members.me;
  const usable = c => c?.type === ChannelType.GuildText && c.permissionsFor(me)?.has(INVITE_PERMISSIONS);
  if (usable(guild.systemChannel)) return guild.systemChannel;
  return guild.channels.cache.filter(usable).sort((a, b) => a.rawPosition - b.rawPosition).first() ?? null;
}
