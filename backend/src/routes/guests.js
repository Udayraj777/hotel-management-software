const express = require('express');
const router = express.Router();
const { 
  createGuest, 
  getGuests, 
  getGuestById, 
  updateGuest, 
  searchGuests,
  getGuestStats 
} = require('../controllers/guestController');
const { 
  authenticateToken, 
  requireHotelStaff, 
  requireTenantAccess 
} = require('../middleware/auth');

// All guest routes require authentication and hotel staff level access
router.use(authenticateToken);
router.use(requireTenantAccess);

// Guest statistics (for managers)
router.get('/stats', getGuestStats);

// Search guests
router.get('/search', searchGuests);

// CRUD operations
router.post('/', createGuest);
router.get('/', getGuests);
router.get('/:guestId', getGuestById);
router.put('/:guestId', updateGuest);

module.exports = router;