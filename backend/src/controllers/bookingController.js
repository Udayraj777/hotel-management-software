const { PrismaClient } = require('@prisma/client');
const { z } = require('zod');

const prisma = new PrismaClient();

// Validation schemas
const createBookingSchema = z.object({
  guestId: z.number().int().positive(),
  roomId: z.number().int().positive(),
  checkInDate: z.string().refine((date) => {
    const checkIn = new Date(date);
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    yesterday.setHours(23, 59, 59, 999);
    return checkIn > yesterday;
  }, 'Check-in date cannot be in the past'),
  checkOutDate: z.string().refine((date) => new Date(date).getTime() > 0, 'Invalid check-out date'),
  numberOfGuests: z.number().int().positive().default(1),
  specialRequests: z.string().max(1000).optional().nullable(),
  source: z.enum(['walk_in', 'phone', 'email', 'website', 'oyo', 'makemytrip', 'booking.com']).default('walk_in')
}).refine((data) => {
  const checkIn = new Date(data.checkInDate);
  const checkOut = new Date(data.checkOutDate);
  return checkOut > checkIn;
}, {
  message: 'Check-out date must be after check-in date',
  path: ['checkOutDate']
});

const updateBookingSchema = createBookingSchema.partial().extend({
  status: z.enum(['confirmed', 'checked_in', 'checked_out', 'cancelled', 'no_show']).optional()
});

// Create a new booking
const createBooking = async (req, res) => {
  try {
    const bookingData = createBookingSchema.parse(req.body);
    const hotelId = req.user.hotelId;

    console.log('📅 Creating booking:', bookingData);

    // Verify guest belongs to hotel
    const guest = await prisma.guest.findFirst({
      where: {
        id: bookingData.guestId,
        hotelId
      }
    });

    if (!guest) {
      return res.status(404).json({ error: 'Guest not found' });
    }

    // Verify room belongs to hotel and get room details
    const room = await prisma.room.findFirst({
      where: {
        id: bookingData.roomId,
        hotelId
      },
      include: {
        roomType: true,
        bookings: {
          where: {
            status: { in: ['confirmed', 'checked_in', 'checked_out'] },
            OR: [
              {
                checkInDate: { lte: new Date(bookingData.checkOutDate) },
                checkOutDate: { gt: new Date(bookingData.checkInDate) }
              }
            ]
          }
        }
      }
    });

    if (!room) {
      return res.status(404).json({ error: 'Room not found' });
    }

    // Check room status availability
    if (room.status !== 'available') {
      return res.status(409).json({ 
        error: 'Room is not ready for booking',
        roomStatus: room.status,
        message: `Room ${room.roomNumber} is currently ${room.status}. Room must be cleaned and marked as available before accepting new bookings.`
      });
    }

    // Check room availability for date conflicts
    if (room.bookings.length > 0) {
      return res.status(409).json({ 
        error: 'Room is not available for selected dates',
        conflictingBookings: room.bookings.map(b => ({
          id: b.id,
          checkInDate: b.checkInDate,
          checkOutDate: b.checkOutDate,
          status: b.status
        }))
      });
    }

    // Calculate pricing
    const checkIn = new Date(bookingData.checkInDate);
    const checkOut = new Date(bookingData.checkOutDate);
    const totalNights = Math.ceil((checkOut - checkIn) / (1000 * 60 * 60 * 24));

    // Get current room pricing (simplified - using base price)
    const roomRate = room.roomType.basePrice;
    const baseAmount = roomRate * totalNights;

    // Create booking
    const booking = await prisma.booking.create({
      data: {
        hotelId,
        guestId: bookingData.guestId,
        roomId: bookingData.roomId,
        checkInDate: new Date(bookingData.checkInDate),
        checkOutDate: new Date(bookingData.checkOutDate),
        numberOfGuests: bookingData.numberOfGuests,
        roomRate,
        totalNights,
        baseAmount,
        finalAmount: baseAmount, // No discounts initially
        status: 'confirmed',
        paymentStatus: 'pending',
        specialRequests: bookingData.specialRequests || null,
        source: bookingData.source
      },
      include: {
        guest: {
          select: {
            id: true,
            name: true,
            phone: true,
            email: true
          }
        },
        room: {
          include: {
            roomType: {
              select: {
                name: true,
                basePrice: true
              }
            }
          }
        }
      }
    });

    console.log('✅ Booking created:', booking.id);

    // 🔌 WEBSOCKET: Broadcast new booking creation
    if (global.socketServer) {
      const bookingNotificationData = {
        bookingId: booking.id,
        guestName: booking.guest.name,
        guestPhone: booking.guest.phone,
        roomNumber: booking.room.roomNumber,
        roomType: booking.room.roomType.name,
        checkInDate: booking.checkInDate,
        checkOutDate: booking.checkOutDate,
        totalNights: booking.totalNights,
        finalAmount: booking.finalAmount,
        status: booking.status,
        source: booking.source,
        createdBy: {
          userId: req.user.userId,
          userName: req.user.name,
          userRole: req.user.role
        },
        createdAt: booking.createdAt
      };

      // Notify all hotel staff about new booking
      global.socketServer.broadcastToHotel(hotelId, 'new_booking_created', bookingNotificationData);
      
      // Special notification to managers and front desk
      global.socketServer.broadcastToRole(hotelId, 'hotel_manager', 'booking_management_update', bookingNotificationData);
      global.socketServer.broadcastToRole(hotelId, 'front_desk', 'booking_management_update', bookingNotificationData);
      
      console.log(`📡 WebSocket: New booking ${booking.id} notification sent to hotel ${hotelId}`);
    }

    res.status(201).json({
      message: 'Booking created successfully',
      booking
    });

  } catch (error) {
    console.error('Create booking error:', error);
    
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        error: 'Validation failed',
        details: error.errors?.map(err => ({
          field: err.path?.join('.') || 'unknown',
          message: err.message
        })) || [{ field: 'unknown', message: 'Validation error' }]
      });
    }

    res.status(500).json({ error: 'Internal server error' });
  }
};

// Get all bookings for a hotel
const getBookings = async (req, res) => {
  try {
    const hotelId = req.user.hotelId;
    const { 
      page = 1, 
      limit = 20, 
      status, 
      checkInFrom, 
      checkInTo,
      guestName,
      roomNumber 
    } = req.query;

    const skip = (parseInt(page) - 1) * parseInt(limit);

    // Build filters
    const filters = { hotelId };

    if (status) {
      filters.status = status;
    }

    if (checkInFrom || checkInTo) {
      filters.checkInDate = {};
      if (checkInFrom) filters.checkInDate.gte = new Date(checkInFrom);
      if (checkInTo) filters.checkInDate.lte = new Date(checkInTo);
    }

    if (guestName) {
      filters.guest = {
        name: { contains: guestName, mode: 'insensitive' }
      };
    }

    if (roomNumber) {
      filters.room = {
        roomNumber: { contains: roomNumber }
      };
    }

    // Get bookings with pagination
    const [bookings, totalCount] = await prisma.$transaction([
      prisma.booking.findMany({
        where: filters,
        skip,
        take: parseInt(limit),
        orderBy: { createdAt: 'desc' },
        include: {
          guest: {
            select: {
              id: true,
              name: true,
              phone: true,
              email: true
            }
          },
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
        }
      }),
      prisma.booking.count({ where: filters })
    ]);

    res.json({
      message: 'Bookings retrieved successfully',
      bookings,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: totalCount,
        totalPages: Math.ceil(totalCount / parseInt(limit))
      }
    });

  } catch (error) {
    console.error('Get bookings error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Get booking by ID
const getBookingById = async (req, res) => {
  try {
    const { bookingId } = req.params;
    const hotelId = req.user.hotelId;

    const booking = await prisma.booking.findFirst({
      where: {
        id: parseInt(bookingId),
        hotelId
      },
      include: {
        guest: true,
        room: {
          include: {
            roomType: true
          }
        },
        roomServiceOrders: {
          orderBy: { orderedAt: 'desc' }
        },
        discountApprovals: {
          include: {
            requestedBy: {
              select: { name: true, role: true }
            },
            approvedBy: {
              select: { name: true, role: true }
            }
          }
        }
      }
    });

    if (!booking) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    res.json({
      message: 'Booking retrieved successfully',
      booking
    });

  } catch (error) {
    console.error('Get booking by ID error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Update booking
const updateBooking = async (req, res) => {
  try {
    const { bookingId } = req.params;
    const hotelId = req.user.hotelId;
    const updateData = updateBookingSchema.parse(req.body);

    console.log('📅 Updating booking:', bookingId, updateData);

    // Get existing booking
    const existingBooking = await prisma.booking.findFirst({
      where: {
        id: parseInt(bookingId),
        hotelId
      }
    });

    if (!existingBooking) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    // If dates are being changed, check availability
    if (updateData.checkInDate || updateData.checkOutDate || updateData.roomId) {
      const newCheckIn = updateData.checkInDate ? new Date(updateData.checkInDate) : existingBooking.checkInDate;
      const newCheckOut = updateData.checkOutDate ? new Date(updateData.checkOutDate) : existingBooking.checkOutDate;
      const newRoomId = updateData.roomId || existingBooking.roomId;

      // Check for conflicts (excluding current booking)
      const conflicts = await prisma.booking.findMany({
        where: {
          roomId: newRoomId,
          hotelId,
          id: { not: parseInt(bookingId) },
          status: { in: ['confirmed', 'checked_in'] },
          OR: [
            {
              checkInDate: { lte: newCheckOut },
              checkOutDate: { gt: newCheckIn }
            }
          ]
        }
      });

      if (conflicts.length > 0) {
        return res.status(409).json({
          error: 'Room is not available for selected dates',
          conflicts
        });
      }

      // Recalculate pricing if dates changed
      if (updateData.checkInDate || updateData.checkOutDate) {
        const totalNights = Math.ceil((newCheckOut - newCheckIn) / (1000 * 60 * 60 * 24));
        updateData.totalNights = totalNights;
        updateData.baseAmount = existingBooking.roomRate * totalNights;
        if (!updateData.finalAmount) {
          updateData.finalAmount = updateData.baseAmount;
        }
      }
    }

    // Update booking
    const updatedBooking = await prisma.booking.update({
      where: { id: parseInt(bookingId) },
      data: {
        ...updateData,
        checkInDate: updateData.checkInDate ? new Date(updateData.checkInDate) : undefined,
        checkOutDate: updateData.checkOutDate ? new Date(updateData.checkOutDate) : undefined
      },
      include: {
        guest: {
          select: {
            id: true,
            name: true,
            phone: true,
            email: true
          }
        },
        room: {
          include: {
            roomType: {
              select: {
                name: true
              }
            }
          }
        }
      }
    });

    res.json({
      message: 'Booking updated successfully',
      booking: updatedBooking
    });

  } catch (error) {
    console.error('Update booking error:', error);
    
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        error: 'Validation failed',
        details: error.errors?.map(err => ({
          field: err.path?.join('.') || 'unknown',
          message: err.message
        })) || [{ field: 'unknown', message: 'Validation error' }]
      });
    }

    res.status(500).json({ error: 'Internal server error' });
  }
};

// Check-in guest
const checkInGuest = async (req, res) => {
  try {
    const { bookingId } = req.params;
    const hotelId = req.user.hotelId;

    const booking = await prisma.booking.findFirst({
      where: {
        id: parseInt(bookingId),
        hotelId,
        status: 'confirmed'
      },
      include: {
        room: true,
        guest: {
          select: { name: true, phone: true }
        }
      }
    });

    if (!booking) {
      return res.status(404).json({ 
        error: 'Booking not found or already checked in' 
      });
    }

    // Allow check-in starting from today (early check-in is common)
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const checkInDate = new Date(booking.checkInDate);
    checkInDate.setHours(0, 0, 0, 0);

    // Allow check-in if scheduled date is today or in the future (but prevent checking in too far in advance)
    const maxEarlyCheckIn = new Date();
    maxEarlyCheckIn.setDate(maxEarlyCheckIn.getDate() + 7); // Allow up to 7 days early
    
    if (checkInDate > maxEarlyCheckIn) {
      return res.status(400).json({
        error: `Cannot check in more than 7 days before scheduled date (${checkInDate.toDateString()})`
      });
    }

    // Update booking and room status
    const [updatedBooking] = await prisma.$transaction([
      prisma.booking.update({
        where: { id: parseInt(bookingId) },
        data: {
          status: 'checked_in',
          checkedInAt: new Date()
        }
      }),
      prisma.room.update({
        where: { id: booking.roomId },
        data: { status: 'occupied' }
      })
    ]);

    console.log('✅ Guest checked in:', booking.guest.name, 'Room:', booking.room.roomNumber);

    // 🔌 WEBSOCKET: Broadcast guest check-in
    if (global.socketServer) {
      const checkInData = {
        bookingId: booking.id,
        guestName: booking.guest.name,
        roomNumber: booking.room.roomNumber,
        roomId: booking.roomId,
        checkInTime: updatedBooking.checkedInAt,
        checkOutDate: booking.checkOutDate,
        roomStatus: 'occupied',
        checkedInBy: {
          userId: req.user.userId,
          userName: req.user.name,
          userRole: req.user.role
        }
      };

      // Notify all staff about check-in
      global.socketServer.broadcastToHotel(hotelId, 'guest_checked_in', checkInData);
      
      // Notify housekeeping that room is now occupied
      global.socketServer.broadcastToRole(hotelId, 'housekeeping', 'room_occupied', checkInData);
      
      console.log(`📡 WebSocket: Check-in notification sent for ${booking.guest.name} in room ${booking.room.roomNumber}`);
    }

    res.json({
      message: 'Guest checked in successfully',
      booking: {
        ...updatedBooking,
        guest: booking.guest,
        room: booking.room
      }
    });

  } catch (error) {
    console.error('Check-in error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Check-out guest
const checkOutGuest = async (req, res) => {
  try {
    const { bookingId } = req.params;
    const hotelId = req.user.hotelId;
    const { finalAmount } = req.body; // Optional final amount after any additional charges

    const booking = await prisma.booking.findFirst({
      where: {
        id: parseInt(bookingId),
        hotelId,
        status: 'checked_in'
      },
      include: {
        room: true,
        guest: {
          select: { name: true, phone: true }
        },
        roomServiceOrders: {
          where: { paymentMethod: 'room_charge' }
        }
      }
    });

    if (!booking) {
      return res.status(404).json({ 
        error: 'Booking not found or not checked in' 
      });
    }

    // Calculate total room service charges
    const roomServiceTotal = booking.roomServiceOrders.reduce((total, order) => {
      return total + parseFloat(order.totalAmount);
    }, 0);

    const finalBillAmount = finalAmount || (parseFloat(booking.finalAmount) + roomServiceTotal);

    // Update booking and room status
    const [updatedBooking] = await prisma.$transaction([
      prisma.booking.update({
        where: { id: parseInt(bookingId) },
        data: {
          status: 'checked_out',
          checkedOutAt: new Date(),
          finalAmount: finalBillAmount
        }
      }),
      prisma.room.update({
        where: { id: booking.roomId },
        data: { status: 'dirty' } // Room needs cleaning after checkout
      })
    ]);

    console.log('✅ Guest checked out:', booking.guest.name, 'Room:', booking.room.roomNumber);

    // 🔌 WEBSOCKET: Broadcast guest check-out
    if (global.socketServer) {
      const checkOutData = {
        bookingId: booking.id,
        guestName: booking.guest.name,
        roomNumber: booking.room.roomNumber,
        roomId: booking.roomId,
        checkOutTime: updatedBooking.checkedOutAt,
        roomStatus: 'dirty',
        finalBillAmount: finalBillAmount,
        checkedOutBy: {
          userId: req.user.userId,
          userName: req.user.name,
          userRole: req.user.role
        }
      };

      // Notify all staff about check-out
      global.socketServer.broadcastToHotel(hotelId, 'guest_checked_out', checkOutData);
      
      // Urgent notification to housekeeping - room needs cleaning
      global.socketServer.broadcastToRole(hotelId, 'housekeeping', 'room_needs_urgent_cleaning', checkOutData);
      global.socketServer.broadcastToRole(hotelId, 'hotel_manager', 'checkout_completed', checkOutData);
      
      console.log(`📡 WebSocket: Check-out notification sent for ${booking.guest.name} in room ${booking.room.roomNumber}`);
    }

    res.json({
      message: 'Guest checked out successfully',
      booking: {
        ...updatedBooking,
        guest: booking.guest,
        room: booking.room
      },
      finalBill: {
        roomCharges: parseFloat(booking.finalAmount),
        roomServiceCharges: roomServiceTotal,
        totalAmount: finalBillAmount
      }
    });

  } catch (error) {
    console.error('Check-out error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Get booking statistics
const getBookingStats = async (req, res) => {
  try {
    const hotelId = req.user.hotelId;
    const { fromDate, toDate } = req.query;

    const dateFilter = {};
    if (fromDate) dateFilter.gte = new Date(fromDate);
    if (toDate) dateFilter.lte = new Date(toDate);

    const whereClause = { hotelId };
    if (Object.keys(dateFilter).length > 0) {
      whereClause.checkInDate = dateFilter;
    }

    const stats = await prisma.$transaction(async (tx) => {
      const totalBookings = await tx.booking.count({
        where: whereClause
      });

      const confirmedBookings = await tx.booking.count({
        where: { ...whereClause, status: 'confirmed' }
      });

      const checkedInBookings = await tx.booking.count({
        where: { ...whereClause, status: 'checked_in' }
      });

      const checkedOutBookings = await tx.booking.count({
        where: { ...whereClause, status: 'checked_out' }
      });

      const cancelledBookings = await tx.booking.count({
        where: { ...whereClause, status: 'cancelled' }
      });

      const totalRevenue = await tx.booking.aggregate({
        where: { ...whereClause, status: { in: ['checked_out'] } },
        _sum: { finalAmount: true }
      });

      const occupancyRate = totalBookings > 0 ? 
        ((checkedInBookings + checkedOutBookings) / totalBookings * 100).toFixed(2) : 0;

      return {
        totalBookings,
        confirmedBookings,
        checkedInBookings,
        checkedOutBookings,
        cancelledBookings,
        totalRevenue: totalRevenue._sum.finalAmount || 0,
        occupancyRate: parseFloat(occupancyRate)
      };
    });

    res.json({
      message: 'Booking statistics retrieved',
      stats,
      period: {
        fromDate: fromDate || 'All time',
        toDate: toDate || 'All time'
      }
    });

  } catch (error) {
    console.error('Booking stats error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

module.exports = {
  createBooking,
  getBookings,
  getBookingById,
  updateBooking,
  checkInGuest,
  checkOutGuest,
  getBookingStats
};