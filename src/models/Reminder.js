import mongoose from 'mongoose';

const reminderSchema = new mongoose.Schema({
  guildId: {
    type: String,
    required: true
  },
  channelId: {
    type: String,
    required: true
  },
  userId: {
    type: String,
    required: true
  },
  message: {
    type: String,
    required: true
  },
  remindAt: {
    type: Date,
    required: true
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  completed: {
    type: Boolean,
    default: false
  }
});

// Index for finding due reminders
reminderSchema.index({ remindAt: 1, completed: 1 });
reminderSchema.index({ userId: 1, guildId: 1 });

// Static method to get due reminders
reminderSchema.statics.getDueReminders = async function () {
  return await this.find({
    completed: false,
    remindAt: { $lte: new Date() }
  });
};

// Static method to get user reminders (pass guildId to limit them to one server)
reminderSchema.statics.getUserReminders = async function (userId, guildId = null) {
  const query = { userId, completed: false };
  if (guildId) query.guildId = guildId;
  return await this.find(query).sort({ remindAt: 1 });
};

// Static method to delete one pending reminder, only if it belongs to this user in this server
reminderSchema.statics.deleteUserReminder = async function (userId, guildId, reminderId) {
  if (!mongoose.isObjectIdOrHexString(reminderId)) return null;
  return await this.findOneAndDelete({ _id: reminderId, userId, guildId, completed: false });
};

// Static method to atomically claim a due reminder for delivery.
// Returns null if it was already claimed, so overlapping checks never deliver it twice.
reminderSchema.statics.claimReminder = async function (reminderId) {
  return await this.findOneAndUpdate(
    { _id: reminderId, completed: false },
    { $set: { completed: true } },
    { new: true }
  );
};

// Static method to create reminder
reminderSchema.statics.createReminder = async function (data) {
  return await this.create(data);
};

// Method to mark as completed
reminderSchema.methods.complete = async function () {
  this.completed = true;
  await this.save();
};

export default mongoose.model('Reminder', reminderSchema);
