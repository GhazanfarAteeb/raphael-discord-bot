/**
 * Music Track End Event Handler
 * Cleans up messages when a track ends
 */

import Event from '../../structures/Event.js';
import { clearNowPlaying } from '../../music/RiffyManager.js';

class MusicTrackEnd extends Event {
    constructor(client, file) {
        super(client, file, {
            name: 'musicTrackEnd'
        });
    }

    // reason: moonlink TrackEndReason ("finished", "loadFailed", "stopped", "cleanup")
    async run(player, track, reason) {
        try {
            // clearNowPlaying detaches the message before the delete is awaited, so the
            // next track's card stored meanwhile by trackStart is left untouched.
            await clearNowPlaying(player);
        } catch (error) {
            this.client.logger.error(`Error in musicTrackEnd event (reason: ${reason}):`, error);
        }
    }
}

export default MusicTrackEnd;
