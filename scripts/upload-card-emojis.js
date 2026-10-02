/**
 * Uploads the generated card emojis in assets/cards/ as application emojis,
 * replacing any existing emoji with the same name (Discord can't update an
 * emoji's image, so a replacement is delete + create). Other emojis are left
 * alone. Uses DISCORD_TOKEN from .env.
 *
 * Usage: npm run cards:upload            (replace all card emojis)
 *        npm run cards:upload -- --missing (only create ones that don't exist)
 */

import 'dotenv/config';
import { REST, Routes } from 'discord.js';
import { readdirSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const CARDS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'cards');
const MIME = { '.gif': 'image/gif', '.png': 'image/png' };
const missingOnly = process.argv.includes('--missing');

const rest = new REST().setToken(process.env.DISCORD_TOKEN);
const app = await rest.get(Routes.currentApplication());
const { items: existing } = await rest.get(Routes.applicationEmojis(app.id));
const byName = new Map(existing.map((emoji) => [emoji.name, emoji]));

const files = readdirSync(CARDS_DIR).filter((file) => MIME[path.extname(file)]);
let replaced = 0;
let created = 0;

for (const file of files) {
  const name = path.basename(file, path.extname(file));
  const image = `data:${MIME[path.extname(file)]};base64,${readFileSync(path.join(CARDS_DIR, file)).toString('base64')}`;

  const old = byName.get(name);
  if (old && missingOnly) continue;
  if (old) {
    try {
      await rest.delete(Routes.applicationEmoji(app.id, old.id));
    } catch (error) {
      // Already gone (deleted elsewhere, or a retried request): nothing to delete
      if (error.status !== 404) throw error;
    }
    replaced++;
  } else {
    created++;
  }
  await rest.post(Routes.applicationEmojis(app.id), { body: { name, image } });
  console.log(`${old ? 'replaced' : 'created '} :${name}:`);
}

console.log(`Done for ${app.name}: ${replaced} replaced, ${created} created`);
