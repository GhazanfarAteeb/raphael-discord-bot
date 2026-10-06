import mongoose from 'mongoose';

// Stored copies of background images. Profile and level cards are drawn from these
// rather than from the original link, which can expire (Discord attachment links
// stop working after about a day), disappear, or be unreachable from the bot's network.
const backgroundImageSchema = new mongoose.Schema({
  guildId: {
    type: String,
    required: true
  },
  // The shop item's id, or 'fallback' for the server's default background image
  key: {
    type: String,
    required: true
  },
  // The link the copy was made from. A copy only stands in for this exact link, so
  // editing a background's image never shows the old picture.
  sourceUrl: {
    type: String,
    required: true
  },
  // JPEG, re-encoded and scaled down to card size (see utils/backgroundImages.js)
  data: {
    type: Buffer,
    required: true
  },
  width: Number,
  height: Number
}, {
  timestamps: true
});

backgroundImageSchema.index({ guildId: 1, key: 1 }, { unique: true });

export default mongoose.model('BackgroundImage', backgroundImageSchema);
