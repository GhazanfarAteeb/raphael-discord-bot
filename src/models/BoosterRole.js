import mongoose from 'mongoose';

// Retry delays for a removal that failed (missing permissions, role above the bot, API errors):
// 5 minutes, doubling up to 6 hours, until it succeeds or the role or member is gone
const RETRY_BASE_MS = 5 * 60 * 1000;
const RETRY_MAX_MS = 6 * 60 * 60 * 1000;

const boosterRoleSchema = new mongoose.Schema({
  guildId: {
    type: String,
    required: true,
    index: true
  },
  userId: {
    type: String,
    required: true
  },
  roleId: {
    type: String,
    required: true
  },
  assignedAt: {
    type: Date,
    default: Date.now,
    required: true
  },
  expiresAt: {
    type: Date,
    required: true
  },
  assignedBy: {
    type: String,
    required: false
  },
  reason: {
    type: String,
    default: null
  },
  // Failed removal attempts after expiry, and when to try again
  removalAttempts: {
    type: Number,
    default: 0
  },
  nextAttemptAt: {
    type: Date,
    default: null
  },
  lastError: {
    type: String,
    default: null
  }
}, {
  timestamps: true
});

// One record per member and role: giving the role again renews it
boosterRoleSchema.index({ guildId: 1, userId: 1, roleId: 1 }, { unique: true });
boosterRoleSchema.index({ expiresAt: 1 });

// Expired records that are due for a removal attempt, oldest first
boosterRoleSchema.statics.getExpiredRoles = async function(limit = 100) {
  const now = new Date();
  return this.find({
    expiresAt: { $lte: now },
    $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: now } }]
  })
    .sort({ expiresAt: 1 })
    .limit(limit)
    .lean();
};

// Static method to add a booster role entry
boosterRoleSchema.statics.addBoosterRole = async function(guildId, userId, roleId, duration, assignedBy = null, reason = null) {
  const expiresAt = new Date(Date.now() + duration);

  // Upsert - update if exists, create if not
  return this.findOneAndUpdate(
    { guildId, userId, roleId },
    {
      $set: {
        assignedAt: new Date(),
        expiresAt,
        assignedBy,
        reason,
        removalAttempts: 0,
        nextAttemptAt: null,
        lastError: null
      }
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
};

// Static method to remove a booster role entry
boosterRoleSchema.statics.removeBoosterRole = async function(guildId, userId, roleId = null) {
  const query = { guildId, userId };
  if (roleId) query.roleId = roleId;
  return this.deleteMany(query);
};

// Whether an expired record is still expired: false once it was renewed or removed
boosterRoleSchema.statics.isStillExpired = async function(entry) {
  return Boolean(await this.exists({ _id: entry._id, expiresAt: { $lte: new Date() } }));
};

// Delete an expired record, unless it was renewed in the meantime
boosterRoleSchema.statics.deleteIfExpired = async function(entry) {
  return this.deleteMany({
    guildId: entry.guildId,
    userId: entry.userId,
    roleId: entry.roleId,
    expiresAt: { $lte: new Date() }
  });
};

// Schedule another removal attempt after a failure
boosterRoleSchema.statics.markRemovalFailed = async function(entry, error) {
  const attempts = (entry.removalAttempts || 0) + 1;
  const delay = Math.min(RETRY_BASE_MS * 2 ** (attempts - 1), RETRY_MAX_MS);
  return this.updateOne(
    { _id: entry._id, expiresAt: { $lte: new Date() } },
    {
      $set: {
        removalAttempts: attempts,
        nextAttemptAt: new Date(Date.now() + delay),
        lastError: String(error?.message || error || 'Unknown error').slice(0, 300)
      }
    }
  );
};

// Static method to get all active booster roles for a guild
boosterRoleSchema.statics.getGuildBoosterRoles = async function(guildId) {
  return this.find({
    guildId,
    expiresAt: { $gt: new Date() }
  });
};

// Every record for a guild, soonest expiry first (expired ones are awaiting removal)
boosterRoleSchema.statics.getGuildEntries = async function(guildId) {
  return this.find({ guildId }).sort({ expiresAt: 1 }).lean();
};

// Static method to get booster role info for a user
boosterRoleSchema.statics.getUserBoosterRole = async function(guildId, userId) {
  return this.findOne({
    guildId,
    userId,
    expiresAt: { $gt: new Date() }
  });
};

// Boost tier reward roles the bot added when a member boosted. Discord often no longer tells us
// that a member was boosting (uncached members arrive as partials), so these records are what
// lets the reward be taken back once the member is no longer boosting.
const boostTierGrantSchema = new mongoose.Schema({
  guildId: { type: String, required: true },
  userId: { type: String, required: true },
  roleId: { type: String, required: true }
}, {
  timestamps: true
});

boostTierGrantSchema.index({ guildId: 1, userId: 1, roleId: 1 }, { unique: true });

export const BoostTierGrant = mongoose.model('BoostTierGrant', boostTierGrantSchema);

export default mongoose.model('BoosterRole', boosterRoleSchema);
