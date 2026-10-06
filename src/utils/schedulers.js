import cron from 'node-cron';
import Birthday from '../models/Birthday.js';
import Event from '../models/Event.js';
import Guild from '../models/Guild.js';
import BoosterRole from '../models/BoosterRole.js';
import { infoEmbed, GLYPHS } from '../utils/embeds.js';
import { buildBirthdayMessage, getAnnouncedAge, sendBirthdayAnnouncement } from '../commands/config/birthdayconfig.js';
import { checkGiveaways } from '../events/client/giveawayHandler.js';
import { checkReminders } from '../events/client/reminderHandler.js';
import { cleanupTempChannels } from '../events/client/tempVoiceHandler.js';

const FEB = 2;
const LEAP_DAY = 29;
const MAX_CONTENT_LENGTH = 2000;
const MAX_FIELD_LENGTH = 1024;

function isLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

// Today's birthdays; Feb 29 birthdays are celebrated on Feb 28 in non-leap years
async function getBirthdaysToCelebrate(guildId, today) {
  const birthdays = await Birthday.getTodaysBirthdays(guildId);
  const isFeb28 = today.getMonth() + 1 === FEB && today.getDate() === 28;

  if (isFeb28 && !isLeapYear(today.getFullYear())) {
    const leapDay = await Birthday.find({
      guildId,
      displayBirthday: true,
      'birthday.month': FEB,
      'birthday.day': LEAP_DAY
    });
    birthdays.push(...leapDay);
  }

  return birthdays;
}

function getBirthdayChannel(guild, guildConfig) {
  const ids = [guildConfig.features?.birthdaySystem?.channel, guildConfig.channels?.birthdayChannel];
  for (const id of ids) {
    const channel = id ? guild.channels.cache.get(id) : null;
    if (channel) return channel;
  }
  return null;
}

async function giveBirthdayRole(guild, member, guildConfig) {
  const roleId = guildConfig.roles?.birthdayRole || guildConfig.features?.birthdaySystem?.role;
  if (!roleId) return false;

  const role = guild.roles.cache.get(roleId);
  if (!role || member.roles.cache.has(role.id)) return false;
  if (!role.editable) {
    console.warn(`[Birthday] Cannot assign birthday role ${role.id} in ${guild.id}: it is above my highest role or managed.`);
    return false;
  }

  await member.roles.add(role, 'Birthday');
  return true;
}

async function celebrateBirthday(guild, guildConfig, channel, birthday, today) {
  // celebrationPreference: public (default) = role + announcement, dm = role + DM,
  // role = role only, none = no celebration
  const preference = birthday.celebrationPreference || 'public';
  if (preference === 'none') return false;

  const member = await guild.members.fetch(birthday.userId).catch(() => null);
  if (!member) return false;

  let celebrated = false;

  // The role is independent of the announcement: a role failure must not skip the message
  try {
    celebrated = await giveBirthdayRole(guild, member, guildConfig) || celebrated;
  } catch (error) {
    console.error(`[Birthday] Failed to give birthday role to ${birthday.userId}:`, error.message);
  }

  if (preference === 'public' && channel) {
    celebrated = await sendBirthdayAnnouncement({ channel, member, guildConfig, birthday, date: today }) || celebrated;
  }

  if (preference === 'dm') {
    try {
      await member.send(buildBirthdayMessage(member, guildConfig, {
        age: getAnnouncedAge(birthday, guildConfig, today),
        customMessage: birthday.customMessage,
        silent: true
      }));
      celebrated = true;
    } catch {
      console.log(`Could not DM birthday user: ${birthday.userId}`);
    }
  }

  return celebrated;
}

// Check birthdays every day at midnight
export function startBirthdayChecker(client) {
  cron.schedule('0 0 * * *', async () => {
    console.log('[RAPHAEL] Checking birthdays...');

    try {
      const guilds = await Guild.find({ 'features.birthdaySystem.enabled': true });

      for (const guildConfig of guilds) {
        const guild = client.guilds.cache.get(guildConfig.guildId);
        if (!guild) continue;

        try {
          const today = new Date();
          const birthdays = await getBirthdaysToCelebrate(guildConfig.guildId, today);
          if (birthdays.length === 0) continue;

          const channel = getBirthdayChannel(guild, guildConfig);

          for (const birthday of birthdays) {
            try {
              // Skip if already celebrated today
              if (birthday.lastCelebrated &&
                new Date(birthday.lastCelebrated).toDateString() === today.toDateString()) {
                continue;
              }

              const celebrated = await celebrateBirthday(guild, guildConfig, channel, birthday, today);
              if (!celebrated) continue;

              birthday.lastCelebrated = today;
              birthday.notificationSent = true;
              await birthday.save();
            } catch (error) {
              console.error(`Error celebrating birthday for ${birthday.userId}:`, error);
            }
          }
        } catch (error) {
          console.error(`Error checking birthdays for guild ${guildConfig.guildId}:`, error);
        }
      }

    } catch (error) {
      console.error('Error in birthday checker:', error);
    }
  });

  console.log('[RAPHAEL] Birthday monitoring system initialized.');
}

// Role and participant mentions for an event reminder, kept under the message limit
function buildEventMentions(event) {
  const roleIds = (event.notificationRoles || []).filter(Boolean);
  const userIds = [...new Set((event.participants || []).map(p => p.userId).filter(Boolean))];

  const parts = roleIds.length > 0 ? roleIds.map(id => `<@&${id}>`) : ['@here'];
  const mentionedUsers = [];
  const reserve = 30; // room for the "+N more" suffix

  for (const userId of userIds) {
    const mention = `<@${userId}>`;
    if ([...parts, mention].join(' ').length > MAX_CONTENT_LENGTH - reserve) break;
    parts.push(mention);
    mentionedUsers.push(userId);
  }

  const remaining = userIds.length - mentionedUsers.length;
  if (remaining > 0) parts.push(`and ${remaining} more participant${remaining !== 1 ? 's' : ''}`);

  return {
    content: parts.join(' '),
    allowedMentions: {
      parse: roleIds.length > 0 ? [] : ['everyone'],
      roles: roleIds,
      users: mentionedUsers
    }
  };
}

async function sendEventReminder(client, event) {
  const guild = client.guilds.cache.get(event.guildId);
  if (!guild) return;

  const guildConfig = await Guild.getGuild(event.guildId);
  if (guildConfig.features?.eventSystem?.enabled === false) return;

  const channelIds = [
    event.notificationChannel,
    guildConfig.features?.eventSystem?.channel,
    guildConfig.channels?.eventChannel
  ];
  const channel = channelIds.map(id => (id ? guild.channels.cache.get(id) : null)).find(Boolean);
  if (!channel) return;

  // Calculate time until event
  const timeUntil = Math.floor((event.eventDate.getTime() - Date.now()) / (1000 * 60));

  // Create notification embed
  const embed = await infoEmbed(event.guildId,
    `${GLYPHS.BELL} Event Reminder`,
    `**${event.title}** is starting ${timeUntil <= 1 ? 'now' : `in ${timeUntil} minutes`}, Master.`
  );

  if (event.description) {
    embed.addFields({
      name: '▸ Description',
      value: event.description.length > MAX_FIELD_LENGTH
        ? `${event.description.slice(0, MAX_FIELD_LENGTH - 1)}…`
        : event.description,
      inline: false
    });
  }

  if (event.location) {
    const locationChannel = guild.channels.cache.get(event.location);
    embed.addFields({
      name: '▸ Location',
      value: locationChannel ? locationChannel.toString() : event.location.slice(0, MAX_FIELD_LENGTH),
      inline: true
    });
  }

  embed.addFields({
    name: '▸ Time',
    value: `<t:${Math.floor(event.eventDate.getTime() / 1000)}:F>`,
    inline: true
  });

  if (event.participants.length > 0) {
    embed.addFields({
      name: '▸ Participants',
      value: `${event.participants.length} member${event.participants.length !== 1 ? 's' : ''}`,
      inline: true
    });
  }

  if (event.color) {
    try {
      embed.setColor(event.color);
    } catch {
      // Keep the theme color when the stored color is invalid
    }
  }
  if (event.imageUrl) {
    try {
      embed.setImage(event.imageUrl);
    } catch {
      // Skip an invalid image URL rather than dropping the reminder
    }
  }

  await channel.send({ ...buildEventMentions(event), embeds: [embed] });

  // Update event status
  event.status = 'notified';
  event.reminders.push({
    sentAt: new Date(),
    minutesBefore: timeUntil
  });
  await event.save();

  console.log(`[RAPHAEL] Event notification dispatched: ${event.title}`);
}

// Check for events every minute
export function startEventChecker(client) {
  cron.schedule('* * * * *', async () => {
    try {
      const events = await Event.getEventsNeedingNotification();

      for (const event of events) {
        if (!event.shouldSendReminder()) continue;

        // One failing event must not block the reminders after it
        try {
          await sendEventReminder(client, event);
        } catch (error) {
          console.error(`Error sending reminder for event ${event._id}:`, error);
        }
      }

    } catch (error) {
      console.error('Error in event checker:', error);
    }
  });

  console.log('[RAPHAEL] Event monitoring system initialized.');
}

// Remove birthday role at end of day
export function startBirthdayRoleRemover(client) {
  cron.schedule('59 23 * * *', async () => {
    console.log('[RAPHAEL] Removing birthday roles...');

    try {
      // The role can be stored in either place (the birthday checker reads both)
      const guilds = await Guild.find({
        'features.birthdaySystem.enabled': true,
        $or: [
          { 'roles.birthdayRole': { $nin: [null, ''] } },
          { 'features.birthdaySystem.role': { $nin: [null, ''] } }
        ]
      });

      for (const guildConfig of guilds) {
        const guild = client.guilds.cache.get(guildConfig.guildId);
        if (!guild) continue;

        const roleId = guildConfig.roles?.birthdayRole || guildConfig.features?.birthdaySystem?.role;
        const birthdayRole = roleId ? guild.roles.cache.get(roleId) : null;
        if (!birthdayRole) continue;

        // Remove role from all members who have it
        const membersWithRole = birthdayRole.members;
        for (const [_, member] of membersWithRole) {
          try {
            await member.roles.remove(birthdayRole);
          } catch (error) {
            console.error(`Error removing birthday role from ${member.id}:`, error.message);
          }
        }
      }

    } catch (error) {
      console.error('Error removing birthday roles:', error);
    }
  });

  console.log('[RAPHAEL] Birthday role removal scheduler initialized.');
}

// Remove expired temporary booster roles. Checked every minute, so a role is removed within
// about a minute of expiring; the first check runs shortly after startup and catches roles
// that expired while the bot was offline. A failed removal (missing permissions, API errors)
// is retried later with a growing delay instead of being forgotten.
const BOOSTER_ROLE_CHECK_INTERVAL_MS = 60 * 1000;
const BOOSTER_ROLE_STARTUP_DELAY_MS = 15 * 1000;
// Unknown Guild, Unknown Member, Unknown Role, Unknown User: there is nothing left to remove
const BOOSTER_ROLE_GONE_CODES = new Set([10004, 10007, 10011, 10013]);

export async function removeExpiredBoosterRoles(client) {
  if (!client.isReady()) return;

  const expiredRoles = await BoosterRole.getExpiredRoles();
  let removedCount = 0;
  let failedCount = 0;

  for (const entry of expiredRoles) {
    try {
      const guild = client.guilds.cache.get(entry.guildId);
      if (!guild) {
        // The bot is no longer in the server
        await BoosterRole.deleteIfExpired(entry);
        continue;
      }
      // Server outage: try again on a later run
      if (!guild.available) continue;

      const role = guild.roles.cache.get(entry.roleId);
      if (!role) {
        await BoosterRole.deleteIfExpired(entry);
        continue;
      }

      // Only a member who left ends the record here; other fetch errors are retried
      const member = await guild.members.fetch(entry.userId).catch(error => {
        if (BOOSTER_ROLE_GONE_CODES.has(error.code)) return null;
        throw error;
      });

      // Renewed with "boost give" or removed with "boost take" since the query ran
      if (!(await BoosterRole.isStillExpired(entry))) continue;

      if (member?.roles.cache.has(role.id)) {
        await member.roles.remove(role, 'Temporary booster role expired');
        console.log(`[RAPHAEL] Removed expired booster role ${role.name} from ${member.user.tag} in ${guild.name}`);
        removedCount++;
      }

      await BoosterRole.deleteIfExpired(entry);
    } catch (error) {
      if (BOOSTER_ROLE_GONE_CODES.has(error.code)) {
        await BoosterRole.deleteIfExpired(entry).catch(() => {});
        continue;
      }
      failedCount++;
      console.error(`[RAPHAEL] Could not remove expired booster role ${entry.roleId} from ${entry.userId} in ${entry.guildId}:`, error.message);
      await BoosterRole.markRemovalFailed(entry, error).catch(() => {});
    }
  }

  if (removedCount || failedCount) {
    console.log(`[RAPHAEL] Booster role cleanup complete. Removed: ${removedCount}, Failed: ${failedCount}`);
  }
}

export function startBoosterRoleRemover(client) {
  let running = false;
  const run = async () => {
    // A slow run (many records, rate limits) must not overlap the next one
    if (running) return;
    running = true;
    try {
      await removeExpiredBoosterRoles(client);
    } catch (error) {
      console.error('[RAPHAEL] Error in booster role remover:', error);
    } finally {
      running = false;
    }
  };

  setTimeout(() => {
    run();
    setInterval(run, BOOSTER_ROLE_CHECK_INTERVAL_MS);
  }, BOOSTER_ROLE_STARTUP_DELAY_MS);

  console.log('[RAPHAEL] Booster role removal scheduler initialized (checks every minute).');
}

// Check giveaways every 15 seconds
export function startGiveawayChecker(client) {
  setInterval(async () => {
    await checkGiveaways(client);
  }, 15000);

  console.log('[RAPHAEL] Giveaway monitoring system initialized.');
}

// Check reminders every 15 seconds for more timely delivery
export function startReminderChecker(client) {
  // Run immediately on startup to catch any missed reminders
  checkReminders(client).catch(err => console.error('Initial reminder check failed:', err));

  setInterval(async () => {
    try {
      await checkReminders(client);
    } catch (error) {
      console.error('Reminder checker error:', error);
    }
  }, 15000); // 15 seconds for faster reminder delivery

  console.log('[RAPHAEL] Reminder monitoring system initialized.');
}

// Clean up bot economy and member entries daily at midnight
export function startBotEconomyCleanup(client) {
  cron.schedule('0 0 * * *', async () => {
    console.log('🧹 Cleaning up bot economy and member entries...');

    try {
      const Economy = (await import('../models/Economy.js')).default;
      const Member = (await import('../models/Member.js')).default;

      let totalEconomyDeleted = 0;
      let totalMemberDeleted = 0;
      const guilds = client.guilds.cache;

      for (const [guildId, guild] of guilds) {
        try {
          // Fetch all members to ensure we have the latest data
          await guild.members.fetch();

          // Get all economy entries for this guild
          const economyEntries = await Economy.find({ guildId });
          const memberEntries = await Member.find({ guildId });

          for (const entry of economyEntries) {
            try {
              // Try to get the user from Discord
              const user = await client.users.fetch(entry.userId).catch(() => null);

              // Delete if user is a bot (including this bot itself)
              if ((user && user.bot) || entry.userId === client.user.id) {
                // Log the data before deletion
                const username = user ? user.tag : entry.userId;
                console.log(`[BOT CLEANUP] Deleting economy data for bot: ${username} (${entry.userId})`);
                console.log(`  Guild: ${guild.name} (${guildId})`);
                console.log(`  Coins: ${entry.coins || 0}`);
                console.log(`  Bank: ${entry.bank || 0}`);
                console.log(`  Total Wealth: ${(entry.coins || 0) + (entry.bank || 0)}`);
                console.log(`  Daily Streak: ${entry.dailyStreak || 0}`);
                console.log(`  Last Daily: ${entry.lastDaily || 'Never'}`);
                console.log(`  Rep Given: ${entry.repGiven || 0}`);
                console.log(`  Profile Background: ${entry.profileBackground || 'None'}`);
                console.log(`  Entry Created: ${entry.createdAt || 'Unknown'}`);
                console.log(`---`);

                await Economy.deleteOne({ _id: entry._id });
                totalEconomyDeleted++;
              }
            } catch (error) {
              console.error(`Error checking user ${entry.userId}:`, error.message);
            }
          }

          for (const entry of memberEntries) {
            try {
              // Try to get the user from Discord
              const user = await client.users.fetch(entry.userId).catch(() => null);

              // Delete if user is a bot (including this bot itself)
              if ((user && user.bot) || entry.userId === client.user.id) {
                // Log the member data before deletion
                const username = user ? user.tag : entry.userId;
                console.log(`[BOT CLEANUP] Deleting member data for bot: ${username} (${entry.userId})`);
                console.log(`  Guild: ${guild.name} (${guildId})`);
                console.log(`  Warnings: ${entry.warnings?.length || 0}`);
                console.log(`  Mutes: ${entry.mutes?.length || 0}`);
                console.log(`  Kicks: ${entry.kicks?.length || 0}`);
                console.log(`  Bans: ${entry.bans?.length || 0}`);
                console.log(`  Entry Created: ${entry.createdAt || 'Unknown'}`);
                console.log(`---`);

                await Member.deleteOne({ _id: entry._id });
                totalMemberDeleted++;
              }
            } catch (error) {
              console.error(`Error checking member ${entry.userId}:`, error.message);
            }
          }
        } catch (error) {
          console.error(`Error processing guild ${guildId}:`, error.message);
        }
      }

      console.log(`🧹 Bot cleanup complete. Deleted ${totalEconomyDeleted} economy entries and ${totalMemberDeleted} member entries.`);
    } catch (error) {
      console.error('Error in bot economy and member cleanup:', error);
    }
  });

  console.log('[RAPHAEL] Bot economy and member cleanup scheduler initialized (runs daily at midnight).');
}

// Initialize all schedulers
export function initializeSchedulers(client) {
  startBirthdayChecker(client);
  startEventChecker(client);
  startBirthdayRoleRemover(client);
  startBoosterRoleRemover(client);
  startGiveawayChecker(client);
  startReminderChecker(client);
  startBotEconomyCleanup(client);

  // Cleanup orphaned temp channels on startup
  cleanupTempChannels(client);
}
