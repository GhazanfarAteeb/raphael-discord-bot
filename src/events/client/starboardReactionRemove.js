import { Events } from 'discord.js';
import { handleReactionRemove } from './starboardHandler.js';

// Keeps starboard posts in step when a star is removed (updates the count, or removes
// the post once it drops below the threshold)
export default {
  name: Events.MessageReactionRemove,
  async execute(reaction, user) {
    await handleReactionRemove(reaction, user);
  }
};
