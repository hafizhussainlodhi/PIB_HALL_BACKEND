// ============================================================================
// Sorathia Muslim Ghanchi Jamat - Wedding Hall Management System - Backend Server
// ============================================================================
require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const dns = require('node:dns');

dns.setServers(['8.8.8.8', '8.8.4.4']);
const app = express();
const PORT = process.env.PORT || 5000;
const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://admin:admin@cluster0.ueexwix.mongodb.net/PIB_HALL?retryWrites=true&w=majority';

// ----------------------------------------------------------------------------
// Middleware
// ----------------------------------------------------------------------------
app.use(cors({
  origin: ['https://pib-hall.vercel.app', 'http://localhost:5173'],
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  credentials: true
}));
app.use(express.json());

// ----------------------------------------------------------------------------
// MongoDB Connection (serverless-safe)
// ----------------------------------------------------------------------------
// On Vercel every request can hit a fresh serverless invocation. The old code
// fired mongoose.connect() once at module load and never waited for it, so a
// request could reach a route handler before the connection was ready — the
// query would then silently "buffer" and fail after Mongoose's default 10s
// buffering timeout (exactly the "users.findOne() buffering timed out" error
// seen in the logs). This pattern instead:
//   1. Caches the connection (and in-flight connect promise) on `global`, so
//      warm invocations reuse the same connection instead of reconnecting.
//   2. Makes every request explicitly await a real, ready connection via
//      middleware below, so failures show up as a clear 503 instead of a
//      vague timeout.
let cached = global._mongooseConn;
if (!cached) {
  cached = global._mongooseConn = { conn: null, promise: null };
}

async function connectToDatabase() {
  if (cached.conn && mongoose.connection.readyState === 1) {
    return cached.conn;
  }
  if (!cached.promise) {
    cached.promise = mongoose
      .connect(MONGO_URI, {
        family: 4,                     // force IPv4 - fixes SRV DNS timeouts on Vercel serverless
        serverSelectionTimeoutMS: 20000,
        socketTimeoutMS: 45000
      })
      .then((m) => {
        console.log('✅ MongoDB connected successfully to PIB_HALL database');
        return m;
      })
      .catch((err) => {
        console.error('❌ MongoDB connection error:', err.message);
        cached.promise = null; // allow the next request to retry instead of staying stuck
        throw err;
      });
  }
  cached.conn = await cached.promise;
  return cached.conn;
}

// Every request waits here for a real, ready connection before reaching any
// route below — this is what actually prevents the buffering-timeout error.
app.use(async (req, res, next) => {
  try {
    await connectToDatabase();
    next();
  } catch (err) {
    return res.status(503).json({ success: false, message: 'Database connection failed. Please try again shortly.' });
  }
});

// ----------------------------------------------------------------------------
// Mongoose Schemas & Models
// ----------------------------------------------------------------------------

// --- User Schema ---
const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true } // Plain text as specified (no bcrypt)
});
const User = mongoose.model('User', userSchema, 'users');

// --- Booking Schema ---
const bookingSchema = new mongoose.Schema({
  customerName: { type: String, required: true },
  customerPhone: { type: String, required: true },
  eventDate: { type: Date, required: true },
  hallPosition: { type: String, enum: ['A', 'B', 'C'], required: true },
  eventType: {
    type: String,
    enum: ['Barat', 'Valima', 'Mehendi', 'Nikah', 'Birthday', 'Other'],
    required: true,
    default: 'Barat'
  },
  // Free-text label used only when eventType === 'Other', e.g. "Aqiqah", "Anniversary"
  customEventType: { type: String, default: '' },
  eventShift: {
    type: String,
    enum: ['Day', 'Night'],
    required: true,
    default: 'Day'
  },
  totalAmount: { type: Number, required: true, default: 0 },
  advancePaid: { type: Number, required: true, default: 0 },
  balanceDue: { type: Number, default: 0 },
  paymentStatus: {
    type: String,
    enum: ['Fully Paid', 'Partially Paid', 'Unpaid'],
    default: 'Unpaid'
  }
}, { timestamps: true });

// Auto-calculate balanceDue and paymentStatus before saving
bookingSchema.pre('save', function (next) {
  this.balanceDue = this.totalAmount - this.advancePaid;

  if (this.balanceDue <= 0) {
    this.paymentStatus = 'Fully Paid';
  } else if (this.advancePaid > 0) {
    this.paymentStatus = 'Partially Paid';
  } else {
    this.paymentStatus = 'Unpaid';
  }

  next();
});

const Booking = mongoose.model('Booking', bookingSchema);

// --- Expense Schema ---
const expenseSchema = new mongoose.Schema({
  expenseType: {
    type: String,
    enum: ['Electricity', 'Water', 'Maintenance', 'Salaries', 'Other'],
    required: true
  },
  amount: { type: Number, required: true },
  date: { type: Date, required: true, default: Date.now },
  notes: { type: String, default: '' }
}, { timestamps: true });

const Expense = mongoose.model('Expense', expenseSchema);

// ----------------------------------------------------------------------------
// Helper: get start/end of current month
// ----------------------------------------------------------------------------
function getCurrentMonthRange() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
  return { start, end };
}

// Helper: get start/end of today
function getTodayRange() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
  return { start, end };
}

// Helper: get start/end range for a given period + reference values (used by /api/analytics routes)
// period: 'daily' | 'monthly' | 'yearly'
function getPeriodRange(period, { day, month, year } = {}) {
  const now = new Date();
  const y = year ? Number(year) : now.getFullYear();

  if (period === 'daily') {
    const d = day ? new Date(day) : now;
    const start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
    const end = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
    return { start, end };
  }

  if (period === 'monthly') {
    const m = month ? Number(month) - 1 : now.getMonth();
    const start = new Date(y, m, 1, 0, 0, 0, 0);
    const end = new Date(y, m + 1, 0, 23, 59, 59, 999);
    return { start, end };
  }

  // yearly (default)
  const start = new Date(y, 0, 1, 0, 0, 0, 0);
  const end = new Date(y, 11, 31, 23, 59, 59, 999);
  return { start, end };
}

const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// ----------------------------------------------------------------------------
// AUTH ROUTES
// ----------------------------------------------------------------------------
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Email and password are required.' });
    }

    const user = await User.findOne({ email: email, password: password });

    if (!user) {
      return res.status(401).json({ success: false, message: 'Invalid email or password.' });
    }

    return res.status(200).json({
      success: true,
      message: 'Login successful.',
      user: { email: user.email }
    });
  } catch (err) {
    console.error('Login error:', err.message);
    return res.status(500).json({ success: false, message: 'Server error during login.' });
  }
});

// ----------------------------------------------------------------------------
// BOOKING ROUTES
// ----------------------------------------------------------------------------

// GET all bookings
app.get('/api/bookings', async (req, res) => {
  try {
    const bookings = await Booking.find().sort({ eventDate: -1 });
    return res.status(200).json({ success: true, data: bookings });
  } catch (err) {
    console.error('Fetch bookings error:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to fetch bookings.' });
  }
});

// POST create a new booking
app.post('/api/bookings', async (req, res) => {
  try {
    const { customerName, customerPhone, eventDate, hallPosition, eventType, customEventType, eventShift, totalAmount, advancePaid } = req.body;


    if (!customerName || !customerPhone || !eventDate || !hallPosition) {
      return res.status(400).json({ success: false, message: 'Missing required booking fields.' });
    }

    if (!['A', 'B', 'C'].includes(hallPosition)) {
      return res.status(400).json({ success: false, message: 'Invalid hall position. Must be A, B, or C.' });
    }

    const allowedEventTypes = ['Barat', 'Valima', 'Mehendi', 'Nikah', 'Birthday', 'Other'];
    if (eventType && !allowedEventTypes.includes(eventType)) {
      return res.status(400).json({ success: false, message: 'Invalid event type.' });
    }

    if (eventType === 'Other' && !customEventType) {
      return res.status(400).json({ success: false, message: 'Please specify the event when choosing "Other".' });
    }

    if (eventShift && !['Day', 'Night'].includes(eventShift)) {
      return res.status(400).json({ success: false, message: 'Invalid event shift. Must be Day or Night.' });
    }

    const newBooking = new Booking({
      customerName,
      customerPhone,
      eventDate: new Date(eventDate),
      hallPosition,
      eventType: eventType || 'Barat',
      customEventType: eventType === 'Other' ? (customEventType || '').trim() : '',
      eventShift: eventShift || 'Day',
      totalAmount: Number(totalAmount) || 0,
      advancePaid: Number(advancePaid) || 0
    });

    const savedBooking = await newBooking.save(); // balanceDue & paymentStatus auto-calculated

    return res.status(201).json({ success: true, data: savedBooking });
  } catch (err) {
    console.error('Create booking error:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to create booking.' });
  }
});

// ----------------------------------------------------------------------------
// EXPENSE ROUTES
// ----------------------------------------------------------------------------

// GET all expenses
app.get('/api/expenses', async (req, res) => {
  try {
    const expenses = await Expense.find().sort({ date: -1 });
    return res.status(200).json({ success: true, data: expenses });
  } catch (err) {
    console.error('Fetch expenses error:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to fetch expenses.' });
  }
});

// POST create a new expense
app.post('/api/expenses', async (req, res) => {
  try {
    const { expenseType, amount, date, notes } = req.body;

    if (!expenseType || amount === undefined || amount === null) {
      return res.status(400).json({ success: false, message: 'Expense type and amount are required.' });
    }

    const newExpense = new Expense({
      expenseType,
      amount: Number(amount),
      date: date ? new Date(date) : new Date(),
      notes: notes || ''
    });

    const savedExpense = await newExpense.save();

    return res.status(201).json({ success: true, data: savedExpense });
  } catch (err) {
    console.error('Create expense error:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to create expense.' });
  }
});

// ----------------------------------------------------------------------------
// DASHBOARD STATS ROUTE
// ----------------------------------------------------------------------------
app.get('/api/dashboard-stats', async (req, res) => {
  try {
    const { start: monthStart, end: monthEnd } = getCurrentMonthRange();
    const { start: todayStart, end: todayEnd } = getTodayRange();

    // Monthly bookings (based on eventDate falling in current month)
    const monthlyBookings = await Booking.find({
      eventDate: { $gte: monthStart, $lte: monthEnd }
    });

    const monthlyRevenue = monthlyBookings.reduce((sum, b) => sum + (b.totalAmount || 0), 0);

    // Monthly expenses
    const monthlyExpenses = await Expense.find({
      date: { $gte: monthStart, $lte: monthEnd }
    });

    const totalMonthlyExpenses = monthlyExpenses.reduce((sum, e) => sum + (e.amount || 0), 0);

    // Outstanding balances across ALL bookings (not just this month)
    const allBookings = await Booking.find();
    const totalOutstandingBalance = allBookings.reduce((sum, b) => sum + (b.balanceDue > 0 ? b.balanceDue : 0), 0);

    // Net profit
    const netProfit = monthlyRevenue - totalMonthlyExpenses;

    // Today's bookings, grouped by position
    const todaysBookings = await Booking.find({
      eventDate: { $gte: todayStart, $lte: todayEnd }
    });

    const bookedPositionsToday = {
      A: todaysBookings.filter(b => b.hallPosition === 'A'),
      B: todaysBookings.filter(b => b.hallPosition === 'B'),
      C: todaysBookings.filter(b => b.hallPosition === 'C')
    };

    return res.status(200).json({
      success: true,
      data: {
        monthlyRevenue,
        totalMonthlyExpenses,
        totalOutstandingBalance,
        netProfit,
        bookedToday: {
          A: bookedPositionsToday.A.length > 0,
          B: bookedPositionsToday.B.length > 0,
          C: bookedPositionsToday.C.length > 0
        },
        todaysBookingDetails: bookedPositionsToday
      }
    });
  } catch (err) {
    console.error('Dashboard stats error:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to compute dashboard stats.' });
  }
});

// ----------------------------------------------------------------------------
// ANALYTICS / REPORTS ROUTES
// ----------------------------------------------------------------------------

// GET profit/loss summary for a daily, monthly, or yearly period
// Query params: period=daily|monthly|yearly, day=YYYY-MM-DD, month=1-12, year=YYYY
app.get('/api/analytics/summary', async (req, res) => {
  try {
    const { period = 'monthly', day, month, year } = req.query;

    if (!['daily', 'monthly', 'yearly'].includes(period)) {
      return res.status(400).json({ success: false, message: 'period must be daily, monthly, or yearly.' });
    }

    const { start, end } = getPeriodRange(period, { day, month, year });

    const periodBookings = await Booking.find({ eventDate: { $gte: start, $lte: end } });
    const periodExpenses = await Expense.find({ date: { $gte: start, $lte: end } });

    const revenue = periodBookings.reduce((sum, b) => sum + (b.totalAmount || 0), 0);
    const totalExpenses = periodExpenses.reduce((sum, e) => sum + (e.amount || 0), 0);
    const profit = revenue - totalExpenses;

    return res.status(200).json({
      success: true,
      data: {
        period,
        rangeStart: start,
        rangeEnd: end,
        revenue,
        expenses: totalExpenses,
        profit,
        bookingsCount: periodBookings.length,
        expensesCount: periodExpenses.length
      }
    });
  } catch (err) {
    console.error('Analytics summary error:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to compute analytics summary.' });
  }
});

// GET month-by-month revenue/expense/profit breakdown for a given year (for charts)
// Query params: year=YYYY
app.get('/api/analytics/yearly-chart', async (req, res) => {
  try {
    const year = req.query.year ? Number(req.query.year) : new Date().getFullYear();

    const yearStart = new Date(year, 0, 1, 0, 0, 0, 0);
    const yearEnd = new Date(year, 11, 31, 23, 59, 59, 999);

    const [yearBookings, yearExpenses] = await Promise.all([
      Booking.find({ eventDate: { $gte: yearStart, $lte: yearEnd } }),
      Expense.find({ date: { $gte: yearStart, $lte: yearEnd } })
    ]);

    const monthly = MONTH_LABELS.map((label) => ({ month: label, revenue: 0, expenses: 0, profit: 0 }));

    yearBookings.forEach((b) => {
      const m = new Date(b.eventDate).getMonth();
      monthly[m].revenue += b.totalAmount || 0;
    });

    yearExpenses.forEach((e) => {
      const m = new Date(e.date).getMonth();
      monthly[m].expenses += e.amount || 0;
    });

    monthly.forEach((m) => { m.profit = m.revenue - m.expenses; });

    return res.status(200).json({ success: true, data: { year, monthly } });
  } catch (err) {
    console.error('Yearly chart analytics error:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to compute yearly chart data.' });
  }
});

// ----------------------------------------------------------------------------
// Health check route
// ----------------------------------------------------------------------------
app.get('/', (req, res) => {
  res.send('Sorathia Muslim Ghanchi Jamat Management System API is running.');
});

// ----------------------------------------------------------------------------
// Start server
// ----------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});