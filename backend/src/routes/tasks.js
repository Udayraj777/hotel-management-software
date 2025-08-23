const express = require('express');
const router = express.Router();
const { 
  createTask,
  getTasks,
  getTodaysTasks,
  getTaskById,
  updateTask,
  startTask,
  completeTask,
  getTaskStats
} = require('../controllers/taskController');
const { 
  authenticateToken, 
  requireHotelStaff, 
  requireTenantAccess,
  requirePermission 
} = require('../middleware/auth');

// All task routes require authentication and hotel staff level access
router.use(authenticateToken);
router.use(requireTenantAccess);

// Statistics (for managers)
router.get('/stats', getTaskStats);

// Today's tasks (for daily management)
router.get('/today', getTodaysTasks);

// Task actions
router.post('/:taskId/start', startTask);
router.post('/:taskId/complete', completeTask);

// CRUD operations
router.post('/', requirePermission('manage_tasks'), createTask);
router.get('/', getTasks);
router.get('/:taskId', getTaskById);
router.put('/:taskId', updateTask);

module.exports = router;