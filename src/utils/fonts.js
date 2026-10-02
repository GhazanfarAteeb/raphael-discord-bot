/**
 * Canvas font setup. Import for its side effect anywhere text is drawn.
 *
 * The Docker image (Alpine) has no Arial, and @napi-rs/canvas falls back to the
 * first family it knows when a name is missing (Liberation Serif), so
 * "Arial"/"sans-serif" text came out serif, or blank with no fonts installed.
 * Map those names to Liberation Sans, which is metric-compatible with Arial.
 * Outside Docker these files don't exist and system fonts are used as before.
 */

import { existsSync } from 'fs';
import { GlobalFonts } from '@napi-rs/canvas';

const LIBERATION_DIR = '/usr/share/fonts/liberation';

function register(path, family) {
  if (existsSync(path)) GlobalFonts.registerFromPath(path, family);
}

// Custom fonts, used when present in the repo
register('./assets/fonts/Poppins-Bold.ttf', 'Poppins Bold');
register('./assets/fonts/Poppins-Regular.ttf', 'Poppins');

for (const family of ['Arial', 'sans-serif']) {
  register(`${LIBERATION_DIR}/LiberationSans-Regular.ttf`, family);
  register(`${LIBERATION_DIR}/LiberationSans-Bold.ttf`, family);
}
