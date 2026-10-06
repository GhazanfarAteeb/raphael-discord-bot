import { Events, MessageFlags, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import Giveaway from '../../models/Giveaway.js';
import {
  endGiveawayById,
  announceGiveawayResults,
  scheduleGiveawayRefresh,
  requiredRoleId
} from '../../commands/community/giveaway.js';

const PARTICIPANTS_PREVIEW = 20;
// Giveaways handled per scheduler pass (the rest follow on the next pass)
const BATCH_SIZE = 25;
// A claimed giveaway still unannounced after this long was interrupted (the bot stopped mid-way)
const INTERRUPTED_AFTER_MS = 5 * 60 * 1000;

const CONCLUDED = '**Notice:** This giveaway has already concluded, Master.';
const MISSING = '**Error:** This giveaway no longer exists, Master.';

// Buttons: giveaway_enter and giveaway_participants on the giveaway message, and
// giveaway_leave_<messageId> on the ephemeral "already entered" reply
export default {
  name: Events.InteractionCreate,
  async execute(interaction) {
    if (!interaction.isButton()) return;
    if (!interaction.customId.startsWith('giveaway_')) return;
    if (!interaction.inGuild()) return;

    const [, action, messageId] = interaction.customId.split('_');

    try {
      if (action === 'enter') return await handleEnter(interaction);
      if (action === 'participants') return await handleParticipants(interaction);
      if (action === 'leave') return await handleLeave(interaction, messageId);
    } catch (error) {
      console.error('[giveawayHandler] Error:', error);
      const content = '**Alert:** I was unable to process your giveaway request, Master.';
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content, components: [] }).catch(() => { });
      } else {
        await interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => { });
      }
    }
  }
};

function findGiveaway(interaction, messageId) {
  return Giveaway.findOne({ messageId, guildId: interaction.guildId });
}

// Entries close at endsAt, even before the scheduler has drawn the winners
function isOpen(giveaway) {
  return !giveaway.ended && new Date(giveaway.endsAt) > new Date();
}

// Cached guilds give a GuildMember; otherwise the API member carries role IDs
function memberHasRole(member, roleId) {
  const roles = member?.roles;
  if (Array.isArray(roles)) return roles.includes(roleId);
  return Boolean(roles?.cache?.has(roleId));
}

function alreadyEnteredReply(giveaway) {
  return {
    content: `**Notice:** Your entry for **${giveaway.prize}** is already registered, Master. Activate the button below to withdraw it.`,
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`giveaway_leave_${giveaway.messageId}`)
          .setLabel('Withdraw Entry')
          .setStyle(ButtonStyle.Danger)
      )
    ],
    allowedMentions: { parse: [] }
  };
}

async function handleEnter(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const giveaway = await findGiveaway(interaction, interaction.message.id);
  if (!giveaway) return interaction.editReply({ content: MISSING });
  if (!isOpen(giveaway)) return interaction.editReply({ content: CONCLUDED });

  const userId = interaction.user.id;

  // Clicking Enter again (often an accidental double click) never withdraws by itself:
  // it offers a separate withdraw button
  if (giveaway.participants.includes(userId)) {
    return interaction.editReply(alreadyEnteredReply(giveaway));
  }

  const roleId = requiredRoleId(interaction.guild, giveaway);
  if (roleId && !memberHasRole(interaction.member, roleId)) {
    return interaction.editReply({
      content: `**Error:** The <@&${roleId}> role is required to enter this giveaway, Master.`,
      allowedMentions: { parse: [] }
    });
  }

  const updated = await giveaway.addParticipant(userId);
  if (!updated) {
    // A parallel click registered first, or entries closed in the meantime
    const entered = await Giveaway.exists({ _id: giveaway._id, participants: userId });
    return interaction.editReply(entered ? alreadyEnteredReply(giveaway) : { content: CONCLUDED });
  }

  scheduleGiveawayRefresh(interaction.guild, updated);

  return interaction.editReply({
    content: `**Confirmed:** Giveaway entry registered for **${updated.prize}**, Master.\n` +
      '**Notice:** Activate Enter again if you wish to withdraw.',
    allowedMentions: { parse: [] }
  });
}

// The withdraw button on the ephemeral "already entered" reply
async function handleLeave(interaction, messageId) {
  await interaction.deferUpdate();
  const done = content => interaction.editReply({ content, components: [], allowedMentions: { parse: [] } });

  const giveaway = messageId ? await findGiveaway(interaction, messageId) : null;
  if (!giveaway) return done(MISSING);
  if (!isOpen(giveaway)) return done('**Notice:** This giveaway has already concluded; entries can no longer be withdrawn, Master.');

  const updated = await giveaway.removeParticipant(interaction.user.id);
  if (!updated) return done('**Notice:** You are not entered in this giveaway, or it has just concluded, Master.');

  scheduleGiveawayRefresh(interaction.guild, updated);
  return done(`**Confirmed:** You have withdrawn from the giveaway for **${updated.prize}**, Master.`);
}

async function handleParticipants(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const giveaway = await findGiveaway(interaction, interaction.message.id);
  if (!giveaway) return interaction.editReply({ content: MISSING });

  const participants = giveaway.participants;
  if (participants.length === 0) {
    return interaction.editReply({ content: '**Notice:** No one has entered this giveaway yet, Master.' });
  }

  const participantList = participants.slice(0, PARTICIPANTS_PREVIEW).map(id => `<@${id}>`).join(', ');
  const moreCount = participants.length > PARTICIPANTS_PREVIEW ? ` and ${participants.length - PARTICIPANTS_PREVIEW} more` : '';

  return interaction.editReply({
    content: `**Participants (${participants.length}):**\n${participantList}${moreCount}`,
    allowedMentions: { parse: [] }
  });
}

// Ends due giveaways and finishes interrupted announcements. Called every 15 seconds by the
// scheduler; a pass still running (slow member lookups) makes the next tick skip.
let checkRunning = false;
export async function checkGiveaways(client) {
  if (checkRunning) return;
  checkRunning = true;
  try {
    // Check if database is connected before proceeding
    if (!client.db || !client.db.testConnection || !(await client.db.testConnection())) {
      console.log('[Giveaways] Database not connected, skipping check');
      return;
    }
    await endDueGiveaways(client);
    await resumeInterruptedGiveaways(client);
  } catch (error) {
    console.error('[Giveaways] Error checking giveaways:', error);
  } finally {
    checkRunning = false;
  }
}

async function endDueGiveaways(client) {
  const due = await Giveaway.getDueGiveaways(BATCH_SIZE);

  for (const giveaway of due) {
    const guild = client.guilds.cache.get(giveaway.guildId);
    // Server outage: try again on a later pass
    if (guild && !guild.available) continue;

    try {
      if (!guild) {
        // I am no longer in this server: close it so it is not retried forever
        await Giveaway.updateOne(
          { _id: giveaway._id, ended: false },
          { $set: { ended: true, endedAt: new Date(), announced: true } }
        );
        continue;
      }
      await endGiveawayById(guild, giveaway);
    } catch (error) {
      console.error(`[Giveaways] Failed to end giveaway ${giveaway.messageId}:`, error);
    }
  }
}

// Winners drawn and stored, but the bot stopped before the results were posted
async function resumeInterruptedGiveaways(client) {
  const interrupted = await Giveaway.getInterruptedGiveaways(new Date(Date.now() - INTERRUPTED_AFTER_MS), BATCH_SIZE);

  for (const stale of interrupted) {
    const guild = client.guilds.cache.get(stale.guildId);
    if (guild && !guild.available) continue;

    try {
      // Re-claim (endedAt must be unchanged) so the announcement is resumed only once
      const giveaway = await Giveaway.findOneAndUpdate(
        { _id: stale._id, announced: false, endedAt: stale.endedAt },
        { $set: guild ? { endedAt: new Date() } : { announced: true } },
        { new: true }
      );
      if (!giveaway || !guild) continue;

      console.log(`[Giveaways] Resuming the interrupted announcement of giveaway ${giveaway.messageId}`);
      await announceGiveawayResults(guild, giveaway);
    } catch (error) {
      console.error(`[Giveaways] Failed to resume giveaway ${stale.messageId}:`, error);
    }
  }
}
