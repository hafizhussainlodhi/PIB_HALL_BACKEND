// ============================================================================
// Run this ONCE to make sure the admin user exists in the "users" collection:
//   node seed.js
// ============================================================================
require('dotenv').config();
const dns = require('node:dns');
dns.setServers(['1.1.1.1', '8.8.8.8']);
const mongoose = require('mongoose');
const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://admin:admin@cluster0.ueexwix.mongodb.net/PIB_HALL?retryWrites=true&w=majority';

const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true }
});
const User = mongoose.model('User', userSchema, 'users');

async function seed() {
  try {
    await mongoose.connect(MONGO_URI);
    console.log('Connected to MongoDB.');

    const existing = await User.findOne({ email: 'admin@hall.com' });

    if (existing) {
      console.log('Admin user already exists. No changes made.');
    } else {
      await User.create({ email: 'admin@hall.com', password: '2112' });
      console.log('Admin user created: admin@hall.com / 2112');
    }
  } catch (err) {
    console.error('Seed error:', err.message);
  } finally {
    await mongoose.disconnect();
    process.exit(0);
  }
}

seed();
