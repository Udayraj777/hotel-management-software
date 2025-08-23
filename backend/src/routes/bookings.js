const express = require('express');
const router = express.Router();
const { 
  createBooking, 
  getBookings, 
  getBookingById, 
  updateBooking,
  checkInGuest,
  checkOutGuest,
  getBookingStats
} = require('../controllers/bookingController');
const { 
  authenticateToken, 
  requireHotelStaff, 
  requireTenantAccess 
} = require('../middleware/auth');

// All booking routes require authentication and hotel staff level access
router.use(authenticateToken);
router.use(requireTenantAccess);

// Statistics (for managers)
router.get('/stats', getBookingStats);

// Check-in and check-out operations
router.post('/:bookingId/check-in', checkInGuest);
router.post('/:bookingId/check-out', checkOutGuest);

// CRUD operations
router.post('/', createBooking);
router.get('/', getBookings);
router.get('/:bookingId', getBookingById);
router.put('/:bookingId', updateBooking);

module.exports = router;