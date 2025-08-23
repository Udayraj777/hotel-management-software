const { PrismaClient } = require('@prisma/client');
const { z } = require('zod');
const { hashPassword } = require('../utils/auth');

const prisma = new PrismaClient();

const createStaffSchema = z.object({
  email: z.string().email('Invalid email format'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  name: z.string().min(2, 'Name must be at least 2 characters'),
  phone: z.string().optional(),
  role: z.enum(['hotel_manager', 'front_desk'], {
    errorMap: () => ({ message: 'Role must be hotel_manager or front_desk' })
  })
});

// Hotel owner creates staff
const createStaff = async (req, res) => {
  try {
    const { email, password, name, phone, role } = createStaffSchema.parse(req.body);
    const hotelId = req.user.hotelId;

    // Check if email already exists
    const existingUser = await prisma.user.findUnique({
      where: { email }
    });

    if (existingUser) {
      return res.status(409).json({ error: 'Email already exists' });
    }

    // Hash password
    const passwordHash = await hashPassword(password);

    // Create staff user
    const staff = await prisma.user.create({
      data: {
        email,
        passwordHash,
        name,
        phone,
        role,
        hotelId,
        createdById: req.user.userId,
        firstLoginCompleted: false
      },
      include: {
        hotel: {
          select: { name: true }
        }
      }
    });

    res.status(201).json({
      message: 'Staff member created successfully',
      user: {
        id: staff.id,
        email: staff.email,
        name: staff.name,
        role: staff.role,
        hotelId: staff.hotelId,
        hotelName: staff.hotel.name,
        firstLoginCompleted: staff.firstLoginCompleted
      }
    });

  } catch (error) {
    console.error('Create staff error:', error);
    
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        error: 'Validation failed',
        details: error.errors
      });
    }

    res.status(500).json({ error: 'Internal server error' });
  }
};

// Get all hotel staff
const getHotelStaff = async (req, res) => {
  try {
    const hotelId = req.user.hotelId;

    const staff = await prisma.user.findMany({
      where: {
        hotelId,
        role: { in: ['hotel_owner', 'hotel_manager', 'front_desk'] }
      },
      select: {
        id: true,
        email: true,
        name: true,
        phone: true,
        role: true,
        isActive: true,
        lastLogin: true,
        firstLoginCompleted: true,
        createdAt: true
      },
      orderBy: [
        { role: 'asc' },
        { createdAt: 'desc' }
      ]
    });

    res.json({
      message: 'Hotel staff retrieved successfully',
      staff
    });

  } catch (error) {
    console.error('Get hotel staff error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Update staff member
const updateStaff = async (req, res) => {
  try {
    const staffId = parseInt(req.params.id);
    const { name, phone, isActive } = req.body;
    const hotelId = req.user.hotelId;

    // Ensure staff belongs to same hotel
    const existingStaff = await prisma.user.findFirst({
      where: {
        id: staffId,
        hotelId,
        role: { in: ['hotel_manager', 'front_desk'] }
      }
    });

    if (!existingStaff) {
      return res.status(404).json({ error: 'Staff member not found' });
    }

    const updatedStaff = await prisma.user.update({
      where: { id: staffId },
      data: {
        ...(name && { name }),
        ...(phone !== undefined && { phone }),
        ...(isActive !== undefined && { isActive })
      },
      select: {
        id: true,
        email: true,
        name: true,
        phone: true,
        role: true,
        isActive: true
      }
    });

    res.json({
      message: 'Staff member updated successfully',
      staff: updatedStaff
    });

  } catch (error) {
    console.error('Update staff error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Change user's own password
const changePassword = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const userId = req.user.userId;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Current and new passwords are required' });
    }

    if (newPassword.length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters' });
    }

    // Get current user
    const user = await prisma.user.findUnique({
      where: { id: userId }
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Verify current password
    const bcrypt = require('bcryptjs');
    const isCurrentPasswordValid = await bcrypt.compare(currentPassword, user.passwordHash);
    
    if (!isCurrentPasswordValid) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    // Hash new password
    const newPasswordHash = await hashPassword(newPassword);

    // Update password
    await prisma.user.update({
      where: { id: userId },
      data: {
        passwordHash: newPasswordHash,
        firstLoginCompleted: true
      }
    });

    res.json({ message: 'Password changed successfully' });

  } catch (error) {
    console.error('Change password error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Get user's own profile
const getProfile = async (req, res) => {
  try {
    const userId = req.user.userId;

    const user = await prisma.user.findUnique({
      where: { id: userId },
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

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({
      message: 'Profile retrieved successfully',
      profile: {
        id: user.id,
        email: user.email,
        name: user.name,
        phone: user.phone,
        role: user.role,
        hotelId: user.hotelId,
        hotel: user.hotel,
        firstLoginCompleted: user.firstLoginCompleted,
        lastLogin: user.lastLogin,
        createdAt: user.createdAt
      }
    });

  } catch (error) {
    console.error('Get profile error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Update user's own profile
const updateProfile = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { name, phone } = req.body;

    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: {
        ...(name && { name }),
        ...(phone !== undefined && { phone })
      },
      select: {
        id: true,
        email: true,
        name: true,
        phone: true,
        role: true
      }
    });

    res.json({
      message: 'Profile updated successfully',
      profile: updatedUser
    });

  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

module.exports = {
  createStaff,
  getHotelStaff,
  updateStaff,
  changePassword,
  getProfile,
  updateProfile
};