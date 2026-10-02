import mongoose from 'mongoose';

const ticketSchema = new mongoose.Schema({
    guildId: {
        type: String,
        required: true
    },
    ticketNumber: {
        type: Number,
        required: true
    },
    channelId: String,
    
    // User info
    userId: {
        type: String,
        required: true
    },
    username: String,
    
    // Ticket details
    category: {
        type: String,
        default: 'general'
    },
    subject: String,
    status: {
        type: String,
        enum: ['open', 'claimed', 'closed', 'archived'],
        default: 'open'
    },
    priority: {
        type: String,
        enum: ['low', 'medium', 'high', 'urgent'],
        default: 'medium'
    },
    
    // Staff assignment
    claimedBy: String,
    claimedByTag: String,
    claimedAt: Date,
    
    // Participants
    participants: [String], // User IDs with access
    
    // Messages
    messages: [{
        authorId: String,
        authorTag: String,
        content: String,
        timestamp: { type: Date, default: Date.now },
        attachments: [String]
    }],
    
    // Closure info
    closedBy: String,
    closedByTag: String,
    closedAt: Date,
    closeReason: String,
    
    // Transcript
    transcriptUrl: String,
    
    // Ratings
    rating: {
        score: Number, // 1-5
        feedback: String,
        ratedAt: Date
    }
}, {
    timestamps: true
});

// Compound index
ticketSchema.index({ guildId: 1, ticketNumber: 1 }, { unique: true });
ticketSchema.index({ guildId: 1, status: 1 });

// Per-guild ticket number counter. A single $inc on one document is atomic, so concurrent
// ticket opens can never be handed the same number (reading max+1 raced on the unique index).
// seq deliberately has no schema default: an upsert would otherwise add $setOnInsert { seq }
// and conflict with the $max below.
const ticketCounterSchema = new mongoose.Schema({
    guildId: {
        type: String,
        required: true,
        unique: true
    },
    seq: Number
}, {
    versionKey: false
});

export const TicketCounter = mongoose.model('TicketCounter', ticketCounterSchema);

// Get next ticket number
ticketSchema.statics.getNextTicketNumber = async function(guildId) {
    // Keep the counter at or above the highest number already used. This seeds it for guilds
    // that had tickets before the counter existed, and $max can only raise it, never lower it.
    const lastTicket = await this.findOne({ guildId })
        .sort({ ticketNumber: -1 })
        .select('ticketNumber')
        .lean();
    const floor = lastTicket?.ticketNumber || 0;

    try {
        await TicketCounter.updateOne({ guildId }, { $max: { seq: floor } }, { upsert: true });
    } catch (error) {
        // Two first-ever tickets raced to insert the counter; the other insert won, so update it
        if (error?.code !== 11000) throw error;
        await TicketCounter.updateOne({ guildId }, { $max: { seq: floor } });
    }

    const counter = await TicketCounter.findOneAndUpdate(
        { guildId },
        { $inc: { seq: 1 } },
        { new: true, upsert: true }
    ).lean();

    return counter.seq;
};

// Add message to ticket
ticketSchema.methods.addMessage = function(authorId, authorTag, content, attachments = []) {
    this.messages.push({
        authorId,
        authorTag,
        content,
        attachments
    });
};

export default mongoose.model('Ticket', ticketSchema);
