const { PrismaClient } = require('@prisma/client');
const { z } = require('zod');
const { hashPassword } = require('../utils/auth');
const { getHotelSetupStatus } = require('../utils/hotelSetupChecker');

const prisma = new PrismaClient();

// Comprehensive validation schema
const setupHotelSchema = z.object({
  hotel: z.object({
    name: z.string()
      .min(2, 'Hotel name must be at least 2 characters')
      .max(100, 'Hotel name too long')
      .regex(/^[a-zA-Z0-9\s&.-]+$/, 'Hotel name contains invalid characters'),
    address: z.string()
      .min(10, 'Address must be at least 10 characters')
      .max(500, 'Address too long'),
    phone: z.string()
      .regex(/^[\+]?[1-9][\d]{0,15}$/, 'Invalid phone number format')
      .min(10, 'Phone number too short')
      .max(20, 'Phone number too long')
  }),
  owner: z.object({
    name: z.string()
      .min(2, 'Owner name must be at least 2 characters')
      .max(100, 'Owner name too long')
      .regex(/^[a-zA-Z\s.-]+$/, 'Owner name contains invalid characters'),
    email: z.string()
      .email('Invalid email format')
      .max(255, 'Email too long'),
    password: z.string()
      .min(8, 'Password must be at least 8 characters')
      .regex(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/, 'Password must contain uppercase, lowercase, and number'),
    phone: z.string()
      .regex(/^[\+]?[1-9][\d]{0,15}$/, 'Invalid phone number format')
      .optional()
  })
});

// Atomic hotel + owner creation
const setupHotel = async (req, res) => {
  const startTime = Date.now();
  const requestId = `setup-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  
  try {
    console.log(`[${requestId}] Starting hotel setup process`);
    
    // Validate input
    const { hotel: hotelData, owner: ownerData } = setupHotelSchema.parse(req.body);
    
    // Check for existing conflicts before starting transaction
    const existingConflicts = await prisma.hotel.findFirst({
      where: {
        OR: [
          { name: hotelData.name },
          { ownerEmail: ownerData.email },
          { phone: hotelData.phone }
        ]
      },
      select: { name: true, ownerEmail: true, phone: true }
    });
    
    if (existingConflicts) {
      const conflicts = [];
      if (existingConflicts.name === hotelData.name) conflicts.push('hotel name');
      if (existingConflicts.ownerEmail === ownerData.email) conflicts.push('owner email');
      if (existingConflicts.phone === hotelData.phone) conflicts.push('phone number');
      
      console.log(`[${requestId}] Conflicts found: ${conflicts.join(', ')}`);
      return res.status(409).json({
        error: 'Conflict detected',
        conflicts,
        message: `The following already exist: ${conflicts.join(', ')}`
      });
    }
    
    // Check if user with owner email already exists
    const existingUser = await prisma.user.findUnique({
      where: { email: ownerData.email }
    });
    
    if (existingUser) {
      console.log(`[${requestId}] User email already exists: ${ownerData.email}`);
      return res.status(409).json({
        error: 'Email already registered',
        message: 'A user with this email already exists'
      });
    }
    
    console.log(`[${requestId}] Validation passed, starting transaction`);
    
    // Hash password before transaction
    const passwordHash = await hashPassword(ownerData.password);
    
    // Atomic transaction
    const result = await prisma.$transaction(async (tx) => {
      // Create hotel
      const hotel = await tx.hotel.create({
        data: {
          name: hotelData.name,
          address: hotelData.address,
          phone: hotelData.phone,
          ownerEmail: ownerData.email,
          subscriptionStatus: 'trial',
          subscriptionEndDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days
          monthlyRate: 5000.00, // Default rate
          setupCompleted: false, // Requires owner setup
          isActive: true
        }
      });
      
      console.log(`[${requestId}] Hotel created with ID: ${hotel.id}`);
      
      // Create owner user
      const owner = await tx.user.create({
        data: {
          email: ownerData.email,
          passwordHash,
          name: ownerData.name,
          phone: ownerData.phone || null,
          role: 'hotel_owner',
          hotelId: hotel.id,
          firstLoginCompleted: false, // Force password change on first login
          createdById: req.user.userId // Platform admin who created this
        }
      });
      
      console.log(`[${requestId}] Owner created with ID: ${owner.id}`);
      
      return { hotel, owner };
    }, {
      maxWait: 5000, // 5 seconds
      timeout: 10000, // 10 seconds
    });
    
    const duration = Date.now() - startTime;
    console.log(`[${requestId}] Hotel setup completed successfully in ${duration}ms`);
    
    // Return response without sensitive data
    res.status(201).json({
      message: 'Hotel and owner account created successfully',
      requestId,
      data: {
        hotel: {
          id: result.hotel.id,
          name: result.hotel.name,
          address: result.hotel.address,
          phone: result.hotel.phone,
          subscriptionStatus: result.hotel.subscriptionStatus,
          subscriptionEndDate: result.hotel.subscriptionEndDate,
          monthlyRate: result.hotel.monthlyRate
        },
        owner: {
          id: result.owner.id,
          email: result.owner.email,
          name: result.owner.name,
          role: result.owner.role,
          firstLoginCompleted: result.owner.firstLoginCompleted
        }
      },
      nextSteps: [
        'Send welcome email to hotel owner',
        'Owner must login and complete first-time setup',
        'Configure room types and rooms',
        'Set up staff accounts'
      ]
    });
    
  } catch (error) {
    const duration = Date.now() - startTime;
    console.error(`[${requestId}] Hotel setup failed after ${duration}ms:`, error);
    
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        error: 'Validation failed',
        details: error.errors.map(err => ({
          field: err.path.join('.'),
          message: err.message
        })),
        requestId
      });
    }
    
    // Handle Prisma unique constraint violations
    if (error.code === 'P2002') {
      return res.status(409).json({
        error: 'Duplicate entry',
        message: 'Hotel name, phone, or email already exists',
        field: error.meta?.target,
        requestId
      });
    }
    
    // Generic error
    res.status(500).json({
      error: 'Hotel setup failed',
      message: 'An internal error occurred during hotel setup',
      requestId
    });
  }
};

// Get platform statistics
const getPlatformStats = async (req, res) => {
  try {
    const stats = await prisma.$transaction(async (tx) => {
      const totalHotels = await tx.hotel.count();
      const activeHotels = await tx.hotel.count({
        where: { isActive: true }
      });
      const trialHotels = await tx.hotel.count({
        where: { subscriptionStatus: 'trial' }
      });
      const expiredHotels = await tx.hotel.count({
        where: { subscriptionStatus: 'expired' }
      });
      const totalUsers = await tx.user.count({
        where: { role: { not: 'platform_admin' } }
      });
      
      return {
        hotels: {
          total: totalHotels,
          active: activeHotels,
          trial: trialHotels,
          expired: expiredHotels
        },
        users: {
          total: totalUsers
        },
        generatedAt: new Date().toISOString()
      };
    });
    
    res.json({
      message: 'Platform statistics retrieved',
      stats
    });
    
  } catch (error) {
    console.error('Platform stats error:', error);
    res.status(500).json({
      error: 'Failed to retrieve platform statistics'
    });
  }
};

// Get all hotels with detailed information and filtering
const getAllHotelsDetailed = async (req, res) => {
  try {
    const { page = 1, limit = 10, status, search, sortBy = 'createdAt', sortOrder = 'desc' } = req.query;
    
    // Build filter conditions
    const whereConditions = {};
    
    // Status filtering
    if (status && ['active', 'trial', 'expired', 'suspended'].includes(status)) {
      if (status === 'suspended') {
        whereConditions.isActive = false;
      } else {
        whereConditions.subscriptionStatus = status;
        if (status !== 'expired') {
          whereConditions.isActive = true;
        }
      }
    }
    
    // Search filtering
    if (search) {
      whereConditions.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { ownerEmail: { contains: search, mode: 'insensitive' } },
        { phone: { contains: search } }
      ];
    }

    // Valid sort fields
    const validSortFields = ['name', 'createdAt', 'subscriptionEndDate', 'subscriptionStatus'];
    const sortField = validSortFields.includes(sortBy) ? sortBy : 'createdAt';
    const sortDirection = sortOrder === 'asc' ? 'asc' : 'desc';

    const [hotels, totalCount] = await Promise.all([
      prisma.hotel.findMany({
        where: whereConditions,
        include: {
          users: {
            where: { role: 'hotel_owner' },
            select: {
              id: true,
              name: true,
              email: true,
              lastLogin: true,
              createdAt: true,
              isActive: true
            }
          },
          _count: {
            select: {
              users: true,
              rooms: true,
              bookings: {
                where: {
                  createdAt: {
                    gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) // Last 30 days
                  }
                }
              }
            }
          }
        },
        orderBy: { [sortField]: sortDirection },
        skip: (parseInt(page) - 1) * parseInt(limit),
        take: parseInt(limit)
      }),
      prisma.hotel.count({ where: whereConditions })
    ]);

    // Calculate enhanced details for each hotel
    const hotelsWithDetails = hotels.map(hotel => {
      const now = new Date();
      let daysRemaining = 0;
      let statusColor = 'green';
      let statusText = hotel.subscriptionStatus;
      let canSuspend = true;
      let canActivate = false;

      // Calculate days remaining
      if (hotel.subscriptionEndDate) {
        daysRemaining = Math.ceil((hotel.subscriptionEndDate - now) / (1000 * 60 * 60 * 24));
      }

      // Determine status and colors - prioritize setup status
      if (!hotel.isActive) {
        statusColor = 'red';
        statusText = 'suspended';
        canSuspend = false;
        canActivate = true;
      } else if (!hotel.setupCompleted) {
        statusColor = 'yellow';
        statusText = 'setup_incomplete';
        canSuspend = false; // Can't suspend incomplete setups
      } else if (hotel.subscriptionStatus === 'expired' || daysRemaining <= 0) {
        statusColor = 'red';
        statusText = 'expired';
      } else if (hotel.subscriptionStatus === 'trial' && daysRemaining <= 7) {
        statusColor = 'yellow';
        statusText = 'trial (expiring soon)';
      } else if (hotel.subscriptionStatus === 'trial') {
        statusColor = 'blue';
        statusText = 'trial';
      } else {
        statusColor = 'green';
        statusText = 'active';
      }

      const owner = hotel.users[0] || null;

      return {
        id: hotel.id,
        name: hotel.name,
        ownerEmail: hotel.ownerEmail,
        phone: hotel.phone,
        address: hotel.address,
        subscriptionStatus: statusText,
        subscriptionEndDate: hotel.subscriptionEndDate,
        monthlyRate: parseFloat(hotel.monthlyRate) || 0,
        daysRemaining: Math.max(0, daysRemaining),
        isActive: hotel.isActive,
        setupCompleted: hotel.setupCompleted,
        statusColor,
        canSuspend,
        canActivate,
        createdAt: hotel.createdAt,
        lastReminderSent: hotel.lastReminderSent,
        paymentHistory: hotel.paymentHistory,
        owner: owner ? {
          ...owner,
          daysSinceLastLogin: owner.lastLogin 
            ? Math.floor((now - new Date(owner.lastLogin)) / (1000 * 60 * 60 * 24))
            : null
        } : null,
        stats: {
          totalUsers: hotel._count.users,
          totalRooms: hotel._count.rooms,
          bookingsLast30Days: hotel._count.bookings
        }
      };
    });

    res.json({
      message: 'Hotels retrieved successfully',
      data: {
        hotels: hotelsWithDetails,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: totalCount,
          pages: Math.ceil(totalCount / parseInt(limit))
        },
        filters: {
          status,
          search,
          sortBy: sortField,
          sortOrder: sortDirection
        }
      }
    });

  } catch (error) {
    console.error('Get all hotels detailed error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Suspend or Activate Hotel
const updateHotelStatus = async (req, res) => {
  try {
    const { hotelId } = req.params;
    const { action, reason } = req.body; // action: 'suspend' | 'activate'

    // Validation
    if (!['suspend', 'activate'].includes(action)) {
      return res.status(400).json({ 
        error: 'Invalid action',
        message: 'Action must be either "suspend" or "activate"'
      });
    }

    if (!reason || reason.trim().length < 5) {
      return res.status(400).json({ 
        error: 'Reason required',
        message: 'Please provide a reason (minimum 5 characters)'
      });
    }

    const hotel = await prisma.hotel.findUnique({
      where: { id: parseInt(hotelId) },
      include: {
        users: {
          where: { role: 'hotel_owner' },
          select: { name: true, email: true }
        }
      }
    });

    if (!hotel) {
      return res.status(404).json({ error: 'Hotel not found' });
    }

    // Check current status
    if (action === 'suspend' && !hotel.isActive) {
      return res.status(400).json({ 
        error: 'Hotel is already suspended' 
      });
    }

    if (action === 'activate' && hotel.isActive) {
      return res.status(400).json({ 
        error: 'Hotel is already active' 
      });
    }

    // Update hotel status
    const timestamp = new Date().toISOString();
    const actionNote = `[${timestamp}] ${action.toUpperCase()} by admin ${req.user.userId}: ${reason}`;
    
    const updatedHotel = await prisma.hotel.update({
      where: { id: parseInt(hotelId) },
      data: {
        isActive: action === 'activate',
        paymentHistory: hotel.paymentHistory 
          ? `${hotel.paymentHistory}\n${actionNote}`
          : actionNote
      }
    });

    // Log the action for audit trail
    console.log(`🏨 Admin Action: ${action} hotel "${hotel.name}" (ID: ${hotel.id}) by admin ${req.user.userId}. Reason: ${reason}`);

    // Send WebSocket notification to hotel users
    if (global.socketServer) {
      const notificationData = {
        type: 'hotel_status_changed',
        hotelId: hotel.id,
        hotelName: hotel.name,
        action,
        reason,
        adminId: req.user.userId,
        timestamp: new Date().toISOString()
      };
      
      if (action === 'suspend') {
        // Notify all hotel users about suspension
        global.socketServer.broadcastToHotel(hotel.id, 'hotel_suspended', notificationData);
      } else {
        // Notify about reactivation
        global.socketServer.broadcastToHotel(hotel.id, 'hotel_reactivated', notificationData);
      }
    }

    res.json({
      success: true,
      message: `Hotel ${action}d successfully`,
      data: {
        hotelId: updatedHotel.id,
        hotelName: updatedHotel.name,
        isActive: updatedHotel.isActive,
        action,
        reason,
        actionBy: req.user.userId,
        actionAt: timestamp
      }
    });

  } catch (error) {
    console.error('Update hotel status error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Update hotel subscription details
const updateHotelSubscription = async (req, res) => {
  try {
    const { hotelId } = req.params;
    const { subscriptionStatus, monthlyRate, subscriptionEndDate, notes } = req.body;

    // Validation
    const validStatuses = ['trial', 'active', 'expired'];
    if (subscriptionStatus && !validStatuses.includes(subscriptionStatus)) {
      return res.status(400).json({ 
        error: 'Invalid subscription status',
        validStatuses 
      });
    }

    if (monthlyRate && (isNaN(monthlyRate) || parseFloat(monthlyRate) < 0)) {
      return res.status(400).json({ 
        error: 'Invalid monthly rate',
        message: 'Monthly rate must be a positive number'
      });
    }

    if (subscriptionEndDate && new Date(subscriptionEndDate) < new Date()) {
      return res.status(400).json({ 
        error: 'Invalid subscription end date',
        message: 'End date cannot be in the past'
      });
    }

    const hotel = await prisma.hotel.findUnique({
      where: { id: parseInt(hotelId) }
    });

    if (!hotel) {
      return res.status(404).json({ error: 'Hotel not found' });
    }

    // Prepare update data
    const updateData = {};
    if (subscriptionStatus) updateData.subscriptionStatus = subscriptionStatus;
    if (monthlyRate) updateData.monthlyRate = parseFloat(monthlyRate);
    if (subscriptionEndDate) updateData.subscriptionEndDate = new Date(subscriptionEndDate);
    
    // Add notes to payment history
    if (notes || Object.keys(updateData).length > 0) {
      const timestamp = new Date().toISOString();
      const changes = Object.keys(updateData).map(key => 
        `${key}: ${updateData[key]}`
      ).join(', ');
      
      const historyNote = `[${timestamp}] Subscription updated by admin ${req.user.userId}` +
        (changes ? `: ${changes}` : '') +
        (notes ? `. Notes: ${notes}` : '');
        
      updateData.paymentHistory = hotel.paymentHistory 
        ? `${hotel.paymentHistory}\n${historyNote}`
        : historyNote;
    }

    const updatedHotel = await prisma.hotel.update({
      where: { id: parseInt(hotelId) },
      data: updateData
    });

    console.log(`💰 Subscription updated for hotel "${hotel.name}" (ID: ${hotel.id}) by admin ${req.user.userId}`);

    res.json({
      success: true,
      message: 'Hotel subscription updated successfully',
      data: {
        hotelId: updatedHotel.id,
        hotelName: updatedHotel.name,
        subscriptionStatus: updatedHotel.subscriptionStatus,
        monthlyRate: parseFloat(updatedHotel.monthlyRate),
        subscriptionEndDate: updatedHotel.subscriptionEndDate,
        updatedAt: new Date().toISOString()
      }
    });

  } catch (error) {
    console.error('Update hotel subscription error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Get detailed information for a specific hotel
const getHotelDetails = async (req, res) => {
  try {
    const { hotelId } = req.params;

    const hotel = await prisma.hotel.findUnique({
      where: { id: parseInt(hotelId) },
      include: {
        users: {
          select: {
            id: true,
            name: true,
            email: true,
            role: true,
            lastLogin: true,
            createdAt: true,
            isActive: true,
            firstLoginCompleted: true
          },
          orderBy: { createdAt: 'desc' }
        },
        rooms: {
          select: {
            id: true,
            roomNumber: true,
            status: true,
            createdAt: true,
            roomType: {
              select: {
                name: true,
                basePrice: true
              }
            }
          },
          orderBy: { roomNumber: 'asc' }
        },
        bookings: {
          where: {
            createdAt: {
              gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) // Last 30 days
            }
          },
          select: {
            id: true,
            status: true,
            finalAmount: true,
            checkInDate: true,
            checkOutDate: true,
            createdAt: true,
            guest: {
              select: {
                name: true,
                email: true
              }
            }
          },
          orderBy: { createdAt: 'desc' }
        }
      }
    });

    if (!hotel) {
      return res.status(404).json({ error: 'Hotel not found' });
    }

    // Calculate comprehensive statistics
    const now = new Date();
    const totalRevenue = hotel.bookings.reduce((sum, booking) => 
      sum + parseFloat(booking.finalAmount), 0
    );
    
    const roomsByStatus = hotel.rooms.reduce((acc, room) => {
      acc[room.status] = (acc[room.status] || 0) + 1;
      return acc;
    }, {});

    const usersByRole = hotel.users.reduce((acc, user) => {
      acc[user.role] = (acc[user.role] || 0) + 1;
      return acc;
    }, {});

    const activeUsers = hotel.users.filter(u => u.isActive).length;
    const usersNeedingSetup = hotel.users.filter(u => !u.firstLoginCompleted).length;

    // Calculate subscription details
    let daysRemaining = 0;
    let subscriptionStatus = hotel.subscriptionStatus;
    if (hotel.subscriptionEndDate) {
      daysRemaining = Math.ceil((hotel.subscriptionEndDate - now) / (1000 * 60 * 60 * 24));
      if (daysRemaining <= 0 && hotel.subscriptionStatus !== 'expired') {
        subscriptionStatus = 'expired';
      }
    }

    res.json({
      success: true,
      message: 'Hotel details retrieved successfully',
      data: {
        hotel: {
          id: hotel.id,
          name: hotel.name,
          address: hotel.address,
          phone: hotel.phone,
          ownerEmail: hotel.ownerEmail,
          subscriptionStatus,
          subscriptionEndDate: hotel.subscriptionEndDate,
          monthlyRate: parseFloat(hotel.monthlyRate) || 0,
          daysRemaining: Math.max(0, daysRemaining),
          isActive: hotel.isActive,
          createdAt: hotel.createdAt,
          lastReminderSent: hotel.lastReminderSent,
          paymentHistory: hotel.paymentHistory
        },
        users: hotel.users,
        rooms: hotel.rooms,
        recentBookings: hotel.bookings,
        statistics: {
          users: {
            total: hotel.users.length,
            active: activeUsers,
            needingSetup: usersNeedingSetup,
            byRole: usersByRole
          },
          rooms: {
            total: hotel.rooms.length,
            byStatus: roomsByStatus
          },
          bookings: {
            last30Days: hotel.bookings.length,
            revenueLast30Days: totalRevenue
          }
        }
      }
    });

  } catch (error) {
    console.error('Get hotel details error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Enhanced platform statistics
const getEnhancedPlatformStats = async (req, res) => {
  try {
    const stats = await prisma.$transaction(async (tx) => {
      // Basic counts
      const totalHotels = await tx.hotel.count();
      const activeHotels = await tx.hotel.count({
        where: { isActive: true }
      });
      const suspendedHotels = await tx.hotel.count({
        where: { isActive: false }
      });
      
      // Subscription status counts
      const trialHotels = await tx.hotel.count({
        where: { subscriptionStatus: 'trial', isActive: true }
      });
      const activeSubscriptions = await tx.hotel.count({
        where: { subscriptionStatus: 'active', isActive: true }
      });
      const expiredHotels = await tx.hotel.count({
        where: { subscriptionStatus: 'expired' }
      });
      
      // User counts
      const totalUsers = await tx.user.count({
        where: { role: { not: 'platform_admin' } }
      });
      const activeUsers = await tx.user.count({
        where: { 
          role: { not: 'platform_admin' },
          isActive: true 
        }
      });
      
      // Recent activity (last 30 days)
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const newHotelsLast30Days = await tx.hotel.count({
        where: { createdAt: { gte: thirtyDaysAgo } }
      });
      
      // Hotels needing attention (expiring soon)
      const sevenDaysFromNow = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      const hotelsExpiringSoon = await tx.hotel.count({
        where: {
          subscriptionEndDate: {
            lte: sevenDaysFromNow,
            gt: new Date()
          },
          isActive: true
        }
      });

      return {
        hotels: {
          total: totalHotels,
          active: activeHotels,
          suspended: suspendedHotels,
          trial: trialHotels,
          activeSubscriptions,
          expired: expiredHotels,
          expiringSoon: hotelsExpiringSoon,
          newLast30Days: newHotelsLast30Days
        },
        users: {
          total: totalUsers,
          active: activeUsers
        },
        generatedAt: new Date().toISOString()
      };
    });
    
    res.json({
      success: true,
      message: 'Enhanced platform statistics retrieved',
      data: stats
    });
    
  } catch (error) {
    console.error('Enhanced platform stats error:', error);
    res.status(500).json({
      error: 'Failed to retrieve platform statistics'
    });
  }
};

module.exports = {
  setupHotel,
  getPlatformStats,
  getAllHotelsDetailed,
  updateHotelStatus,
  updateHotelSubscription,
  getHotelDetails,
  getEnhancedPlatformStats
};