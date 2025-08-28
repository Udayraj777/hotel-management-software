const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

/**
 * Check if hotel has completed all setup requirements
 * Requirements:
 * 1. Owner must have completed first login
 * 2. At least one staff member must be created
 * 3. At least one room type must be created
 */
const checkHotelSetupCompletion = async (hotelId) => {
  try {
    console.log(`[Setup Check] Checking setup completion for hotel ${hotelId}`);

    // Get hotel with related data
    const hotel = await prisma.hotel.findUnique({
      where: { id: hotelId },
      include: {
        users: {
          select: {
            id: true,
            role: true,
            firstLoginCompleted: true
          }
        },
        roomTypes: {
          select: {
            id: true
          }
        }
      }
    });

    if (!hotel) {
      console.log(`[Setup Check] Hotel ${hotelId} not found`);
      return { isComplete: false, reason: 'Hotel not found' };
    }

    // If already marked as completed, no need to check again
    if (hotel.setupCompleted) {
      console.log(`[Setup Check] Hotel ${hotelId} already marked as setup completed`);
      return { isComplete: true, reason: 'Already completed' };
    }

    // Check requirements
    const requirements = {
      ownerFirstLogin: false,
      hasStaff: false,
      hasRoomTypes: false
    };

    // 1. Check if owner completed first login
    const owner = hotel.users.find(u => u.role === 'hotel_owner');
    if (owner && owner.firstLoginCompleted) {
      requirements.ownerFirstLogin = true;
    }

    // 2. Check if at least one staff member exists (excluding owner)
    const staffMembers = hotel.users.filter(u => u.role !== 'hotel_owner');
    if (staffMembers.length > 0) {
      requirements.hasStaff = true;
    }

    // 3. Check if at least one room type exists
    if (hotel.roomTypes.length > 0) {
      requirements.hasRoomTypes = true;
    }

    const isComplete = requirements.ownerFirstLogin && requirements.hasStaff && requirements.hasRoomTypes;

    console.log(`[Setup Check] Hotel ${hotelId} requirements:`, {
      ownerFirstLogin: requirements.ownerFirstLogin,
      hasStaff: requirements.hasStaff,
      hasRoomTypes: requirements.hasRoomTypes,
      isComplete
    });

    return {
      isComplete,
      requirements,
      reason: isComplete ? 'All requirements met' : 'Missing requirements'
    };

  } catch (error) {
    console.error(`[Setup Check] Error checking setup for hotel ${hotelId}:`, error);
    return { isComplete: false, reason: 'Error during check', error: error.message };
  }
};

/**
 * Mark hotel setup as completed if all requirements are met
 */
const updateHotelSetupStatus = async (hotelId) => {
  try {
    const setupCheck = await checkHotelSetupCompletion(hotelId);
    
    if (setupCheck.isComplete) {
      console.log(`[Setup Update] Marking hotel ${hotelId} as setup completed`);
      
      await prisma.hotel.update({
        where: { id: hotelId },
        data: { 
          setupCompleted: true 
        }
      });

      console.log(`[Setup Update] Hotel ${hotelId} marked as setup completed successfully`);
      return { updated: true, message: 'Hotel setup marked as completed' };
    }

    return { 
      updated: false, 
      message: 'Setup requirements not yet met', 
      requirements: setupCheck.requirements 
    };

  } catch (error) {
    console.error(`[Setup Update] Error updating setup status for hotel ${hotelId}:`, error);
    return { updated: false, message: 'Error updating setup status', error: error.message };
  }
};

/**
 * Get hotel setup status for admin dashboard
 */
const getHotelSetupStatus = async (hotelId) => {
  try {
    const hotel = await prisma.hotel.findUnique({
      where: { id: hotelId },
      select: {
        id: true,
        name: true,
        setupCompleted: true,
        users: {
          select: {
            role: true,
            firstLoginCompleted: true
          }
        },
        roomTypes: {
          select: {
            id: true
          }
        }
      }
    });

    if (!hotel) {
      return { status: 'not_found' };
    }

    if (hotel.setupCompleted) {
      return { 
        status: 'completed',
        displayStatus: '✅ Active',
        statusColor: 'green'
      };
    }

    // Check what's missing
    const owner = hotel.users.find(u => u.role === 'hotel_owner');
    const staffCount = hotel.users.filter(u => u.role !== 'hotel_owner').length;
    const roomTypeCount = hotel.roomTypes.length;

    const missing = [];
    if (!owner || !owner.firstLoginCompleted) {
      missing.push('Owner first login');
    }
    if (staffCount === 0) {
      missing.push('Staff accounts');
    }
    if (roomTypeCount === 0) {
      missing.push('Room types');
    }

    return {
      status: 'incomplete',
      displayStatus: '⏳ Setup Incomplete',
      statusColor: 'yellow',
      missing,
      progress: {
        ownerLogin: owner ? owner.firstLoginCompleted : false,
        staffCreated: staffCount > 0,
        roomTypesCreated: roomTypeCount > 0,
        completionPercentage: Math.round(((missing.length === 3 ? 0 : (3 - missing.length)) / 3) * 100)
      }
    };

  } catch (error) {
    console.error(`[Setup Status] Error getting setup status for hotel ${hotelId}:`, error);
    return { status: 'error', error: error.message };
  }
};

module.exports = {
  checkHotelSetupCompletion,
  updateHotelSetupStatus,
  getHotelSetupStatus
};