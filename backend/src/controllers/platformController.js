const { PrismaClient } = require('@prisma/client');
const { z } = require('zod');
const { hashPassword } = require('../utils/auth');

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

module.exports = {
  setupHotel,
  getPlatformStats
};