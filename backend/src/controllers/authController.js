const { PrismaClient } = require('@prisma/client');
const { hashPassword, comparePassword, generateToken } = require('../utils/auth');
const { z } = require('zod');

const prisma = new PrismaClient();

const loginSchema = z.object({
  email: z.string().email('Invalid email format'),
  password: z.string().min(6, 'Password must be at least 6 characters')
});

const login = async (req, res) => {
  try {
    const { email, password } = loginSchema.parse(req.body);

    // Find user by email
    const user = await prisma.user.findUnique({
      where: { email },
      include: {
        hotel: {
          select: {
            id: true,
            name: true,
            subscriptionStatus: true,
            subscriptionEndDate: true,
            isActive: true
          }
        }
      }
    });

    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    if (!user.isActive) {
      return res.status(401).json({ error: 'Account is deactivated' });
    }

    // Verify password
    const isPasswordValid = await comparePassword(password, user.passwordHash);
    if (!isPasswordValid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Check hotel subscription for hotel-level users
    if (user.hotelId && user.hotel) {
      if (!user.hotel.isActive) {
        return res.status(403).json({ error: 'Hotel account is deactivated' });
      }
      
      if (user.hotel.subscriptionStatus === 'expired' || 
          user.hotel.subscriptionStatus === 'suspended') {
        return res.status(403).json({ error: 'Hotel subscription is not active' });
      }
    }

    // Generate JWT token
    const tokenPayload = {
      userId: user.id,
      email: user.email,
      role: user.role,
      hotelId: user.hotelId,
      hotelName: user.hotel?.name || null,
      firstLoginCompleted: user.firstLoginCompleted
    };

    const token = generateToken(tokenPayload);

    // Update last login
    await prisma.user.update({
      where: { id: user.id },
      data: { lastLogin: new Date() }
    });

    // Return response without password
    const userResponse = {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      hotelId: user.hotelId,
      hotelName: user.hotel?.name || null,
      firstLoginCompleted: user.firstLoginCompleted
    };

    res.json({
      message: 'Login successful',
      token,
      user: userResponse
    });

  } catch (error) {
    console.error('Login error:', error);
    
    if (error instanceof z.ZodError) {
      return res.status(400).json({ 
        error: 'Validation failed',
        details: error.errors 
      });
    }

    res.status(500).json({ error: 'Internal server error' });
  }
};

const createUser = async (req, res) => {
  try {
    const { email, password, name, phone, role, hotelId, createdById } = req.body;

    // Validation
    if (!email || !password || !name || !role) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Check if email already exists
    const existingUser = await prisma.user.findUnique({
      where: { email }
    });

    if (existingUser) {
      return res.status(400).json({ error: 'Email already exists' });
    }

    // Validate role
    const validRoles = ['platform_admin', 'hotel_owner', 'hotel_manager', 'front_desk'];
    if (!validRoles.includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }

    // Platform admin shouldn't have hotelId
    if (role === 'platform_admin' && hotelId) {
      return res.status(400).json({ error: 'Platform admin cannot be assigned to a hotel' });
    }

    // Hotel-level users must have hotelId
    if (role !== 'platform_admin' && !hotelId) {
      return res.status(400).json({ error: 'Hotel users must be assigned to a hotel' });
    }

    // Hash password
    const passwordHash = await hashPassword(password);

    // Create user
    const newUser = await prisma.user.create({
      data: {
        email,
        passwordHash,
        name,
        phone,
        role,
        hotelId: hotelId || null,
        createdById: createdById || null
      },
      include: {
        hotel: {
          select: {
            id: true,
            name: true
          }
        }
      }
    });

    // Return user without password
    const userResponse = {
      id: newUser.id,
      email: newUser.email,
      name: newUser.name,
      phone: newUser.phone,
      role: newUser.role,
      hotelId: newUser.hotelId,
      hotelName: newUser.hotel?.name || null,
      firstLoginCompleted: newUser.firstLoginCompleted,
      createdAt: newUser.createdAt
    };

    res.status(201).json({
      message: 'User created successfully',
      user: userResponse
    });

  } catch (error) {
    console.error('Create user error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

const resetPassword = async (req, res) => {
  try {
    const { userId } = req.params;
    const { newPassword } = req.body;

    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    const passwordHash = await hashPassword(newPassword);

    await prisma.user.update({
      where: { id: parseInt(userId) },
      data: { 
        passwordHash,
        firstLoginCompleted: true
      }
    });

    res.json({ message: 'Password reset successfully' });

  } catch (error) {
    console.error('Reset password error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

const validateToken = async (req, res) => {
  try {
    // Token validation is handled by middleware
    // If we reach here, token is valid
    
    const user = await prisma.user.findUnique({
      where: { id: req.user.userId },
      include: {
        hotel: {
          select: {
            id: true,
            name: true,
            subscriptionStatus: true,
            isActive: true
          }
        }
      }
    });

    if (!user || !user.isActive) {
      return res.status(401).json({ error: 'User not found or deactivated' });
    }

    const userResponse = {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      hotelId: user.hotelId,
      hotelName: user.hotel?.name || null,
      firstLoginCompleted: user.firstLoginCompleted
    };

    res.json({
      valid: true,
      user: userResponse
    });

  } catch (error) {
    console.error('Token validation error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

module.exports = {
  login,
  createUser,
  resetPassword,
  validateToken
};