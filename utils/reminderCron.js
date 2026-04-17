/**
 * rentflow/utils/reminderCron.js
 * Daily cron job — runs at 9AM UTC every day
 * Sends rent reminders and auto-creates payment links
 */
const cron = require("node-cron");
const Tenant = require("../models/Tenant");
const PaymentLink = require("../models/PaymentLink");
const Reminder = require("../models/Reminder");
const { sendEmail, sendSMS, templates } = require("./notifications");

const startCron = () => {
    cron.schedule("0 9 * * *", async () => {
        console.log("⏰ Running daily reminder cron...");
        try {
            const today = new Date();
            const month = today.getMonth() + 1;
            const year = today.getFullYear();

            // Get all active tenants with their landlord's settings
            const tenants = await Tenant.find({ status: "active" })
                .populate("landlord", "settings stripeAccountId stripeOnboardingComplete");

            for (const tenant of tenants) {
                const landlord = tenant.landlord;
                if (!landlord) continue;

                const dueDay = tenant.lease.rentDueDay;
                const daysBefore = landlord.settings?.reminderDaysBefore || 3;
                const daysAfter = landlord.settings?.reminderDaysAfter || 1;
                const channel = landlord.settings?.defaultReminderChannel || "email";
                const sendOnDue = landlord.settings?.reminderOnDueDate !== false;

                // Calculate the date triggers
                const dueDate = new Date(year, today.getMonth(), dueDay);
                const beforeDate = new Date(dueDate); beforeDate.setDate(dueDay - daysBefore);
                const overdueDate = new Date(dueDate); overdueDate.setDate(dueDay + daysAfter);

                let reminderType = null;
                if (today.getDate() === beforeDate.getDate() && tenant.balance > 0) reminderType = "rent_due_soon";
                if (today.getDate() === dueDay && tenant.balance > 0 && sendOnDue) reminderType = "rent_due_today";
                if (today.getDate() === overdueDate.getDate() && tenant.balance > 0) reminderType = "rent_overdue";

                if (!reminderType) continue;

                // Don't double-send this reminder type this month
                const sent = await Reminder.findOne({
                    tenant: tenant._id, type: reminderType,
                    "period.month": month, "period.year": year,
                    status: { $in: ["sent", "delivered"] },
                });
                if (sent) continue;

                // Create or reuse a payment link if Stripe is connected
                let link = null;
                if (landlord.stripeOnboardingComplete) {
                    link = await PaymentLink.findOne({ tenant: tenant._id, "period.month": month, "period.year": year, status: "active" });
                    if (!link) {
                        link = await PaymentLink.create({
                            landlord: landlord._id, tenant: tenant._id, property: tenant.property,
                            amount: tenant.lease.monthlyRent, type: "rent", period: { month, year },
                            expiresAt: new Date(Date.now() + 72 * 60 * 60 * 1000),
                        });
                    }
                }

                // Save the reminder record
                const reminder = await Reminder.create({
                    landlord: landlord._id, tenant: tenant._id,
                    type: reminderType, period: { month, year },
                    channel, paymentLink: link?._id,
                    scheduledFor: today, isAutomatic: true,
                });

                // Send it
                try {
                    if (channel === "email" || channel === "both") {
                        const tmpl = templates.rentReminder(tenant, link, reminderType);
                        await sendEmail({ to: tenant.email, ...tmpl });
                    }
                    if ((channel === "sms" || channel === "both") && tenant.phone) {
                        const msg = `Hi ${tenant.firstName}, ${reminderType === "rent_overdue" ? "your rent is overdue" : "rent is due soon"}. Pay: ${link?.url || ""}`;
                        await sendSMS(tenant.phone, msg);
                    }
                    reminder.status = "sent";
                    reminder.sentAt = new Date();
                    console.log(`✅ Reminder sent (${reminderType}) → ${tenant.email}`);
                } catch (e) {
                    reminder.status = "failed";
                    reminder.failureReason = e.message;
                    console.error(`❌ Reminder failed → ${tenant.email}:`, e.message);
                }
                await reminder.save();
            }

            // Expire old payment links
            await PaymentLink.updateMany(
                { status: "active", expiresAt: { $lt: today } },
                { status: "expired" }
            );
            console.log("✅ Cron complete.");
        } catch (err) {
            console.error("❌ Cron error:", err);
        }
    });

    console.log("⏰ Reminder cron scheduled — daily at 9:00 AM UTC");
};

module.exports = { startCron };