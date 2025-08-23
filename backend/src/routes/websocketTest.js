const express = require('express');
const router = express.Router();
const { authenticateToken, requireTenantAccess } = require('../middleware/auth');

// Test route to trigger WebSocket broadcasts
router.post('/test-broadcast', authenticateToken, requireTenantAccess, (req, res) => {
  try {
    const hotelId = req.user.hotelId;
    const { eventType, message, targetRole } = req.body;

    if (!global.socketServer) {
      return res.status(500).json({ error: 'WebSocket server not initialized' });
    }

    const testData = {
      message: message || 'Test WebSocket message',
      triggeredBy: {
        userId: req.user.userId,
        userName: req.user.name,
        userRole: req.user.role
      },
      testEvent: true
    };

    let broadcastResult = {};

    switch (eventType) {
      case 'hotel_broadcast':
        // Broadcast to all users in the hotel
        global.socketServer.broadcastToHotel(hotelId, 'test_hotel_message', testData);
        broadcastResult = { type: 'hotel_broadcast', hotelId, message: 'Sent to all hotel users' };
        break;

      case 'role_broadcast':
        // Broadcast to specific role
        const role = targetRole || 'hotel_manager';
        global.socketServer.broadcastToRole(hotelId, role, 'test_role_message', testData);
        broadcastResult = { type: 'role_broadcast', role, hotelId, message: `Sent to all ${role} users` };
        break;

      case 'room_update':
        // Simulate a room status update
        global.socketServer.broadcastToHotel(hotelId, 'room_status_updated', {
          ...testData,
          roomId: 1,
          roomNumber: '101',
          status: 'available',
          previousStatus: 'cleaning'
        });
        broadcastResult = { type: 'room_update', message: 'Simulated room status update' };
        break;

      case 'task_complete':
        // Simulate task completion
        global.socketServer.broadcastToRole(hotelId, 'hotel_manager', 'task_completed', {
          ...testData,
          taskId: 999,
          description: 'Test urgent cleaning task',
          priority: 'urgent'
        });
        broadcastResult = { type: 'task_complete', message: 'Simulated urgent task completion' };
        break;

      case 'dashboard_update':
        // Simulate dashboard update
        global.socketServer.broadcastToRole(hotelId, 'hotel_manager', 'dashboard_updated', {
          summary: {
            totalTasks: 5,
            completedTasks: 4,
            urgentTasksRemaining: 0,
            completionRate: 80.0
          },
          canLogout: true,
          lastUpdated: new Date().toISOString(),
          testUpdate: true
        });
        broadcastResult = { type: 'dashboard_update', message: 'Simulated dashboard update' };
        break;

      default:
        return res.status(400).json({ 
          error: 'Invalid event type',
          validTypes: ['hotel_broadcast', 'role_broadcast', 'room_update', 'task_complete', 'dashboard_update']
        });
    }

    // Get connection stats
    const connectedCount = global.socketServer.getConnectedUsersCount(hotelId);
    const connectedUsers = global.socketServer.getConnectedUsers(hotelId);

    res.json({
      success: true,
      broadcast: broadcastResult,
      connectionStats: {
        hotelId,
        connectedUsers: connectedCount,
        connectedUserDetails: connectedUsers
      },
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('WebSocket test error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get WebSocket connection status
router.get('/connection-status', authenticateToken, requireTenantAccess, (req, res) => {
  try {
    const hotelId = req.user.hotelId;

    if (!global.socketServer) {
      return res.status(500).json({ error: 'WebSocket server not initialized' });
    }

    const connectedCount = global.socketServer.getConnectedUsersCount(hotelId);
    const connectedUsers = global.socketServer.getConnectedUsers(hotelId);

    res.json({
      websocketStatus: 'active',
      hotelId,
      connectedUsers: connectedCount,
      userDetails: connectedUsers,
      serverTime: new Date().toISOString()
    });

  } catch (error) {
    console.error('Connection status error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;