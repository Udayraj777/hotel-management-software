const { PrismaClient } = require('@prisma/client');
const { z } = require('zod');

const prisma = new PrismaClient();

const createRoomTypeSchema = z.object({
  name: z.string()
    .min(2, 'Room type name must be at least 2 characters')
    .max(100, 'Room type name too long')
    .regex(/^[a-zA-Z0-9\s&.-]+$/, 'Room type name contains invalid characters'),
  basePrice: z.number()
    .positive('Base price must be positive')
    .max(999999.99, 'Base price too high'),
  description: z.string().max(500, 'Description too long').optional().nullable(),
  amenities: z.string().max(1000, 'Amenities list too long').optional().nullable()
});

const updateRoomTypeSchema = createRoomTypeSchema.partial();

// Create room type
const createRoomType = async (req, res) => {
  try {
    const hotelId = req.user.hotelId;
    const roomTypeData = createRoomTypeSchema.parse(req.body);

    // Check if room type name already exists in this hotel
    const existingType = await prisma.roomType.findFirst({
      where: {
        hotelId,
        name: {
          equals: roomTypeData.name,
          mode: 'insensitive'
        }
      }
    });

    if (existingType) {
      return res.status(409).json({
        error: 'Room type already exists',
        message: `Room type '${roomTypeData.name}' already exists in your hotel`
      });
    }

    const roomType = await prisma.roomType.create({
      data: {
        name: roomTypeData.name,
        basePrice: roomTypeData.basePrice,
        description: roomTypeData.description || null,
        amenities: roomTypeData.amenities || null,
        hotelId
      }
    });

    res.status(201).json({
      message: 'Room type created successfully',
      roomType: {
        id: roomType.id,
        name: roomType.name,
        basePrice: roomType.basePrice,
        description: roomType.description,
        amenities: roomType.amenities,
        createdAt: roomType.createdAt
      }
    });

  } catch (error) {
    console.error('Create room type error:', error);
    
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

// Get all room types for hotel
const getRoomTypes = async (req, res) => {
  try {
    const hotelId = req.user.hotelId;

    const roomTypes = await prisma.roomType.findMany({
      where: { hotelId },
      include: {
        rooms: {
          select: {
            id: true,
            roomNumber: true,
            status: true
          }
        },
        _count: {
          select: {
            rooms: true
          }
        }
      },
      orderBy: [
        { basePrice: 'asc' },
        { name: 'asc' }
      ]
    });

    const roomTypesWithStats = roomTypes.map(type => ({
      ...type,
      totalRooms: type._count.rooms,
      availableRooms: type.rooms.filter(r => r.status === 'available').length,
      occupiedRooms: type.rooms.filter(r => r.status === 'occupied').length,
      dirtyRooms: type.rooms.filter(r => r.status === 'dirty').length,
      cleaningRooms: type.rooms.filter(r => r.status === 'cleaning').length,
      oooRooms: type.rooms.filter(r => r.status === 'out_of_order').length
    }));

    res.json({
      message: 'Room types retrieved successfully',
      roomTypes: roomTypesWithStats
    });

  } catch (error) {
    console.error('Get room types error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Get single room type
const getRoomType = async (req, res) => {
  try {
    const hotelId = req.user.hotelId;
    const roomTypeId = parseInt(req.params.id);

    const roomType = await prisma.roomType.findFirst({
      where: {
        id: roomTypeId,
        hotelId
      },
      include: {
        rooms: {
          select: {
            id: true,
            roomNumber: true,
            floor: true,
            status: true,
            lastUpdated: true,
            notes: true
          },
          orderBy: { roomNumber: 'asc' }
        },
        roomPricings: {
          where: {
            isActive: true,
            endDate: { gte: new Date() }
          },
          orderBy: { effectiveDate: 'desc' },
          take: 5
        }
      }
    });

    if (!roomType) {
      return res.status(404).json({ error: 'Room type not found' });
    }

    res.json({
      message: 'Room type retrieved successfully',
      roomType
    });

  } catch (error) {
    console.error('Get room type error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Update room type
const updateRoomType = async (req, res) => {
  try {
    const hotelId = req.user.hotelId;
    const roomTypeId = parseInt(req.params.id);
    const updateData = updateRoomTypeSchema.parse(req.body);

    // Check if room type exists and belongs to hotel
    const existingType = await prisma.roomType.findFirst({
      where: {
        id: roomTypeId,
        hotelId
      }
    });

    if (!existingType) {
      return res.status(404).json({ error: 'Room type not found' });
    }

    // Check for name conflicts if name is being updated
    if (updateData.name && updateData.name !== existingType.name) {
      const nameConflict = await prisma.roomType.findFirst({
        where: {
          hotelId,
          name: {
            equals: updateData.name,
            mode: 'insensitive'
          },
          id: { not: roomTypeId }
        }
      });

      if (nameConflict) {
        return res.status(409).json({
          error: 'Name conflict',
          message: `Room type '${updateData.name}' already exists`
        });
      }
    }

    const updatedRoomType = await prisma.roomType.update({
      where: { id: roomTypeId },
      data: updateData
    });

    res.json({
      message: 'Room type updated successfully',
      roomType: updatedRoomType
    });

  } catch (error) {
    console.error('Update room type error:', error);
    
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

// Delete room type
const deleteRoomType = async (req, res) => {
  try {
    const hotelId = req.user.hotelId;
    const roomTypeId = parseInt(req.params.id);

    // Check if room type exists and belongs to hotel
    const roomType = await prisma.roomType.findFirst({
      where: {
        id: roomTypeId,
        hotelId
      },
      include: {
        _count: {
          select: { rooms: true }
        }
      }
    });

    if (!roomType) {
      return res.status(404).json({ error: 'Room type not found' });
    }

    // Check if room type has rooms
    if (roomType._count.rooms > 0) {
      return res.status(400).json({
        error: 'Cannot delete room type',
        message: `Room type has ${roomType._count.rooms} rooms. Remove all rooms first.`
      });
    }

    await prisma.roomType.delete({
      where: { id: roomTypeId }
    });

    res.json({ message: 'Room type deleted successfully' });

  } catch (error) {
    console.error('Delete room type error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

module.exports = {
  createRoomType,
  getRoomTypes,
  getRoomType,
  updateRoomType,
  deleteRoomType
};