import mongoose from 'mongoose';

const tempVoiceSchema = new mongoose.Schema({
  guildId: {
    type: String,
    required: true
  },
  channelId: {
    type: String,
    required: true,
    unique: true
  },
  ownerId: {
    type: String,
    required: true
  },
  createdFromId: {
    type: String, // The "Join to Create" channel ID
    required: true
  },
  name: String,
  userLimit: Number,
  locked: {
    type: Boolean,
    default: false
  },
  // Set from the interface's Status button; without this path strict mode dropped it
  customStatus: {
    type: String,
    default: null
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

// Index for quick lookups
tempVoiceSchema.index({ guildId: 1 });
tempVoiceSchema.index({ ownerId: 1, guildId: 1 });

// Static method to find by channel
tempVoiceSchema.statics.findByChannel = async function (channelId) {
  return await this.findOne({ channelId });
};

// Static method to find user's temp channel
tempVoiceSchema.statics.findUserChannel = async function (guildId, userId) {
  return await this.findOne({ guildId, ownerId: userId });
};

// Static method to get all temp channels in guild
tempVoiceSchema.statics.getGuildChannels = async function (guildId) {
  return await this.find({ guildId });
};

export default mongoose.model('TempVoice', tempVoiceSchema);
