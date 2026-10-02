import mongoose from 'mongoose';

const confessionSchema = new mongoose.Schema({
  guildId: {
    type: String,
    required: true,
    unique: true
  },
  channelId: {
    type: String,
    default: null
  },
  panelMessageId: {
    type: String,
    default: null
  },
  enabled: {
    type: Boolean,
    default: false
  },
  confessionCount: {
    type: Number,
    default: 0
  },
  confessions: [{
    number: Number,
    content: String,
    messageId: String,
    threadId: String, // Thread for replies
    lastReplyMessageId: String, // Last reply message in thread (to remove its button)
    replyTo: Number, // If this is a reply, the confession number it's replying to
    userId: String, // Encrypted or hashed for admin use only
    timestamp: {
      type: Date,
      default: Date.now
    }
  }],
  settings: {
    allowReplies: {
      type: Boolean,
      default: true
    },
    anonymousReplies: {
      type: Boolean,
      default: false
    },
    requireApproval: {
      type: Boolean,
      default: false
    },
    cooldown: {
      type: Number,
      default: 60 // seconds
    },
    minLength: {
      type: Number,
      default: 10
    },
    maxLength: {
      type: Number,
      default: 2000
    },
    bannedUsers: [{
      type: String
    }],
    blockedWords: [{
      type: String
    }]
  },
  pendingConfessions: [{
    content: String,
    userId: String,
    timestamp: {
      type: Date,
      default: Date.now
    }
  }],
  userCooldowns: {
    type: Map,
    of: Date,
    default: new Map()
  }
});

// guildId is already indexed by its `unique` option; a second index declaration only triggers a duplicate-index warning

const Confession = mongoose.model('Confession', confessionSchema);

export default Confession;
