import { Events } from 'discord.js';
import { handleInactivePollButton } from '../../commands/utility/poll.js';

// Poll votes live in memory, so after a restart a poll's collector is gone and its buttons
// would fail with "This interaction failed". This answers those clicks and disables the
// stale buttons; clicks on active polls are left to the poll's own collector.
export default {
  name: Events.InteractionCreate,
  async execute(interaction) {
    await handleInactivePollButton(interaction);
  }
};
