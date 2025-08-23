const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

class SocketServer {
  constructor(server) {
    // Initialize Socket.IO server with CORS settings
    this.io = new Server(server, {
      cors: {
        origin: "*", // In production, specify your frontend domain
        methods: ["GET", "POST"]
      }
    });

    // Store connected users by hotel for easy broadcasting
    this.connectedUsers = new Map(); // hotelId -> Set of socketIds
    this.socketToUser = new Map();   // socketId -> user info
    
    this.setupMiddleware();
    this.setupEventHandlers();
  }

  /**
   * WHY: Authentication middleware for WebSocket connections
   * Socket connections need to be authenticated just like HTTP requests
   * We verify JWT token before allowing connection
   */
  setupMiddleware() {
    this.io.use(async (socket, next) => {
      try {
        console.log('🔐 WebSocket authentication attempt');
        
        // Extract token from handshake auth or query
        const token = socket.handshake.auth?.token || socket.handshake.query?.token;
        
        if (!token) {
          console.log('❌ No token provided for WebSocket connection');
          return next(new Error('Authentication required'));
        }

        // Verify JWT token (same as HTTP middleware)
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        
        // Get full user info from database
        const user = await prisma.user.findUnique({
          where: { id: decoded.userId },
          include: {
            hotel: {
              select: {
                id: true,
                name: true,
                subscriptionStatus: true
              }
            }
          }
        });

        if (!user || !user.isActive) {
          console.log('❌ Invalid or inactive user for WebSocket connection');
          return next(new Error('Invalid user'));
        }

        // Check hotel subscription status
        if (user.hotel && user.hotel.subscriptionStatus !== 'active' && user.hotel.subscriptionStatus !== 'trial') {
          console.log('❌ Hotel subscription inactive for WebSocket connection');
          return next(new Error('Hotel subscription inactive'));
        }

        // Attach user info to socket
        socket.userId = user.id;
        socket.userRole = user.role;
        socket.hotelId = user.hotelId;
        socket.userName = user.name;
        socket.userEmail = user.email;

        console.log(`✅ WebSocket authenticated: ${user.name} (${user.role}) from hotel ${user.hotelId}`);
        next();
        
      } catch (error) {
        console.log('❌ WebSocket authentication failed:', error.message);
        next(new Error('Authentication failed'));
      }
    });
  }

  /**
   * WHY: Handle connection events and user management
   * When users connect/disconnect, we track them by hotel
   * This allows us to send updates only to users in the same hotel
   */
  setupEventHandlers() {
    this.io.on('connection', (socket) => {
      console.log(`🔌 User connected: ${socket.userName} (${socket.id})`);
      
      // Join hotel-specific room for tenant isolation
      if (socket.hotelId) {
        socket.join(`hotel_${socket.hotelId}`);
        console.log(`🏨 User ${socket.userName} joined hotel room: hotel_${socket.hotelId}`);
        
        // Track connected users by hotel
        if (!this.connectedUsers.has(socket.hotelId)) {
          this.connectedUsers.set(socket.hotelId, new Set());
        }
        this.connectedUsers.get(socket.hotelId).add(socket.id);
      }

      // Store socket to user mapping
      this.socketToUser.set(socket.id, {
        userId: socket.userId,
        hotelId: socket.hotelId,
        role: socket.userRole,
        name: socket.userName,
        email: socket.userEmail
      });

      // Send welcome message with connection info
      socket.emit('connected', {
        message: 'Connected to hotel management system',
        user: {
          id: socket.userId,
          name: socket.userName,
          role: socket.userRole,
          hotelId: socket.hotelId
        }
      });

      // Broadcast to other users in the same hotel that someone joined
      socket.to(`hotel_${socket.hotelId}`).emit('user_connected', {
        userName: socket.userName,
        userRole: socket.userRole,
        timestamp: new Date().toISOString()
      });

      // Handle client requesting to join specific rooms (like manager dashboard)
      socket.on('join_room', (roomName) => {
        // Only allow joining rooms within their hotel
        const allowedRooms = [
          'manager_dashboard',
          'front_desk',
          'housekeeping',
          'room_updates'
        ];
        
        if (allowedRooms.includes(roomName)) {
          const hotelRoom = `hotel_${socket.hotelId}_${roomName}`;
          socket.join(hotelRoom);
          console.log(`📱 ${socket.userName} joined ${hotelRoom}`);
          socket.emit('room_joined', { room: roomName });
        }
      });

      // Handle disconnection
      socket.on('disconnect', (reason) => {
        console.log(`🔌 User disconnected: ${socket.userName} (${reason})`);
        
        // Remove from tracking
        if (socket.hotelId && this.connectedUsers.has(socket.hotelId)) {
          this.connectedUsers.get(socket.hotelId).delete(socket.id);
          
          // Clean up empty hotel sets
          if (this.connectedUsers.get(socket.hotelId).size === 0) {
            this.connectedUsers.delete(socket.hotelId);
          }
        }
        
        this.socketToUser.delete(socket.id);

        // Notify other users in the same hotel
        if (socket.hotelId) {
          socket.to(`hotel_${socket.hotelId}`).emit('user_disconnected', {
            userName: socket.userName,
            userRole: socket.userRole,
            timestamp: new Date().toISOString()
          });
        }
      });
    });
  }

  /**
   * UTILITY METHODS FOR BROADCASTING UPDATES
   * These methods will be called from your controllers
   * when data changes happen (room updates, task completions, etc.)
   */

  // Broadcast to all users in a specific hotel
  broadcastToHotel(hotelId, event, data) {
    console.log(`📡 Broadcasting to hotel ${hotelId}: ${event}`);
    this.io.to(`hotel_${hotelId}`).emit(event, {
      ...data,
      timestamp: new Date().toISOString()
    });
  }

  // Broadcast to specific role within a hotel
  broadcastToRole(hotelId, role, event, data) {
    const hotelUsers = this.connectedUsers.get(hotelId);
    if (!hotelUsers) return;

    console.log(`📡 Broadcasting to ${role} in hotel ${hotelId}: ${event}`);
    
    hotelUsers.forEach(socketId => {
      const socket = this.io.sockets.sockets.get(socketId);
      if (socket && socket.userRole === role) {
        socket.emit(event, {
          ...data,
          timestamp: new Date().toISOString()
        });
      }
    });
  }

  // Broadcast to specific room within a hotel
  broadcastToRoom(hotelId, roomName, event, data) {
    const hotelRoom = `hotel_${hotelId}_${roomName}`;
    console.log(`📡 Broadcasting to room ${hotelRoom}: ${event}`);
    this.io.to(hotelRoom).emit(event, {
      ...data,
      timestamp: new Date().toISOString()
    });
  }

  // Get connected users count for a hotel
  getConnectedUsersCount(hotelId) {
    return this.connectedUsers.get(hotelId)?.size || 0;
  }

  // Get connected users info for a hotel
  getConnectedUsers(hotelId) {
    const hotelUsers = this.connectedUsers.get(hotelId);
    if (!hotelUsers) return [];

    return Array.from(hotelUsers).map(socketId => {
      return this.socketToUser.get(socketId);
    }).filter(Boolean);
  }
}

module.exports = SocketServer;