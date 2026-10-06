import { Events, ActivityType } from 'discord.js';
import Guild from '../../models/Guild.js';

export default {
  name: Events.ClientReady,
  once: true,
  async execute(client) {
    console.log(`[RAPHAEL] System online. Logged in as ${client.user.tag}`);
    console.log(`[RAPHAEL] Serving ${client.guilds.cache.size} servers`);
    console.log(`[RAPHAEL] Monitoring ${client.guilds.cache.reduce((a, g) => a + g.memberCount, 0)} users`);

    // Set bot presence
    client.user.setPresence({
      activities: [{
        name: `Analyzing... | ${process.env.DEFAULT_PREFIX || '!'}help`,
        type: ActivityType.Watching
      }],
      status: 'online'
    });

    // Cache invites for all guilds (async, don't block)
    console.log('[RAPHAEL] Initializing invite cache...');
    Promise.all(
      Array.from(client.guilds.cache.values()).map(async guild => {
        try {
          const invites = await guild.invites.fetch();
          client.invites.set(guild.id, new Map(invites.map(invite => [invite.code, invite.uses])));
        } catch (error) {
          console.error(`[RAPHAEL] Failed to cache invites for ${guild.name}:`, error.message);
        }
      })
    ).then(() => console.log('[RAPHAEL] Invite cache complete.'));
  }
};
