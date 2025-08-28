const express = require('express');
const router = express.Router();
const { 
  setupHotel, 
  getPlatformStats,
  getAllHotelsDetailed,
  updateHotelStatus,
  updateHotelSubscription,
  getHotelDetails,
  getEnhancedPlatformStats
} = require('../controllers/platformController');
const { requirePlatformAdmin } = require('../middleware/auth');

// All platform routes require platform admin access
router.use(requirePlatformAdmin);

// Platform statistics
router.get('/stats', getPlatformStats);
router.get('/stats/enhanced', getEnhancedPlatformStats);

// Hotel management
router.post('/setup-hotel', setupHotel);
router.get('/hotels', getAllHotelsDetailed);
router.get('/hotels/:hotelId', getHotelDetails);

// Hotel status management
router.patch('/hotels/:hotelId/status', updateHotelStatus);
router.patch('/hotels/:hotelId/subscription', updateHotelSubscription);

module.exports = router;