const { verifyToken, hasPermission } = require('../utils/auth');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

// Base authentication middleware - verifies JWT token
const authenticateToken = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    console.log('🔐 Auth header:', authHeader ? 'Present' : 'Missing');
    
    const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

    if (!token) {
      console.log('❌ No token provided');
      return res.status(401).json({ error: 'Access token required' });
    }

    console.log('🔐 Verifying token...');
    const decoded = verifyToken(token);
    console.log('🔐 Token decoded:', decoded);
    
    // Add user info to request
    req.user = decoded;
    console.log('🔐 req.user set to:', req.user);
    
    next();
  } catch (error) {
    console.error('Token verification error:', error);
    return res.status(403).json({ error: 'Invalid or expired token' });
  }
};

// Role-based access control middleware
const requireRole = (requiredRole) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    if (!hasPermission(req.user.role, requiredRole)) {
      return res.status(403).json({ 
        error: 'Insufficient permissions',
        required: requiredRole,
        current: req.user.role
      });
    }

    next();
  };
};

// Tenant isolation middleware - ensures users only access their hotel's data
const requireTenantAccess = async (req, res, next) => {
  try {
    console.log('🔐 Tenant access check - req.user:', req.user);
    
    if (!req.user) {
      console.log('❌ No req.user found');
      return res.status(401).json({ error: 'Authentication required' });
    }

    // Platform admin can access all hotels
    if (req.user.role === 'platform_admin') {
      console.log('✅ Platform admin access granted');
      return next();
    }

    // Hotel-level users must have hotelId
    if (!req.user.hotelId) {
      console.log('❌ No hotelId for user:', req.user);
      return res.status(403).json({ error: 'No hotel assigned to user' });
    }

    // Check if hotelId is provided in request (params, body, or query)
    const requestedHotelId = parseInt(req.params.hotelId) || 
                             parseInt(req.body?.hotelId) || 
                             parseInt(req.query?.hotelId);

    console.log('🔐 Requested hotelId:', requestedHotelId, 'User hotelId:', req.user.hotelId);

    // If a specific hotel is requested, ensure user belongs to that hotel
    if (requestedHotelId && requestedHotelId !== req.user.hotelId) {
      console.log('❌ Access denied - user belongs to different hotel');
      return res.status(403).json({ error: 'Access denied to this hotel' });
    }

    // Add user's hotelId to request if not present
    if (!requestedHotelId) {
      if (req.body) req.body.hotelId = req.user.hotelId;
      if (req.query) req.query.hotelId = req.user.hotelId;
      console.log('✅ Added user hotelId to request');
    }

    next();
  } catch (error) {
    console.error('Tenant access error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Platform admin only middleware
const requirePlatformAdmin = [
  authenticateToken,
  requireRole('platform_admin')
];

// Hotel owner or above middleware
const requireHotelOwner = [
  authenticateToken,
  requireRole('hotel_owner'),
  requireTenantAccess
];

// Hotel manager or above middleware
const requireHotelManager = [
  authenticateToken,
  requireRole('hotel_manager'),
  requireTenantAccess
];

// Front desk or above middleware (any hotel staff)
const requireHotelStaff = [
  authenticateToken,
  requireRole('front_desk'),
  requireTenantAccess
];

// Middleware to check subscription status for hotel users
const checkSubscription = async (req, res, next) => {
  try {
    if (!req.user || req.user.role === 'platform_admin') {
      return next();
    }

    if (!req.user.hotelId) {
      return res.status(403).json({ error: 'No hotel assigned' });
    }

    const hotel = await prisma.hotel.findUnique({
      where: { id: req.user.hotelId },
      select: {
        subscriptionStatus: true,
        subscriptionEndDate: true,
        isActive: true
      }
    });

    if (!hotel) {
      return res.status(404).json({ error: 'Hotel not found' });
    }

    if (!hotel.isActive) {
      return res.status(403).json({ error: 'Hotel account is deactivated' });
    }

    if (hotel.subscriptionStatus === 'expired' || hotel.subscriptionStatus === 'suspended') {
      return res.status(403).json({ error: 'Hotel subscription is not active' });
    }

    next();
  } catch (error) {
    console.error('Subscription check error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Middleware factory for specific permission checks
const requirePermission = (permission) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    // Define permission mappings
    const permissions = {
      'create_users': ['platform_admin', 'hotel_owner'],
      'manage_rooms': ['hotel_owner', 'hotel_manager'],
      'manage_bookings': ['hotel_owner', 'hotel_manager', 'front_desk'],
      'manage_tasks': ['hotel_owner', 'hotel_manager'],
      'view_reports': ['hotel_owner', 'hotel_manager'],
      'manage_pricing': ['hotel_owner'],
      'approve_discounts': ['hotel_owner', 'hotel_manager']
    };

    const allowedRoles = permissions[permission];
    if (!allowedRoles || !allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ 
        error: 'Insufficient permissions for this action',
        required: permission
      });
    }

    next();
  };
};

module.exports = {
  authenticateToken,
  requireRole,
  requireTenantAccess,
  requirePlatformAdmin,
  requireHotelOwner,
  requireHotelManager,
  requireHotelStaff,
  checkSubscription,
  requirePermission
};