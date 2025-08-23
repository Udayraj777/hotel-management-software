const express = require('express');
const router = express.Router();
const {
  createRoom,
  getRooms,
  getRoom,
  updateRoom,
  updateRoomStatus
} = require('../controllers/roomController');
const {
  requireHotelOwner,
  requireHotelManager,
  requireHotelStaff
} = require('../middleware/auth');

// Room management
router.post('/', requireHotelManager, createRoom);              // Manager and above
router.get('/', requireHotelStaff, getRooms);                  // All hotel staff
router.get('/:id', requireHotelStaff, getRoom);                // All hotel staff
router.put('/:id', requireHotelManager, updateRoom);           // Manager and above
router.put('/:id/status', requireHotelStaff, updateRoomStatus); // All hotel staff can update status

module.exports = router;