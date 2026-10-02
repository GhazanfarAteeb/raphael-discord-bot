/**
 * Music Presentation Helpers
 * Shared formatting for the music commands and events: durations (live streams
 * included), playback position, progress bars, track links and the now-playing
 * control buttons.
 */

import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";

const HTTP_URL = /^https?:\/\//i;
const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3600;

// A playerUpdate older than this is treated as stale and not extrapolated from
const MAX_POSITION_EXTRAPOLATION_MS = 10000;

export const DISCORD_LIMITS = {
  TITLE: 256,
  DESCRIPTION: 4096,
  FIELD_VALUE: 1024,
  AUTHOR_NAME: 256,
};

const LOOP_LABELS = {
  off: "Loop: Off",
  track: "Loop: Track",
  queue: "Loop: Queue",
};

/**
 * Milliseconds to "m:ss" or "h:mm:ss". Missing, negative or invalid values read "0:00".
 */
export function formatDuration(ms) {
  const totalSeconds = Math.floor(Number(ms) / MS_PER_SECOND);
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return "0:00";

  const hours = Math.floor(totalSeconds / SECONDS_PER_HOUR);
  const minutes = Math.floor((totalSeconds % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE);
  const seconds = String(totalSeconds % SECONDS_PER_MINUTE).padStart(2, "0");

  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`
    : `${minutes}:${seconds}`;
}

/**
 * A track's length, or "Live" for streams (their reported duration is meaningless).
 */
export function formatTrackDuration(track) {
  return track?.isStream ? "Live" : formatDuration(track?.duration);
}

/**
 * Total length of a list of tracks. Streams have no length, so they are counted separately.
 */
export function formatQueueDuration(tracks) {
  let total = 0;
  let streams = 0;
  for (const track of tracks ?? []) {
    if (track?.isStream) streams++;
    else total += Number(track?.duration) || 0;
  }
  const base = formatDuration(total);
  return streams > 0 ? `${base} + ${streams} live` : base;
}

/**
 * Current playback position in ms. moonlink stores the position on player.current
 * (updated by the node's playerUpdate); between updates it is extrapolated from the
 * update timestamp while the track is actually playing.
 */
export function currentPosition(player) {
  const track = player?.current;
  if (!track) return 0;

  let position = Number(track.position) || 0;
  if (player.playing && !player.paused && !track.isStream && track.time > 0) {
    const elapsed = Date.now() - track.time;
    if (elapsed > 0 && elapsed <= MAX_POSITION_EXTRAPOLATION_MS) position += elapsed;
  }

  const duration = Number(track.duration) || 0;
  return duration > 0 ? Math.min(position, duration) : position;
}

/**
 * Text progress bar with a ◉ knob. Streams (no duration) get a static LIVE bar.
 */
export function progressBar(position, duration, length = 15) {
  if (!duration || duration <= 0) return `${"▬".repeat(length)} LIVE`;

  const ratio = Math.min(Math.max(position / duration, 0), 1);
  const knob = Math.min(Math.round(ratio * (length - 1)), length - 1);
  return `${"▬".repeat(knob)}◉${"▬".repeat(length - 1 - knob)}`;
}

/**
 * Shortens text to at most `max` characters, marking the cut with "...".
 */
export function truncate(text, max) {
  const value = String(text ?? "");
  return value.length > max ? `${value.slice(0, Math.max(0, max - 3))}...` : value;
}

/**
 * The URL when it is an http(s) link (embeds reject anything else), otherwise null.
 */
export function safeUrl(url) {
  return typeof url === "string" && HTTP_URL.test(url) ? url : null;
}

/**
 * "[Title](uri)" for use in descriptions/fields, falling back to the plain title
 * when the track has no web link. Brackets in the title are escaped so they cannot
 * break the masked link.
 */
export function trackLink(track, maxTitle = 60) {
  const title = truncate(track?.title || "Unknown Track", maxTitle).replace(/([[\]])/g, "\\$1");
  const url = safeUrl(track?.uri);
  return url ? `[${title}](${url})` : title;
}

/**
 * Now-playing control buttons reflecting the player's current pause and loop state.
 * Custom IDs are handled by src/events/music/buttonHandler.js.
 */
export function buildControlRow(player, { disabled = false } = {}) {
  const paused = Boolean(player?.paused);
  const loop = LOOP_LABELS[player?.loop] ? player.loop : "off";

  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("music_disconnect")
      .setLabel("Stop")
      .setStyle(ButtonStyle.Danger)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(paused ? "music_play" : "music_pause")
      .setLabel(paused ? "Resume" : "Pause")
      .setStyle(paused ? ButtonStyle.Success : ButtonStyle.Secondary)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId("music_skip")
      .setLabel("Skip")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId("music_shuffle")
      .setLabel("Shuffle")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId("music_loop")
      .setLabel(LOOP_LABELS[loop])
      .setStyle(loop === "off" ? ButtonStyle.Secondary : ButtonStyle.Primary)
      .setDisabled(disabled),
  );
}
