const express = require('express');
const router = express.Router();
const { createHotel, getAllHotels } = require('../controllers/hotelController');
const { requirePlatformAdmin } = require('../middleware/auth');

// Platform admin only routes
router.post('/', requirePlatformAdmin, createHotel);
router.get('/', requirePlatformAdmin, getAllHotels);

module.exports = router;