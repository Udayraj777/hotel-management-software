const { PrismaClient } = require('@prisma/client');
const { z } = require('zod');

const prisma = new PrismaClient();

const createHotelSchema = z.object({
  name: z.string().min(1, 'Hotel name is required'),
  address: z.string().min(1, 'Address is required'),
  phone: z.string().min(1, 'Phone is required'),
  ownerEmail: z.string().email('Valid email is required')
});

const createHotel = async (req, res) => {
  try {
    const { name, address, phone, ownerEmail } = createHotelSchema.parse(req.body);

    const existingHotel = await prisma.hotel.findFirst({
      where: { name }
    });

    if (existingHotel) {
      return res.status(400).json({ error: 'Hotel with this name already exists' });
    }

    const hotel = await prisma.hotel.create({
      data: {
        name,
        address,
        phone,
        ownerEmail,
        subscriptionStatus: 'trial',
        subscriptionEndDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        isActive: true
      }
    });

    res.status(201).json({
      message: 'Hotel created successfully',
      hotel: {
        id: hotel.id,
        name: hotel.name,
        address: hotel.address,
        phone: hotel.phone,
        ownerEmail: hotel.ownerEmail,
        subscriptionStatus: hotel.subscriptionStatus
      }
    });

  } catch (error) {
    console.error('Create hotel error:', error);
    
    if (error instanceof z.ZodError) {
      return res.status(400).json({ 
        error: 'Validation failed',
        details: error.errors 
      });
    }

    res.status(500).json({ error: 'Internal server error' });
  }
};

const getAllHotels = async (req, res) => {
  try {
    const hotels = await prisma.hotel.findMany({
      select: {
        id: true,
        name: true,
        address: true,
        phone: true,
        ownerEmail: true,
        subscriptionStatus: true,
        subscriptionEndDate: true,
        isActive: true,
        createdAt: true
      },
      orderBy: {
        createdAt: 'desc'
      }
    });

    res.json({
      message: 'Hotels retrieved successfully',
      hotels
    });

  } catch (error) {
    console.error('Get hotels error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

module.exports = {
  createHotel,
  getAllHotels
};