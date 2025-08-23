const { PrismaClient } = require('@prisma/client');
const { z } = require('zod');

const prisma = new PrismaClient();

// Validation schemas
const createGuestSchema = z.object({
  name: z.string()
    .min(2, 'Guest name must be at least 2 characters')
    .max(100, 'Guest name too long'),
  email: z.string()
    .email('Invalid email format')
    .optional()
    .nullable(),
  phone: z.string()
    .min(10, 'Phone number must be at least 10 characters')
    .max(20, 'Phone number too long'),
  address: z.string()
    .min(10, 'Address must be at least 10 characters')
    .max(500, 'Address too long'),
  organization: z.string()
    .max(255, 'Organization name too long')
    .optional()
    .nullable(),
  guestType: z.enum(['individual', 'corporate'])
    .default('individual'),
  idType: z.string()
    .min(2, 'ID type is required')
    .max(50, 'ID type too long'),
  idNumber: z.string()
    .min(5, 'ID number must be at least 5 characters')
    .max(100, 'ID number too long')
});

const updateGuestSchema = createGuestSchema.partial();

// Create a new guest
const createGuest = async (req, res) => {
  try {
    const guestData = createGuestSchema.parse(req.body);
    
    // Get hotelId from authenticated user or request
    const hotelId = req.user.hotelId || parseInt(req.body.hotelId);
    
    if (!hotelId) {
      return res.status(400).json({ error: 'Hotel ID is required' });
    }

    // Check if guest with same phone already exists in this hotel
    const existingGuest = await prisma.guest.findFirst({
      where: {
        hotelId,
        phone: guestData.phone
      }
    });

    if (existingGuest) {
      return res.status(409).json({ 
        error: 'Guest with this phone number already exists',
        existingGuest: {
          id: existingGuest.id,
          name: existingGuest.name,
          phone: existingGuest.phone
        }
      });
    }

    // Create guest
    const guest = await prisma.guest.create({
      data: {
        ...guestData,
        hotelId,
        email: guestData.email || null,
        organization: guestData.organization || null
      }
    });

    res.status(201).json({
      message: 'Guest created successfully',
      guest
    });

  } catch (error) {
    console.error('Create guest error:', error);
    
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        error: 'Validation failed',
        details: error.errors.map(err => ({
          field: err.path.join('.'),
          message: err.message
        }))
      });
    }

    res.status(500).json({ error: 'Internal server error' });
  }
};

// Get all guests for a hotel
const getGuests = async (req, res) => {
  try {
    const hotelId = req.user.hotelId || parseInt(req.query.hotelId);
    
    if (!hotelId) {
      return res.status(400).json({ error: 'Hotel ID is required' });
    }

    const { page = 1, limit = 20, search } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    // Build search filter
    const searchFilter = search ? {
      OR: [
        { name: { contains: search, mode: 'insensitive' } },
        { phone: { contains: search } },
        { email: { contains: search, mode: 'insensitive' } },
        { idNumber: { contains: search } }
      ]
    } : {};

    const whereClause = {
      hotelId,
      ...searchFilter
    };

    // Get guests with pagination
    const [guests, totalCount] = await prisma.$transaction([
      prisma.guest.findMany({
        where: whereClause,
        skip,
        take: parseInt(limit),
        orderBy: { createdAt: 'desc' },
        include: {
          bookings: {
            select: {
              id: true,
              checkInDate: true,
              checkOutDate: true,
              status: true
            },
            orderBy: { createdAt: 'desc' },
            take: 1 // Most recent booking
          }
        }
      }),
      prisma.guest.count({ where: whereClause })
    ]);

    res.json({
      message: 'Guests retrieved successfully',
      guests,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: totalCount,
        totalPages: Math.ceil(totalCount / parseInt(limit))
      }
    });

  } catch (error) {
    console.error('Get guests error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Get a specific guest by ID
const getGuestById = async (req, res) => {
  try {
    const { guestId } = req.params;
    const hotelId = req.user.hotelId;

    const guest = await prisma.guest.findFirst({
      where: {
        id: parseInt(guestId),
        hotelId // Ensure tenant isolation
      },
      include: {
        bookings: {
          include: {
            room: {
              select: {
                id: true,
                roomNumber: true,
                roomType: {
                  select: {
                    name: true
                  }
                }
              }
            }
          },
          orderBy: { createdAt: 'desc' }
        },
        preferences: true,
        roomServiceOrders: {
          orderBy: { orderedAt: 'desc' },
          take: 10
        }
      }
    });

    if (!guest) {
      return res.status(404).json({ error: 'Guest not found' });
    }

    res.json({
      message: 'Guest retrieved successfully',
      guest
    });

  } catch (error) {
    console.error('Get guest by ID error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Update guest information
const updateGuest = async (req, res) => {
  try {
    const { guestId } = req.params;
    const hotelId = req.user.hotelId;
    
    const updateData = updateGuestSchema.parse(req.body);

    // Check if guest exists and belongs to hotel
    const existingGuest = await prisma.guest.findFirst({
      where: {
        id: parseInt(guestId),
        hotelId
      }
    });

    if (!existingGuest) {
      return res.status(404).json({ error: 'Guest not found' });
    }

    // If phone is being updated, check for conflicts
    if (updateData.phone && updateData.phone !== existingGuest.phone) {
      const phoneConflict = await prisma.guest.findFirst({
        where: {
          hotelId,
          phone: updateData.phone,
          id: { not: parseInt(guestId) }
        }
      });

      if (phoneConflict) {
        return res.status(409).json({ 
          error: 'Another guest with this phone number already exists' 
        });
      }
    }

    // Update guest
    const updatedGuest = await prisma.guest.update({
      where: { id: parseInt(guestId) },
      data: updateData
    });

    res.json({
      message: 'Guest updated successfully',
      guest: updatedGuest
    });

  } catch (error) {
    console.error('Update guest error:', error);
    
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        error: 'Validation failed',
        details: error.errors.map(err => ({
          field: err.path.join('.'),
          message: err.message
        }))
      });
    }

    res.status(500).json({ error: 'Internal server error' });
  }
};

// Search guests by name or phone
const searchGuests = async (req, res) => {
  try {
    const { query } = req.query;
    const hotelId = req.user.hotelId;

    console.log('🔍 Search request:', { query, hotelId, fullQuery: req.query });

    // If no query provided, return empty results with helpful message
    if (!query) {
      return res.json({
        message: 'No search query provided',
        guests: [],
        hint: 'Use ?query=searchterm to search guests'
      });
    }

    if (query.length < 2) {
      return res.status(400).json({ 
        error: 'Search query must be at least 2 characters' 
      });
    }

    console.log('🔍 Searching for guests with query:', query, 'in hotel:', hotelId);

    const guests = await prisma.guest.findMany({
      where: {
        hotelId,
        OR: [
          { name: { contains: query, mode: 'insensitive' } },
          { phone: { contains: query } },
          { email: { contains: query, mode: 'insensitive' } }
        ]
      },
      select: {
        id: true,
        name: true,
        phone: true,
        email: true,
        guestType: true,
        organization: true,
        createdAt: true
      },
      orderBy: { name: 'asc' },
      take: 10 // Limit results for quick search
    });

    console.log('🔍 Search results:', guests.length, 'guests found');

    res.json({
      message: 'Guest search completed',
      guests,
      searchQuery: query,
      resultsCount: guests.length
    });

  } catch (error) {
    console.error('Search guests error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Get guest statistics
const getGuestStats = async (req, res) => {
  try {
    const hotelId = req.user.hotelId;

    const stats = await prisma.$transaction(async (tx) => {
      const totalGuests = await tx.guest.count({
        where: { hotelId }
      });

      const corporateGuests = await tx.guest.count({
        where: { 
          hotelId,
          guestType: 'corporate'
        }
      });

      const recentGuests = await tx.guest.count({
        where: {
          hotelId,
          createdAt: {
            gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) // Last 30 days
          }
        }
      });

      const activeBookings = await tx.booking.count({
        where: {
          hotelId,
          status: { in: ['confirmed', 'checked_in'] }
        }
      });

      return {
        totalGuests,
        corporateGuests,
        individualGuests: totalGuests - corporateGuests,
        recentGuests,
        activeBookings
      };
    });

    res.json({
      message: 'Guest statistics retrieved',
      stats
    });

  } catch (error) {
    console.error('Guest stats error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

module.exports = {
  createGuest,
  getGuests,
  getGuestById,
  updateGuest,
  searchGuests,
  getGuestStats
};