/**
 * Background images for profile and level cards.
 *
 * Backgrounds are added as links, but cards are drawn from a stored copy of the image
 * (models/BackgroundImage.js): links can expire (Discord attachment links stop working
 * after about a day), be deleted, or be unreachable from the bot's network while
 * Discord itself still shows them in embeds. A copy is saved when a background is
 * added or edited, the first time a card loads it, and whenever the bot shows it in an
 * embed. The last of these downloads through Discord's image proxy, which works even
 * when the original host doesn't answer the bot.
 */

import { createCanvas, loadImage } from '@napi-rs/canvas';
import BackgroundImage from '../models/BackgroundImage.js';
import { getBackground } from './shopItems.js';
import logger from './logger.js';

const DOWNLOAD_TIMEOUT = 10_000;
const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;
// Cards are 900 px wide: a little headroom keeps copies sharp without storing originals
const MAX_STORED_WIDTH = 1280;
const JPEG_QUALITY = 90;

// Stored-copy key for the server's default background (shop items use their own id)
export const FALLBACK_KEY = 'fallback';

// Card color when the server hasn't set one (manageshop fallback color)
export const DEFAULT_CARD_COLOR = '#2C2F33';

// Told to an admin whose background image couldn't be saved
export const IMAGE_NOT_SAVED =
  'Raphael could not download this image, so it may not appear on profile and level cards. ' +
  'Check that the link opens the image itself, or upload the image to Discord and use that link.';

// Links already reported as unloadable, so a broken background is logged once, not per card
const reportedFailures = new Set();

async function download(url) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT),
    // Some image hosts refuse requests without a user agent
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; RaphaelBot/2.0)' }
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  if (Number(response.headers.get('content-length')) > MAX_DOWNLOAD_BYTES) throw new Error('image is over 20 MB');
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_DOWNLOAD_BYTES) throw new Error('image is over 20 MB');
  return buffer;
}

// Decodes the download (rejecting anything that isn't an image) and saves it as a JPEG
// no wider than MAX_STORED_WIDTH
async function storeCopy(guildId, key, sourceUrl, buffer) {
  const image = await loadImage(buffer);
  const scale = Math.min(1, MAX_STORED_WIDTH / image.width);
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = DEFAULT_CARD_COLOR; // JPEG has no transparency: transparent areas get the default card color
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(image, 0, 0, width, height);
  const data = await canvas.encode('jpeg', JPEG_QUALITY);

  await BackgroundImage.updateOne(
    { guildId, key },
    { $set: { sourceUrl, data, width, height } },
    { upsert: true }
  );
  return image;
}

function reportFailure(guildId, key, url, error) {
  if (reportedFailures.has(url)) return;
  reportedFailures.add(url);
  logger.warn(`[Backgrounds] ${key} in guild ${guildId} could not be loaded (${error.message}); cards use the fallback color: ${url}`);
}

/**
 * Saves a copy of a background image. `proxyUrl` is Discord's copy of the image from
 * an embed the bot posted (embed.image.proxyURL): tried first, as it loads even when
 * the original host doesn't answer the bot, then the link itself.
 * Resolves to true when a copy was saved.
 */
export async function saveBackgroundImage(guildId, key, sourceUrl, proxyUrl) {
  if (!sourceUrl) return false;
  let lastError;
  for (const url of [proxyUrl, sourceUrl]) {
    if (!url) continue;
    try {
      await storeCopy(guildId, key, sourceUrl, await download(url));
      reportedFailures.delete(sourceUrl);
      return true;
    } catch (error) {
      lastError = error;
    }
  }
  reportFailure(guildId, key, sourceUrl, lastError);
  return false;
}

// The embed image showing `sourceUrl` in a message (or its only embed image)
function embedImage(message, sourceUrl) {
  const embeds = message?.embeds ?? [];
  return (embeds.find((embed) => embed.image?.url === sourceUrl) ?? embeds.find((embed) => embed.image))?.image;
}

/**
 * Saves a copy of a background shown in a message the bot sent, using Discord's proxied
 * copy from the message's embed. Re-reads the message once if its embed has no proxy
 * link yet (or the reply was an interaction response). Resolves to true when saved.
 */
export async function saveBackgroundFromMessage(message, guildId, key, sourceUrl) {
  let image = embedImage(message, sourceUrl);
  if (!image?.proxyURL && typeof message?.fetch === 'function') {
    image = embedImage(await message.fetch(true).catch(() => null), sourceUrl) ?? image;
  }
  return saveBackgroundImage(guildId, key, sourceUrl, image?.proxyURL);
}

/**
 * After the bot shows a background in a message, saves a copy if there isn't one for
 * this link yet. This is how backgrounds added before copies existed, or hosted where
 * the bot can't reach, get one. Runs in the background and never throws.
 */
export function rememberBackgroundFromMessage(message, guildId, key, sourceUrl) {
  if (!message || !sourceUrl) return;
  (async () => {
    if (await BackgroundImage.exists({ guildId, key, sourceUrl })) return;
    await saveBackgroundFromMessage(message, guildId, key, sourceUrl);
  })().catch(() => {});
}

/** Drops a stored copy, e.g. when its background is removed from the shop. */
export async function deleteBackgroundImage(guildId, key) {
  await BackgroundImage.deleteOne({ guildId, key });
}

/**
 * Which background a member's cards show: their active background (built in, or one of
 * the server's custom shop items), else the server's fallback image.
 * Resolves to { key, url }, or null when there is no image (the cards draw the fallback color).
 */
export function getCardBackground(guildConfig, backgroundId) {
  const id = backgroundId || 'default';
  const builtIn = getBackground(id);
  if (builtIn?.image) return { key: `builtin_${id}`, url: builtIn.image };

  const custom = (guildConfig.customShopItems || []).find((item) => item.type === 'background' && item.id === id);
  if (custom?.image) return { key: custom.id, url: custom.image };

  const fallback = guildConfig.economy?.fallbackBackground?.image;
  return fallback ? { key: FALLBACK_KEY, url: fallback } : null;
}

// `hex` with each channel scaled by `factor`
function shade(hex, factor) {
  const value = parseInt(hex.slice(1), 16);
  const channel = (shift) => Math.round(((value >> shift) & 0xff) * factor);
  return `rgb(${channel(16)}, ${channel(8)}, ${channel(0)})`;
}

/**
 * Fills a card with the server's fallback color (manageshop fallback color), shaded from
 * the color at the top left to a slightly darker tone at the bottom right. Drawn when a
 * card has no background image, or its image can't be loaded.
 */
export function fillCardColor(ctx, width, height, guildConfig) {
  const configured = guildConfig.economy?.fallbackBackground?.color;
  const color = /^#[0-9a-f]{6}$/i.test(configured ?? '') ? configured : DEFAULT_CARD_COLOR;
  const gradient = ctx.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, color);
  gradient.addColorStop(1, shade(color, 0.8));
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);
}

/**
 * The image to draw for a card background ({ key, url } from getCardBackground): the
 * stored copy made from this link, else the link itself (saving a copy for next time).
 * Resolves to null when neither loads, and the card draws the fallback color.
 */
export async function loadCardBackground(guildId, background) {
  if (!background) return null;
  const { key, url } = background;

  try {
    const stored = await BackgroundImage.findOne({ guildId, key, sourceUrl: url }, { data: 1 });
    if (stored?.data) return await loadImage(stored.data);
  } catch (error) {
    logger.warn(`[Backgrounds] Stored copy of ${key} in guild ${guildId} could not be read: ${error.message}`);
  }

  try {
    const buffer = await download(url);
    const image = await loadImage(buffer);
    storeCopy(guildId, key, url, buffer).catch(() => {});
    return image;
  } catch (error) {
    reportFailure(guildId, key, url, error);
    return null;
  }
}
