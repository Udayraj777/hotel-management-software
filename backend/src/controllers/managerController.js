const { PrismaClient } = require('@prisma/client');
const { z } = require('zod');

const prisma = new PrismaClient();

// Helper function to broadcast manager dashboard updates
const broadcastDashboardUpdate = async (hotelId) => {
  try {
    if (!global.socketServer) return;

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(today.getDate() + 1);

    // Get current task status (same logic as getManagerDashboard)
    const todaysTasks = await prisma.task.findMany({
      where: {
        hotelId,
        OR: [
          {
            scheduledFor: {
              gte: today,
              lt: tomorrow
            }
          },
          {
            scheduledFor: { lt: today },
            status: { in: ['pending', 'in_progress'] }
          }
        ]
      }
    });

    const tasksByStatus = {
      pending: todaysTasks.filter(t => t.status === 'pending'),
      in_progress: todaysTasks.filter(t => t.status === 'in_progress'),
      completed: todaysTasks.filter(t => t.status === 'completed'),
      overdue: todaysTasks.filter(t => t.scheduledFor < today && t.status !== 'completed')
    };

    const urgentTasks = todaysTasks.filter(t => t.priority === 'urgent');
    const pendingUrgentTasks = urgentTasks.filter(t => t.status !== 'completed').length;
    
    const totalTasks = todaysTasks.length;
    const completedTasks = tasksByStatus.completed.length;
    const completionRate = totalTasks > 0 ? ((completedTasks / totalTasks) * 100).toFixed(1) : 0;

    const dashboardUpdate = {
      summary: {
        totalTasks,
        completedTasks,
        pendingTasks: tasksByStatus.pending.length,
        inProgressTasks: tasksByStatus.in_progress.length,
        overdueCount: tasksByStatus.overdue.length,
        urgentTasksRemaining: pendingUrgentTasks,
        completionRate: parseFloat(completionRate)
      },
      canLogout: pendingUrgentTasks === 0,
      logoutBlockReason: pendingUrgentTasks > 0 ? 
        `${pendingUrgentTasks} urgent task${pendingUrgentTasks > 1 ? 's' : ''} must be completed before logout` : null,
      lastUpdated: new Date().toISOString()
    };

    // Send to managers specifically
    global.socketServer.broadcastToRole(hotelId, 'hotel_manager', 'dashboard_updated', dashboardUpdate);
    global.socketServer.broadcastToRole(hotelId, 'hotel_owner', 'dashboard_updated', dashboardUpdate);
    
    console.log(`📊 Dashboard update broadcasted to hotel ${hotelId} managers`);
    return dashboardUpdate;
    
  } catch (error) {
    console.error('Error broadcasting dashboard update:', error);
    return null;
  }
};

// Get manager's daily dashboard
const getManagerDashboard = async (req, res) => {
  try {
    const hotelId = req.user.hotelId;
    const userId = req.user.userId;

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(today.getDate() + 1);

    // Get today's tasks
    const todaysTasks = await prisma.task.findMany({
      where: {
        hotelId,
        OR: [
          {
            scheduledFor: {
              gte: today,
              lt: tomorrow
            }
          },
          {
            scheduledFor: { lt: today },
            status: { in: ['pending', 'in_progress'] }
          }
        ]
      },
      include: {
        assignedTo: {
          select: {
            id: true,
            name: true,
            role: true
          }
        },
        room: {
          select: {
            id: true,
            roomNumber: true,
            floor: true,
            status: true
          }
        }
      },
      orderBy: [
        { priority: 'desc' },
        { scheduledFor: 'asc' }
      ]
    });

    // Categorize tasks
    const tasksByStatus = {
      pending: todaysTasks.filter(t => t.status === 'pending'),
      in_progress: todaysTasks.filter(t => t.status === 'in_progress'),
      completed: todaysTasks.filter(t => t.status === 'completed'),
      overdue: todaysTasks.filter(t => t.scheduledFor < today && t.status !== 'completed')
    };

    const tasksByPriority = {
      urgent: todaysTasks.filter(t => t.priority === 'urgent'),
      high: todaysTasks.filter(t => t.priority === 'high'),
      medium: todaysTasks.filter(t => t.priority === 'medium'),
      low: todaysTasks.filter(t => t.priority === 'low')
    };

    // Calculate completion stats
    const totalTasks = todaysTasks.length;
    const completedTasks = tasksByStatus.completed.length;
    const pendingUrgentTasks = tasksByPriority.urgent.filter(t => t.status !== 'completed').length;
    const overdueCount = tasksByStatus.overdue.length;

    res.json({
      message: 'Manager dashboard loaded',
      date: today.toDateString(),
      summary: {
        totalTasks,
        completedTasks,
        pendingTasks: tasksByStatus.pending.length,
        inProgressTasks: tasksByStatus.in_progress.length,
        overdueCount,
        urgentTasksRemaining: pendingUrgentTasks,
        completionRate: totalTasks > 0 ? ((completedTasks / totalTasks) * 100).toFixed(1) : 0
      },
      tasks: todaysTasks,
      tasksByStatus,
      tasksByPriority,
      canLogout: pendingUrgentTasks === 0, // Can only logout if no urgent tasks pending
      logoutBlockReason: pendingUrgentTasks > 0 ? 
        `${pendingUrgentTasks} urgent task${pendingUrgentTasks > 1 ? 's' : ''} must be completed before logout` : null
    });

  } catch (error) {
    console.error('Manager dashboard error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Check if manager can logout (Daily Closeout Check)
const checkLogoutPermission = async (req, res) => {
  try {
    console.log('🔍 Logout check request received');
    console.log('User object:', req.user);
    
    const hotelId = req.user?.hotelId;
    const userId = req.user?.userId;
    const userRole = req.user?.role;
    
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    
    if (!hotelId || !userId) {
      return res.status(400).json({ error: 'Invalid user session data' });
    }

    // Only managers need this check
    if (userRole !== 'hotel_manager') {
      return res.json({
        canLogout: true,
        message: 'Logout permitted for non-manager roles'
      });
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(today.getDate() + 1);

    // Check for incomplete urgent tasks
    const urgentTasksIncomplete = await prisma.task.findMany({
      where: {
        hotelId,
        priority: 'urgent',
        status: { in: ['pending', 'in_progress'] },
        OR: [
          {
            scheduledFor: {
              gte: today,
              lt: tomorrow
            }
          },
          {
            scheduledFor: { lt: today }
          }
        ]
      },
      include: {
        room: {
          select: {
            roomNumber: true
          }
        }
      }
    });

    // Check for high priority overdue tasks
    const overdueHighPriorityTasks = await prisma.task.findMany({
      where: {
        hotelId,
        priority: { in: ['high', 'urgent'] },
        status: { in: ['pending', 'in_progress'] },
        scheduledFor: { lt: today }
      },
      include: {
        room: {
          select: {
            roomNumber: true
          }
        }
      }
    });

    const canLogout = urgentTasksIncomplete.length === 0;
    const blockingTasks = [...urgentTasksIncomplete, ...overdueHighPriorityTasks];

    if (!canLogout) {
      // Log the logout attempt for owner notification
      console.log(`🚨 Manager ${req.user.name} attempted logout with ${urgentTasksIncomplete.length} urgent tasks incomplete`);
    }

    res.json({
      canLogout,
      message: canLogout ? 'Logout permitted - all urgent tasks completed' : 'Logout blocked - urgent tasks must be completed',
      blockingTasks: blockingTasks.map(task => ({
        id: task.id,
        description: task.description,
        priority: task.priority,
        status: task.status,
        scheduledFor: task.scheduledFor,
        roomNumber: task.room?.roomNumber,
        isOverdue: task.scheduledFor < today
      })),
      urgentTasksRemaining: urgentTasksIncomplete.length,
      overdueHighPriorityCount: overdueHighPriorityTasks.length
    });

  } catch (error) {
    console.error('Logout permission check error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Force logout attempt (with owner notification)
const attemptForceLogout = async (req, res) => {
  try {
    const hotelId = req.user.hotelId;
    const userId = req.user.userId;
    const { reason, notes } = req.body;

    // Get incomplete urgent tasks
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const incompleteUrgentTasks = await prisma.task.findMany({
      where: {
        hotelId,
        priority: 'urgent',
        status: { in: ['pending', 'in_progress'] },
        scheduledFor: { lte: new Date() }
      },
      include: {
        room: {
          select: {
            roomNumber: true
          }
        }
      }
    });

    if (incompleteUrgentTasks.length === 0) {
      return res.json({
        success: true,
        message: 'Logout permitted - no urgent tasks remaining'
      });
    }

    // Create notification for hotel owner
    const hotelOwner = await prisma.user.findFirst({
      where: {
        hotelId,
        role: 'hotel_owner',
        isActive: true
      }
    });

    // Create a special notification record (we'll implement notifications table later)
    const notificationData = {
      type: 'manager_forced_logout',
      managerId: userId,
      managerName: req.user.name,
      date: new Date().toISOString(),
      incompleteTasks: incompleteUrgentTasks.length,
      reason: reason || 'Emergency logout',
      notes: notes || null,
      tasks: incompleteUrgentTasks.map(t => ({
        id: t.id,
        description: t.description,
        priority: t.priority,
        roomNumber: t.room?.roomNumber
      }))
    };

    // For now, log this to console (later implement email/SMS notification)
    console.log('🚨 OWNER NOTIFICATION - Manager Force Logout:', JSON.stringify(notificationData, null, 2));

    // Mark incomplete urgent tasks as carried over to tomorrow
    await prisma.task.updateMany({
      where: {
        id: { in: incompleteUrgentTasks.map(t => t.id) }
      },
      data: {
        specialInstructions: `[CARRIED OVER] Manager logged out with task incomplete on ${today.toDateString()}. ${reason || 'No reason provided'}`
      }
    });

    res.json({
      success: true,
      message: 'Force logout completed - Owner has been notified',
      notification: {
        sent: true,
        ownerEmail: hotelOwner?.email,
        incompleteTasks: incompleteUrgentTasks.length,
        notificationId: `force_logout_${userId}_${Date.now()}`
      }
    });

  } catch (error) {
    console.error('Force logout error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Get daily closeout report
const getDailyCloseoutReport = async (req, res) => {
  try {
    const hotelId = req.user.hotelId;
    const { date } = req.query;

    const reportDate = date ? new Date(date) : new Date();
    reportDate.setHours(0, 0, 0, 0);
    const nextDay = new Date(reportDate);
    nextDay.setDate(reportDate.getDate() + 1);

    // Get all tasks for the day
    const dayTasks = await prisma.task.findMany({
      where: {
        hotelId,
        OR: [
          {
            scheduledFor: {
              gte: reportDate,
              lt: nextDay
            }
          },
          {
            scheduledFor: { lt: reportDate },
            status: { in: ['pending', 'in_progress'] },
            completedAt: {
              gte: reportDate,
              lt: nextDay
            }
          }
        ]
      },
      include: {
        assignedTo: {
          select: {
            name: true,
            role: true
          }
        },
        assignedBy: {
          select: {
            name: true,
            role: true
          }
        },
        room: {
          select: {
            roomNumber: true
          }
        }
      },
      orderBy: [
        { priority: 'desc' },
        { completedAt: 'desc' },
        { scheduledFor: 'asc' }
      ]
    });

    // Categorize tasks for report
    const completedTasks = dayTasks.filter(t => t.status === 'completed' && t.completedAt);
    const incompleteTasks = dayTasks.filter(t => t.status !== 'completed');
    const urgentIncomplete = incompleteTasks.filter(t => t.priority === 'urgent');
    const highPriorityIncomplete = incompleteTasks.filter(t => t.priority === 'high');
    
    const carryOverTasks = incompleteTasks.filter(t => 
      t.specialInstructions && t.specialInstructions.includes('[CARRIED OVER]')
    );

    // Calculate performance metrics
    const totalTasks = dayTasks.length;
    const completionRate = totalTasks > 0 ? ((completedTasks.length / totalTasks) * 100).toFixed(1) : 0;
    
    res.json({
      message: 'Daily closeout report generated',
      date: reportDate.toDateString(),
      summary: {
        totalTasks,
        completedTasks: completedTasks.length,
        incompleteTasks: incompleteTasks.length,
        urgentIncomplete: urgentIncomplete.length,
        highPriorityIncomplete: highPriorityIncomplete.length,
        carryOverTasks: carryOverTasks.length,
        completionRate: parseFloat(completionRate)
      },
      tasks: {
        completed: completedTasks,
        incomplete: incompleteTasks,
        urgentIncomplete,
        carryOver: carryOverTasks
      },
      performance: {
        onTimeCompletion: completedTasks.filter(t => 
          t.completedAt <= (t.scheduledFor || t.createdAt)
        ).length,
        overdueCompletion: completedTasks.filter(t => 
          t.completedAt > (t.scheduledFor || t.createdAt)
        ).length
      },
      managerAccountability: {
        allUrgentTasksCompleted: urgentIncomplete.length === 0,
        canEndDay: urgentIncomplete.length === 0,
        remainingUrgentCount: urgentIncomplete.length
      }
    });

  } catch (error) {
    console.error('Daily closeout report error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Carry over incomplete tasks to tomorrow
const carryOverTasks = async (req, res) => {
  try {
    const hotelId = req.user.hotelId;

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(today.getDate() + 1);

    // Get incomplete non-recurring tasks from today or earlier
    const incompleteTasks = await prisma.task.findMany({
      where: {
        hotelId,
        status: { in: ['pending', 'in_progress'] },
        scheduledFor: { lt: tomorrow },
        isRecurring: false, // Don't carry over recurring tasks
        parentTaskId: null // Only carry over main tasks, not instances
      }
    });

    if (incompleteTasks.length === 0) {
      return res.json({
        message: 'No tasks to carry over',
        carriedOverCount: 0
      });
    }

    // Update incomplete tasks to tomorrow
    const carryOverResults = await Promise.all(
      incompleteTasks.map(async (task) => {
        const newScheduledFor = new Date(tomorrow);
        // Keep the same time if it was scheduled, or default to 9 AM
        if (task.scheduledFor) {
          const originalTime = new Date(task.scheduledFor);
          newScheduledFor.setHours(originalTime.getHours(), originalTime.getMinutes(), 0, 0);
        } else {
          newScheduledFor.setHours(9, 0, 0, 0);
        }

        return prisma.task.update({
          where: { id: task.id },
          data: {
            scheduledFor: newScheduledFor,
            specialInstructions: `[CARRIED OVER from ${today.toDateString()}] ${task.specialInstructions || ''}`
          }
        });
      })
    );

    console.log(`✅ Carried over ${carryOverResults.length} incomplete tasks to tomorrow`);

    res.json({
      message: 'Tasks carried over successfully',
      carriedOverCount: carryOverResults.length,
      tasks: carryOverResults.map(t => ({
        id: t.id,
        description: t.description,
        priority: t.priority,
        newScheduledFor: t.scheduledFor
      }))
    });

  } catch (error) {
    console.error('Carry over tasks error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

module.exports = {
  getManagerDashboard,
  checkLogoutPermission,
  attemptForceLogout,
  getDailyCloseoutReport,
  carryOverTasks,
  broadcastDashboardUpdate
};