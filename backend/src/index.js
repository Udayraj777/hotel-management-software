const express=require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit=require('express-rate-limit');
const http = require('http');
require('dotenv').config();
const { PrismaClient }= require('@prisma/client');

// Import WebSocket server
const SocketServer = require('./websocket/socketServer');

// Import routes
const authRoutes = require('./routes/auth');
const hotelRoutes = require('./routes/hotels');
const platformRoutes = require('./routes/platform');
const hotelUserRoutes = require('./routes/hotelUsers');
const roomTypeRoutes = require('./routes/roomTypes');
const roomRoutes = require('./routes/rooms');
const guestRoutes = require('./routes/guests');
const bookingRoutes = require('./routes/bookings');
const taskRoutes = require('./routes/tasks');
const managerRoutes = require('./routes/manager');
const websocketTestRoutes = require('./routes/websocketTest');

const app = express();
const server = http.createServer(app);
const prisma= new PrismaClient();
const PORT = process.env.PORT || 3000;

// Initialize WebSocket server
const socketServer = new SocketServer(server);
// Make socket server available globally for controllers
global.socketServer = socketServer;

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100 // limit each IP to 100 requests per windowMs
});

app.use(helmet());
app.use(cors());
app.use(morgan('combined'));
app.use(limiter);
app.use(express.json({
  limit:'10mb',
  verify: (req, res, buf, encoding) => {
    // Skip JSON parsing for empty or whitespace-only bodies
    if (buf.length === 0 || buf.toString().trim() === '') {
      req.body = {};
      return;
    }
  }
}));
app.use(express.urlencoded({extended:true}));

//health check route
app.get('/health',(req,res)=>{
  res.json({
    status:'OK',
    message:'Hotel Management API is running'
  });
});

// API routes
app.use('/api/auth', authRoutes);
app.use('/api/hotels', hotelRoutes);
app.use('/api/platform', platformRoutes);
app.use('/api/users', hotelUserRoutes);
app.use('/api/room-types', roomTypeRoutes);
app.use('/api/rooms', roomRoutes);
app.use('/api/guests', guestRoutes);
app.use('/api/bookings', bookingRoutes);
app.use('/api/tasks', taskRoutes);
app.use('/api/manager', managerRoutes);
app.use('/api/websocket-test', websocketTestRoutes);

// Default API route
app.use('/api',(req,res)=>{
  res.json({ 
    message: 'Hotel Management API',
    version: '1.0.0',
    endpoints: {
      auth: '/api/auth',
      hotels: '/api/hotels',
      platform: '/api/platform',
      users: '/api/users',
      roomTypes: '/api/room-types',
      rooms: '/api/rooms'
    },
    documentation: 'Use /api/platform/setup-hotel for atomic hotel + owner creation'
  });
});

app.use((err, req, res, next) => {
  console.error('Error occurred:', err.message);
  console.error('Error stack:', err.stack);
  
  // Handle JSON parsing errors specifically
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    console.log('JSON parsing error - likely empty or malformed body');
    return res.status(400).json({ error: 'Invalid JSON in request body' });
  }
  
  res.status(500).json({ error: 'Something went wrong!' });
});

app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// Comment out SIGINT handler temporarily for debugging
// process.on('SIGINT', async () => {
//   console.log('Shutting down gracefully...');
//   await prisma.$disconnect();
//   process.exit(0);
// });

// Add process debugging
console.log('🔧 Starting server setup...');

process.on('exit', (code) => {
  console.log(`🚪 Process exiting with code: ${code}`);
});

process.on('uncaughtException', (error) => {
  console.error('💥 Uncaught Exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('💥 Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

console.log('🔧 About to start listening on port:', PORT);

server.listen(PORT, 'localhost', (error) => {
  if (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`🔌 WebSocket server running on ws://localhost:${PORT}`);
  console.log('🔄 Server is ready to accept connections');
  console.log('🔧 Server should now stay running...');
});

server.on('error', (error) => {
  console.error('❌ Server error:', error);
});

server.on('close', () => {
  console.log('🔴 Server closed');
});

// Test database connection separately
console.log('🔧 Testing database connection...');
prisma.$connect()
  .then(() => {
    console.log('✅ Database connected successfully');
  })
  .catch((error) => {
    console.error('❌ Database connection failed:', error.message);
    console.error('Please check your DATABASE_URL in .env file');
  });

