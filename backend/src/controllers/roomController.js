const { PrismaClient } = require('@prisma/client');
const { z } = require('zod');

const prisma = new PrismaClient();

// Room status enum
const ROOM_STATUSES = [
  'available',    // Ready for new guest
  'occupied',     // Guest currently staying
  'dirty',        // Needs cleaning after checkout
  'cleaning',     // Currently being cleaned
  'out_of_order', // Maintenance required
  'blocked'       // Blocked for maintenance/renovation
];

const createRoomSchema = z.object({
  roomTypeId: z.number().int().positive('Room type ID is required'),
  roomNumber: z.string()
    .min(1, 'Room number is required')
    .max(10, 'Room number too long')
    .regex(/^[A-Z0-9-]+$/i, 'Room number can only contain letters, numbers, and hyphens'),
  floor: z.string().max(20, 'Floor description too long').optional(),
  notes: z.string().max(500, 'Notes too long').optional()
});

const updateRoomSchema = z.object({
  roomTypeId: z.number().int().positive().optional(),
  roomNumber: z.string()
    .min(1).max(10)
    .regex(/^[A-Z0-9-]+$/i).optional(),
  floor: z.string().max(20).optional(),
  notes: z.string().max(500).optional()
});

const updateStatusSchema = z.object({
  status: z.enum(ROOM_STATUSES, {
    errorMap: () => ({ message: `Status must be one of: ${ROOM_STATUSES.join(', ')}` })
  }),
  notes: z.string().max(500).optional()
});

// Create physical room
const createRoom = async (req, res) => {
  try {
    const hotelId = req.user.hotelId;
    const roomData = createRoomSchema.parse(req.body);

    // Verify room type belongs to hotel
    const roomType = await prisma.roomType.findFirst({
      where: {
        id: roomData.roomTypeId,
        hotelId
      }
    });

    if (!roomType) {
      return res.status(404).json({
        error: 'Room type not found',
        message: 'Selected room type does not exist in your hotel'
      });
    }

    // Check if room number already exists
    const existingRoom = await prisma.room.findUnique({
      where: {
        hotelId_roomNumber: {
          hotelId,
          roomNumber: roomData.roomNumber
        }
      }
    });

    if (existingRoom) {
      return res.status(409).json({
        error: 'Room number already exists',
        message: `Room ${roomData.roomNumber} already exists in your hotel`
      });
    }

    const room = await prisma.room.create({
      data: {
        ...roomData,
        hotelId,
        status: 'available' // Default status
      },
      include: {
        roomType: {
          select: {
            id: true,
            name: true,
            basePrice: true
          }
        }
      }
    });

    res.status(201).json({
      message: 'Room created successfully',
      room: {
        id: room.id,
        roomNumber: room.roomNumber,
        floor: room.floor,
        status: room.status,
        notes: room.notes,
        roomType: room.roomType,
        createdAt: room.createdAt
      }
    });

  } catch (error) {
    console.error('Create room error:', error);
    
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

// Get all rooms for hotel
const getRooms = async (req, res) => {
  try {
    const hotelId = req.user.hotelId;
    const { status, roomTypeId, floor } = req.query;

    // Build filter conditions
    const whereConditions = { hotelId };
    
    if (status && ROOM_STATUSES.includes(status)) {
      whereConditions.status = status;
    }
    
    if (roomTypeId) {
      whereConditions.roomTypeId = parseInt(roomTypeId);
    }
    
    if (floor) {
      whereConditions.floor = floor;
    }

    const rooms = await prisma.room.findMany({
      where: whereConditions,
      include: {
        roomType: {
          select: {
            id: true,
            name: true,
            basePrice: true,
            description: true,
            amenities: true
          }
        },
        bookings: {
          where: {
            status: 'confirmed',
            checkOutDate: { gte: new Date() }
          },
          select: {
            id: true,
            checkInDate: true,
            checkOutDate: true,
            guest: {
              select: {
                name: true,
                phone: true
              }
            }
          },
          orderBy: { checkInDate: 'asc' }
        }
      },
      orderBy: [
        { floor: 'asc' },
        { roomNumber: 'asc' }
      ]
    });

    // Group rooms by status for summary
    const statusSummary = ROOM_STATUSES.reduce((acc, status) => {
      acc[status] = rooms.filter(room => room.status === status).length;
      return acc;
    }, {});

    res.json({
      message: 'Rooms retrieved successfully',
      summary: {
        total: rooms.length,
        byStatus: statusSummary
      },
      rooms
    });

  } catch (error) {
    console.error('Get rooms error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Get single room
const getRoom = async (req, res) => {
  try {
    const hotelId = req.user.hotelId;
    const roomId = parseInt(req.params.id);

    const room = await prisma.room.findFirst({
      where: {
        id: roomId,
        hotelId
      },
      include: {
        roomType: true,
        bookings: {
          where: {
            OR: [
              { status: 'confirmed' },
              { status: 'checked_in' }
            ]
          },
          include: {
            guest: {
              select: {
                name: true,
                phone: true,
                email: true
              }
            }
          },
          orderBy: { checkInDate: 'desc' },
          take: 10
        },
        tasks: {
          where: {
            status: { not: 'completed' }
          },
          include: {
            assignedTo: {
              select: {
                name: true
              }
            }
          },
          orderBy: { createdAt: 'desc' }
        }
      }
    });

    if (!room) {
      return res.status(404).json({ error: 'Room not found' });
    }

    res.json({
      message: 'Room retrieved successfully',
      room
    });

  } catch (error) {
    console.error('Get room error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Update room details
const updateRoom = async (req, res) => {
  try {
    const hotelId = req.user.hotelId;
    const roomId = parseInt(req.params.id);
    const updateData = updateRoomSchema.parse(req.body);

    // Check room exists and belongs to hotel
    const existingRoom = await prisma.room.findFirst({
      where: {
        id: roomId,
        hotelId
      }
    });

    if (!existingRoom) {
      return res.status(404).json({ error: 'Room not found' });
    }

    // If updating room type, verify it belongs to hotel
    if (updateData.roomTypeId) {
      const roomType = await prisma.roomType.findFirst({
        where: {
          id: updateData.roomTypeId,
          hotelId
        }
      });

      if (!roomType) {
        return res.status(404).json({ error: 'Room type not found' });
      }
    }

    // If updating room number, check for conflicts
    if (updateData.roomNumber && updateData.roomNumber !== existingRoom.roomNumber) {
      const conflictRoom = await prisma.room.findUnique({
        where: {
          hotelId_roomNumber: {
            hotelId,
            roomNumber: updateData.roomNumber
          }
        }
      });

      if (conflictRoom) {
        return res.status(409).json({
          error: 'Room number conflict',
          message: `Room ${updateData.roomNumber} already exists`
        });
      }
    }

    const updatedRoom = await prisma.room.update({
      where: { id: roomId },
      data: updateData,
      include: {
        roomType: {
          select: {
            id: true,
            name: true,
            basePrice: true
          }
        }
      }
    });

    res.json({
      message: 'Room updated successfully',
      room: updatedRoom
    });

  } catch (error) {
    console.error('Update room error:', error);
    
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

// Update room status (the core workflow)
const updateRoomStatus = async (req, res) => {
  try {
    const hotelId = req.user.hotelId;
    const roomId = parseInt(req.params.id);
    const { status, notes } = updateStatusSchema.parse(req.body);

    // Check room exists and belongs to hotel
    const room = await prisma.room.findFirst({
      where: {
        id: roomId,
        hotelId
      }
    });

    if (!room) {
      return res.status(404).json({ error: 'Room not found' });
    }

    // Status transition validation
    const currentStatus = room.status;
    const isValidTransition = validateStatusTransition(currentStatus, status);

    if (!isValidTransition) {
      return res.status(400).json({
        error: 'Invalid status transition',
        message: `Cannot change from '${currentStatus}' to '${status}'`,
        currentStatus,
        requestedStatus: status,
        allowedTransitions: getAllowedTransitions(currentStatus)
      });
    }

    // Update room status
    const updatedRoom = await prisma.room.update({
      where: { id: roomId },
      data: {
        status,
        notes: notes || room.notes,
        lastUpdated: new Date()
      },
      include: {
        roomType: {
          select: {
            name: true
          }
        }
      }
    });

    // Log the status change
    console.log(`Room ${updatedRoom.roomNumber} status changed: ${currentStatus} → ${status} by user ${req.user.userId}`);

    // 🔌 WEBSOCKET: Broadcast room status change to all hotel users
    if (global.socketServer) {
      const roomUpdateData = {
        roomId: updatedRoom.id,
        roomNumber: updatedRoom.roomNumber,
        status: updatedRoom.status,
        previousStatus: currentStatus,
        notes: updatedRoom.notes,
        roomType: updatedRoom.roomType?.name,
        lastUpdated: updatedRoom.lastUpdated,
        updatedBy: {
          userId: req.user.userId,
          userName: req.user.name,
          userRole: req.user.role
        }
      };

      // Broadcast to all hotel staff for awareness
      global.socketServer.broadcastToHotel(hotelId, 'room_status_updated', roomUpdateData);
      
      // Send targeted notifications based on status change
      if (status === 'available' && currentStatus === 'cleaning') {
        // Room is now ready - notify front desk
        global.socketServer.broadcastToRole(hotelId, 'front_desk', 'room_ready_for_booking', roomUpdateData);
        global.socketServer.broadcastToRole(hotelId, 'hotel_manager', 'room_ready_for_booking', roomUpdateData);
      } else if (status === 'dirty' && currentStatus === 'occupied') {
        // Guest checked out - notify housekeeping
        global.socketServer.broadcastToRole(hotelId, 'housekeeping', 'room_needs_cleaning', roomUpdateData);
      } else if (status === 'cleaning') {
        // Housekeeping started cleaning - notify managers
        global.socketServer.broadcastToRole(hotelId, 'hotel_manager', 'cleaning_started', roomUpdateData);
      } else if (status === 'maintenance') {
        // Room needs maintenance - notify all staff
        global.socketServer.broadcastToHotel(hotelId, 'room_maintenance_required', roomUpdateData);
      }
      
      console.log(`📡 WebSocket: Room ${updatedRoom.roomNumber} status change broadcasted to hotel ${hotelId}`);
    }

    res.json({
      message: 'Room status updated successfully',
      room: {
        id: updatedRoom.id,
        roomNumber: updatedRoom.roomNumber,
        status: updatedRoom.status,
        previousStatus: currentStatus,
        notes: updatedRoom.notes,
        roomType: updatedRoom.roomType,
        lastUpdated: updatedRoom.lastUpdated
      }
    });

  } catch (error) {
    console.error('Update room status error:', error);
    
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

// Status transition validation logic
const validateStatusTransition = (fromStatus, toStatus) => {
  const validTransitions = {
    'available': ['occupied', 'out_of_order', 'blocked'],
    'occupied': ['dirty', 'available'], // available if direct checkout
    'dirty': ['cleaning', 'available'], // available if no cleaning needed
    'cleaning': ['available', 'out_of_order'],
    'out_of_order': ['available', 'blocked'],
    'blocked': ['available', 'out_of_order']
  };

  return validTransitions[fromStatus]?.includes(toStatus) || false;
};

const getAllowedTransitions = (fromStatus) => {
  const validTransitions = {
    'available': ['occupied', 'out_of_order', 'blocked'],
    'occupied': ['dirty', 'available'],
    'dirty': ['cleaning', 'available'],
    'cleaning': ['available', 'out_of_order'],
    'out_of_order': ['available', 'blocked'],
    'blocked': ['available', 'out_of_order']
  };

  return validTransitions[fromStatus] || [];
};

module.exports = {
  createRoom,
  getRooms,
  getRoom,
  updateRoom,
  updateRoomStatus,
  ROOM_STATUSES
};