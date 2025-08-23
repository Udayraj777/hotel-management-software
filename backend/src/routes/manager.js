const express = require('express');
const router = express.Router();
const { 
  getManagerDashboard,
  checkLogoutPermission,
  attemptForceLogout,
  getDailyCloseoutReport,
  carryOverTasks
} = require('../controllers/managerController');
const { 
  authenticateToken, 
  requireHotelManager,
  requireTenantAccess 
} = require('../middleware/auth');

// All manager routes require authentication and tenant access
router.use(authenticateToken);
router.use(requireTenantAccess);

// Manager dashboard (for daily management)
router.get('/dashboard', getManagerDashboard);

// Daily closeout and accountability
router.get('/logout-check', checkLogoutPermission);
router.post('/force-logout', attemptForceLogout);
router.get('/daily-report', getDailyCloseoutReport);
router.post('/carry-over-tasks', carryOverTasks);

module.exports = router;