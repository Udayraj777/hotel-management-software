const express = require('express');
const router = express.Router();
const {
  createStaff,
  getHotelStaff,
  updateStaff,
  changePassword,
  getProfile,
  updateProfile
} = require('../controllers/hotelUserController');
const {
  requireHotelOwner,
  requireHotelManager,
  requireHotelStaff,
  authenticateToken
} = require('../middleware/auth');

// Profile management (all authenticated users)
router.get('/profile', authenticateToken, getProfile);
router.put('/profile', authenticateToken, updateProfile);
router.put('/change-password', authenticateToken, changePassword);

// Staff management (hotel owner only)
router.post('/staff', requireHotelOwner, createStaff);
router.put('/staff/:id', requireHotelOwner, updateStaff);

// View staff (manager and above)
router.get('/staff', requireHotelManager, getHotelStaff);

module.exports = router;