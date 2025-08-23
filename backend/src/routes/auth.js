const express = require('express');
const router = express.Router();
const { login, createUser, resetPassword, validateToken } = require('../controllers/authController');
const { authenticateToken, requirePlatformAdmin, requireHotelOwner, requirePermission } = require('../middleware/auth');

// Public routes (no authentication required)
router.post('/login', login);
router.get('/validate-token', authenticateToken, validateToken);

// User management routes
router.post('/users', authenticateToken, requirePermission('create_users'), createUser);
router.put('/users/:userId/reset-password', authenticateToken, resetPassword);

// Route-specific user creation endpoints for clarity
router.post('/create-platform-admin', requirePlatformAdmin, createUser);
router.post('/create-hotel-owner', requirePlatformAdmin, createUser);
router.post('/create-hotel-staff', requireHotelOwner, createUser);

module.exports = router;