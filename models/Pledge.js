const mongoose = require('mongoose');

const pledgeSchema = new mongoose.Schema(
  {
    church: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Church',
      required: true,
      index: true,
    },
    membership: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Membership',
      required: true,
    },
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },

    label: {
      type: String,
      required: true,
      trim: true,
      // e.g. "Annual Convention Pledge 2025", "Building Fund Vow"
    },
    targetAmount: {
      type: Number,
      required: true,
      min: [1, 'Target amount must be at least 1'],
    },
    amountPaid: {
      type: Number,
      default: 0,
    },
    currency: { type: String, default: 'NGN', uppercase: true },

    dueDate: { type: Date },

    status: {
      type: String,
      enum: ['active', 'fulfilled', 'cancelled'],
      default: 'active',
      index: true,
    },
    fulfilledAt: { type: Date },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

pledgeSchema.virtual('balance').get(function () {
  return Math.max(0, this.targetAmount - this.amountPaid);
});

pledgeSchema.virtual('percentComplete').get(function () {
  if (!this.targetAmount) return 0;
  return Math.min(100, Math.round((this.amountPaid / this.targetAmount) * 100));
});

pledgeSchema.index({ church: 1, status: 1 });
pledgeSchema.index({ membership: 1, status: 1 });

module.exports = mongoose.model('Pledge', pledgeSchema);
