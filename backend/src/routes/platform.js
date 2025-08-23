const express = require('express');
const router = express.Router();
const { setupHotel, getPlatformStats } = require('../controllers/platformController');
const { getAllHotels } = require('../controllers/hotelController');
const { requirePlatformAdmin } = require('../middleware/auth');

// All platform routes require platform admin access
router.use(requirePlatformAdmin);

// Hotel management
router.post('/setup-hotel', setupHotel);
router.get('/hotels', getAllHotels);
router.get('/stats', getPlatformStats);

module.exports = router;