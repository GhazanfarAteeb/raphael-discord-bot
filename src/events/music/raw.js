/**
 * Raw Event Handler for Riffy
 * Required to update voice state for Lavalink
 */

import Event from "../../structures/Event.js";
import { GatewayDispatchEvents } from "discord.js";

class RawEvent extends Event {
  constructor(client, file) {
    super(client, file, {
      name: "raw",
    });
  }

  async run(data) {
    // Only handle voice state and voice server updates
  }
}

export default RawEvent;
