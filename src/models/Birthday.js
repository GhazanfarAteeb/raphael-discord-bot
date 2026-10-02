import mongoose from 'mongoose';

const DAY_MS = 24 * 60 * 60 * 1000;

// Midnight at the start of the given day (local time)
function startOfDay(date = new Date()) {
    const start = new Date(date);
    start.setHours(0, 0, 0, 0);
    return start;
}

/**
 * Next date (today included) on which a month/day birthday falls, and how many days away it is.
 * Compares against today's midnight so a birthday happening today counts as today, not next year.
 */
export function nextBirthdayOccurrence(month, day, from = new Date()) {
    const today = startOfDay(from);
    const date = new Date(today.getFullYear(), month - 1, day);
    if (date < today) date.setFullYear(today.getFullYear() + 1);
    // Rounded so a daylight-saving shift between the two dates does not lose a day
    const daysUntil = Math.round((date - today) / DAY_MS);
    return { date, daysUntil };
}

// Counter schema for ticket numbers
const birthdayTicketCounterSchema = new mongoose.Schema({
    guildId: { type: String, required: true, unique: true },
    count: { type: Number, default: 0 }
});

export const BirthdayTicketCounter = mongoose.model('BirthdayTicketCounter', birthdayTicketCounterSchema);

// Birthday request schema for pending birthday change requests (ticket system)
const birthdayRequestSchema = new mongoose.Schema({
    ticketNumber: {
        type: Number,
        required: true
    },
    requestId: {
        type: String,
        required: true,
        unique: true
    },
    userId: {
        type: String,
        required: true
    },
    guildId: {
        type: String,
        required: true
    },
    requestedBirthday: {
        month: { type: Number, required: true, min: 1, max: 12 },
        day: { type: Number, required: true, min: 1, max: 31 },
        year: Number
    },
    currentBirthday: {
        month: Number,
        day: Number,
        year: Number
    },
    reason: String,
    status: {
        type: String,
        enum: ['open', 'approved', 'rejected', 'cancelled'],
        default: 'open'
    },
    priority: {
        type: String,
        enum: ['low', 'normal', 'high'],
        default: 'normal'
    },
    // Ticket message tracking
    ticketMessageId: String,
    ticketChannelId: String,
    // Review info
    reviewedBy: String,
    reviewedAt: Date,
    rejectionReason: String,
    // Notes from staff
    staffNotes: [{
        staffId: String,
        note: String,
        createdAt: { type: Date, default: Date.now }
    }]
}, {
    timestamps: true
});

birthdayRequestSchema.index({ guildId: 1, status: 1 });
birthdayRequestSchema.index({ guildId: 1, ticketNumber: 1 }, { unique: true });
birthdayRequestSchema.index({ userId: 1, guildId: 1 });

// Static method to get next ticket number
birthdayRequestSchema.statics.getNextTicketNumber = async function(guildId) {
    const counter = await BirthdayTicketCounter.findOneAndUpdate(
        { guildId },
        { $inc: { count: 1 } },
        { upsert: true, new: true }
    );
    return counter.count;
};

// Format ticket number as #0001
birthdayRequestSchema.methods.getFormattedTicketNumber = function() {
    return `#${String(this.ticketNumber).padStart(4, '0')}`;
};

export const BirthdayRequest = mongoose.model('BirthdayRequest', birthdayRequestSchema);

const birthdaySchema = new mongoose.Schema({
    userId: {
        type: String,
        required: true
    },
    guildId: {
        type: String,
        required: true
    },
    username: String,
    
    // Birthday information
    birthday: {
        month: { type: Number, required: true, min: 1, max: 12 },
        day: { type: Number, required: true, min: 1, max: 31 },
        year: Number // Optional - for age calculation
    },
    
    // Source tracking - where did this birthday come from
    source: {
        type: String,
        enum: ['self', 'staff', 'request'],
        default: 'self'
    },
    setBy: String, // User ID of who set the birthday (staff member or self)
    
    // Display preferences
    displayBirthday: {
        type: Boolean,
        default: true
    },
    showAge: {
        type: Boolean,
        default: false
    },
    customMessage: String, // Custom birthday message
    
    // Privacy settings
    isActualBirthday: {
        type: Boolean,
        default: true // User can mark if it's their real birthday
    },
    publiclyVisible: {
        type: Boolean,
        default: true
    },
    
    // Verification status
    verified: {
        type: Boolean,
        default: false // Set to true when staff verifies the birthday
    },
    verifiedBy: String,
    verifiedAt: Date,
    
    // Notifications
    lastCelebrated: Date,
    notificationSent: {
        type: Boolean,
        default: false
    },
    
    // Custom celebration settings
    celebrationPreference: {
        type: String,
        enum: ['public', 'dm', 'role', 'none'],
        default: 'public'
    }
}, {
    timestamps: true
});

// Compound index
birthdaySchema.index({ userId: 1, guildId: 1 }, { unique: true });

// Method to check if birthday is today
birthdaySchema.methods.isBirthdayToday = function() {
    const today = new Date();
    return this.birthday.month === today.getMonth() + 1 && 
           this.birthday.day === today.getDate();
};

// Method to calculate age
birthdaySchema.methods.getAge = function() {
    if (!this.birthday.year) return null;
    
    const today = new Date();
    let age = today.getFullYear() - this.birthday.year;
    
    // Adjust if birthday hasn't occurred this year yet
    if (today.getMonth() + 1 < this.birthday.month || 
        (today.getMonth() + 1 === this.birthday.month && today.getDate() < this.birthday.day)) {
        age--;
    }
    
    return age;
};

// Static method to get today's birthdays
birthdaySchema.statics.getTodaysBirthdays = async function(guildId) {
    const today = new Date();
    const month = today.getMonth() + 1;
    const day = today.getDate();
    
    return await this.find({
        guildId,
        displayBirthday: true,
        'birthday.month': month,
        'birthday.day': day
    });
};

// Static method to get upcoming birthdays (today through the next `days` days)
birthdaySchema.statics.getUpcomingBirthdays = async function(guildId, days = 7) {
    const birthdays = await this.find({ guildId, displayBirthday: true });
    const upcoming = [];
    
    for (const birthday of birthdays) {
        const { date, daysUntil } = nextBirthdayOccurrence(birthday.birthday.month, birthday.birthday.day);
        
        if (daysUntil <= days) {
            upcoming.push({
                birthday,
                daysUntil,
                date
            });
        }
    }
    
    return upcoming.sort((a, b) => a.daysUntil - b.daysUntil);
};

export default mongoose.model('Birthday', birthdaySchema);
