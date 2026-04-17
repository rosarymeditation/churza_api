const mongoose = require('mongoose');

const churchSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Church name is required'],
      trim: true,
    },
    code: {
      type: String,
      required: true,
      unique: true,
      uppercase: true,
      trim: true,
      minlength: 6,
      maxlength: 6,
      index: true,
    },
    description: { type: String, trim: true },
    logoUrl: { type: String },
    coverImageUrl: { type: String },

    contact: {
      email: { type: String, lowercase: true, trim: true },
      phone: { type: String, trim: true },
      website: { type: String, trim: true },
    },

    address: {
      street: { type: String, trim: true },
      city: { type: String, trim: true },
      state: { type: String, trim: true },
      country: { type: String, trim: true, default: 'Nigeria' },
    },

    serviceSchedule: [
      {
        day: {
          type: String,
          enum: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
        },
        time: { type: String }, // e.g. "08:00"
        label: { type: String }, // e.g. "First Service"
      },
    ],

    subscription: {
      plan: {
        type: String,
        enum: ['starter', 'growth', 'parish'],
        default: 'starter',
      },
      status: {
        type: String,
        enum: ['trial', 'active', 'past_due', 'cancelled'],
        default: 'trial',
      },
      trialEndsAt: { type: Date },
      currentPeriodEnd: { type: Date },
      paymentReference: { type: String },
    },

    settings: {
      requireApproval: { type: Boolean, default: true },
      absenteeThreshold: { type: Number, default: 3 },
      currency: { type: String, default: 'NGN' },

      prayerWallPublic: { type: Boolean, default: true },

      stripeAccountId: { type: String },   // connected Stripe account ID
      paystackSubAccount: { type: String }, // Paystack sub-account code
      activeGateway: {
        type: String,
        enum: ['stripe', 'paystack', 'none'],
        default: 'none',
      },
      givingEnabled: { type: Boolean, default: false },
    },

    isActive: { type: Boolean, default: true },
    memberCount: { type: Number, default: 0 },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

churchSchema.virtual('isOnTrial').get(function () {
  return (
    this.subscription.status === 'trial' &&
    this.subscription.trialEndsAt > new Date()
  );
});

churchSchema.pre('save', function (next) {
  if (!this.code) {
    this.code = Math.random().toString(36).substring(2, 8).toUpperCase();
  }
  next();
});

module.exports = mongoose.model('Church', churchSchema);
