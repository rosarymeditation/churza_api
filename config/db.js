/**
 * rentflow/config/db.js
 * MongoDB connection via Mongoose
 */
const mongoose = require("mongoose");

const connectDB = async () => {
    try {
        const conn = await mongoose.connect(process.env.MONGO_URI);
        console.log(`✅ MongoDB connected: ${conn.connection.host}`);
    } catch (err) {
        console.error(`❌ MongoDB connection failed: ${err.message}`);
        process.exit(1); // Kill the server — no point running without a DB
    }
};

module.exports = connectDB;