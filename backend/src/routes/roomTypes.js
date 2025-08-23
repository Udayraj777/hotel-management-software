const express = require('express');
const router = express.Router();
const {
  createRoomType,
  getRoomTypes,
  getRoomType,
  updateRoomType,
  deleteRoomType
} = require('../controllers/roomTypeController');
const {
  requireHotelOwner,
  requireHotelManager,
  requireHotelStaff
} = require('../middleware/auth');

// Room type management
router.post('/', requireHotelOwner, createRoomType);           // Owner only
router.get('/', requireHotelStaff, getRoomTypes);             // All hotel staff
router.get('/:id', requireHotelStaff, getRoomType);           // All hotel staff
router.put('/:id', requireHotelManager, updateRoomType);      // Manager and above
router.delete('/:id', requireHotelOwner, deleteRoomType);     // Owner only

module.exports = router;