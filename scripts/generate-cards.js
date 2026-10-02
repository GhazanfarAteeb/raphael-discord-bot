/**
 * Generates the blackjack card emojis in assets/cards/:
 *   - 52 animated GIF faces ({value}_{suit}.gif) that flip over from the card
 *     back to the face once, then stay face-up
 *   - card_back.png, the static back used for the dealer's hidden card
 * Upload them as application emojis in the Discord Developer Portal (your app >
 * Emojis). Discord names each emoji after its file, e.g. A_spades.gif ->
 * :A_spades:, and the blackjack command looks them up by name.
 *
 * Usage: npm run cards
 */

import { createCanvas, loadImage } from '@napi-rs/canvas';
import gifenc from 'gifenc';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import '../src/utils/fonts.js';

const { GIFEncoder, quantize, applyPalette } = gifenc; // CommonJS package

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BACK_ART = path.join(ROOT, 'assets', 'source', 'card_back_art.webp');
const OUT_DIR = path.join(ROOT, 'assets', 'cards');

// 5:7 poker-card ratio
const W = 200;
const H = 280;
const RADIUS = 14;
const MAX_EMOJI_BYTES = 256 * 1024; // Discord's emoji upload limit

// Flip timing (same as tsukubot): the back holds, squishes to nothing, the face
// expands back to full width, then holds. The GIF plays once; the final hold is
// long so the card still stays face-up for a minute if a client loops it anyway.
const FLIP_STEPS = 5;
const HOLD_MS = 200;
const FLIP_MS = 55;
const FINAL_HOLD_MS = 60_000;

const VALUES = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const SUITS = ['spades', 'hearts', 'diamonds', 'clubs'];
const SUIT_SYMBOL = { spades: '♠', hearts: '♥', diamonds: '♦', clubs: '♣' };
const SUIT_COLOR = { spades: '#16161d', clubs: '#16161d', hearts: '#c8102e', diamonds: '#c8102e' };
const GOLD = '#d4af37';
const FONT = 'Arial, sans-serif';

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// Gold outer edge and a thin inner hairline, shared by faces and the back
function drawFrame(ctx) {
  roundRect(ctx, 2, 2, W - 4, H - 4, RADIUS - 2);
  ctx.strokeStyle = GOLD;
  ctx.lineWidth = 4;
  ctx.stroke();

  roundRect(ctx, 9, 9, W - 18, H - 18, RADIUS - 6);
  ctx.strokeStyle = 'rgba(212, 175, 55, 0.55)';
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

// Emojis render at roughly 16x22px inside embeds, so the face is just a large
// value over a large suit: anything smaller (corner pips) is unreadable there
function drawFace(ctx, value, suit) {
  roundRect(ctx, 0, 0, W, H, RADIUS);
  ctx.fillStyle = '#fdfbf4';
  ctx.fill();
  drawFrame(ctx);

  ctx.fillStyle = SUIT_COLOR[suit];
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.font = `bold ${value === '10' ? 100 : 124}px ${FONT}`;
  ctx.fillText(value, W / 2, 128);
  ctx.font = `bold 118px ${FONT}`;
  ctx.fillText(SUIT_SYMBOL[suit], W / 2, 246);
}

function drawBack(ctx, art) {
  // Cover-crop the artwork to the card's portrait shape, centred
  const scale = Math.max(W / art.width, H / art.height);
  const sw = W / scale;
  const sh = H / scale;
  const sx = (art.width - sw) / 2;
  const sy = (art.height - sh) / 2;

  ctx.save();
  roundRect(ctx, 0, 0, W, H, RADIUS);
  ctx.clip();
  ctx.drawImage(art, sx, sy, sw, sh, 0, 0, W, H);
  ctx.restore();
  drawFrame(ctx);
}

// Renders one flip frame: the card squeezed horizontally around its centre
function renderFrame(draw, scaleX) {
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  ctx.translate(W / 2, 0);
  ctx.scale(scaleX, 1);
  ctx.translate(-W / 2, 0);
  draw(ctx);
  return ctx.getImageData(0, 0, W, H).data;
}

// Quantizes a frame to its own palette. Only opaque pixels are quantized, and
// one extra palette slot is reserved for transparency (GIF alpha is 1-bit).
function toGifFrame(rgba) {
  const opaque = [];
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] >= 128) opaque.push(rgba[i], rgba[i + 1], rgba[i + 2], 255);
  }
  const palette = quantize(new Uint8Array(opaque), 255);
  const index = applyPalette(rgba, palette);
  const transparentIndex = palette.length;
  palette.push([0, 0, 0]);
  for (let p = 0; p < index.length; p++) {
    if (rgba[p * 4 + 3] < 128) index[p] = transparentIndex;
  }
  return { index, palette, transparentIndex };
}

function writeFile(name, buffer) {
  if (buffer.length > MAX_EMOJI_BYTES) {
    throw new Error(`${name} is ${buffer.length} bytes, over Discord's 256 KiB emoji limit`);
  }
  writeFileSync(path.join(OUT_DIR, name), buffer);
  return buffer.length;
}

function saveFlipGif(name, backFrames, drawFaceFn) {
  const faceFrames = [];
  for (let i = 1; i <= FLIP_STEPS; i++) {
    const last = i === FLIP_STEPS;
    faceFrames.push({ ...toGifFrame(renderFrame(drawFaceFn, i / FLIP_STEPS)), delay: last ? FINAL_HOLD_MS : FLIP_MS });
  }

  const gif = GIFEncoder();
  for (const frame of [...backFrames, ...faceFrames]) {
    gif.writeFrame(frame.index, W, H, {
      palette: frame.palette,
      delay: frame.delay,
      transparent: true,
      transparentIndex: frame.transparentIndex,
      dispose: 2, // clear each frame, so a narrower frame doesn't show the wider one behind it
      repeat: -1, // play once
    });
  }
  gif.finish();
  return writeFile(name, Buffer.from(gif.bytes()));
}

rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });
const art = await loadImage(BACK_ART);
const drawBackFn = (ctx) => drawBack(ctx, art);

// Static back for the dealer's hidden card
const backCanvas = createCanvas(W, H);
drawBackFn(backCanvas.getContext('2d'));
let largest = writeFile('card_back.png', backCanvas.toBuffer('image/png'));

// The back half of the flip is the same for every card, so build it once:
// a full-width hold, then the back squishing down to nothing
const backFrames = [{ ...toGifFrame(renderFrame(drawBackFn, 1)), delay: HOLD_MS * 2 }];
for (let i = FLIP_STEPS - 1; i >= 1; i--) {
  backFrames.push({ ...toGifFrame(renderFrame(drawBackFn, i / FLIP_STEPS)), delay: FLIP_MS });
}

for (const suit of SUITS) {
  for (const value of VALUES) {
    const size = saveFlipGif(`${value}_${suit}.gif`, backFrames, (ctx) => drawFace(ctx, value, suit));
    largest = Math.max(largest, size);
  }
}

console.log(`Wrote 52 flip GIFs + card_back.png to ${path.relative(ROOT, OUT_DIR)}/ (largest ${Math.round(largest / 1024)} KiB)`);
