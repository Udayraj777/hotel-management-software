const { PrismaClient } = require('@prisma/client');
const { z } = require('zod');
const { broadcastDashboardUpdate } = require('./managerController');

const prisma = new PrismaClient();

// Validation schemas
const createTaskSchema = z.object({
  taskType: z.enum(['cleaning', 'maintenance', 'inspection', 'routine', 'complaint', 'general']),
  assignedToId: z.number().int().positive().optional().nullable(),
  roomId: z.number().int().positive().optional().nullable(),
  priority: z.enum(['low', 'medium', 'high', 'urgent']).default('medium'),
  description: z.string().min(5, 'Description must be at least 5 characters').max(1000),
  scheduledFor: z.string().optional().nullable(),
  scheduledDate: z.string().optional().nullable(), // Just date (YYYY-MM-DD)
  scheduledTime: z.string().optional().nullable(), // Just time (HH:MM)
  estimatedDuration: z.number().int().positive().optional().nullable(),
  specialInstructions: z.string().max(1000).optional().nullable(),
  
  // For recurring tasks
  isRecurring: z.boolean().default(false),
  recurrencePattern: z.enum(['daily', 'weekly', 'monthly']).optional().nullable(),
  recurrenceEndDate: z.string().optional().nullable(),
  
  // For complaints
  guestName: z.string().max(100).optional().nullable(),
  guestPhone: z.string().max(20).optional().nullable(),
  complaintSource: z.enum(['guest', 'inspection', 'staff', 'online_review']).optional().nullable()
});

const updateTaskSchema = createTaskSchema.partial().extend({
  status: z.enum(['pending', 'in_progress', 'completed', 'cancelled']).optional(),
  completionNotes: z.string().max(1000).optional().nullable()
});

// Create a new task
const createTask = async (req, res) => {
  try {
    const taskData = createTaskSchema.parse(req.body);
    const hotelId = req.user.hotelId;
    const createdById = req.user.userId;

    console.log('📋 Creating task:', taskData);

    // Verify assigned user belongs to hotel (if specified)
    if (taskData.assignedToId) {
      const assignedUser = await prisma.user.findFirst({
        where: {
          id: taskData.assignedToId,
          hotelId,
          isActive: true
        }
      });

      if (!assignedUser) {
        return res.status(404).json({ error: 'Assigned user not found or not in this hotel' });
      }
    }

    // Verify room belongs to hotel (if specified)
    if (taskData.roomId) {
      const room = await prisma.room.findFirst({
        where: {
          id: taskData.roomId,
          hotelId
        }
      });

      if (!room) {
        return res.status(404).json({ error: 'Room not found' });
      }
    }

    // Handle flexible scheduling
    let finalScheduledFor = null;
    
    if (taskData.scheduledFor) {
      // Full datetime provided
      finalScheduledFor = new Date(taskData.scheduledFor);
    } else if (taskData.scheduledDate) {
      // Date provided, combine with time or default to 9 AM
      const schedDate = new Date(taskData.scheduledDate);
      if (taskData.scheduledTime) {
        const [hours, minutes] = taskData.scheduledTime.split(':');
        schedDate.setHours(parseInt(hours), parseInt(minutes), 0, 0);
      } else {
        schedDate.setHours(9, 0, 0, 0); // Default to 9 AM
      }
      finalScheduledFor = schedDate;
    } else if (!taskData.isRecurring) {
      // No schedule provided for non-recurring task - schedule for today
      const today = new Date();
      today.setHours(9, 0, 0, 0); // Default to 9 AM today
      finalScheduledFor = today;
    }

    // Prepare data for database (exclude helper fields)
    const { scheduledDate, scheduledTime, ...dbTaskData } = taskData;

    // Create main task
    const task = await prisma.task.create({
      data: {
        ...dbTaskData,
        hotelId,
        assignedById: createdById,
        scheduledFor: finalScheduledFor,
        recurrenceEndDate: taskData.recurrenceEndDate ? new Date(taskData.recurrenceEndDate) : null,
        status: 'pending'
      },
      include: {
        assignedTo: {
          select: {
            id: true,
            name: true,
            role: true
          }
        },
        assignedBy: {
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
            floor: true
          }
        }
      }
    });

    // If this is a recurring task, generate instances for the next 30 days
    if (taskData.isRecurring && taskData.recurrencePattern) {
      await generateRecurringTaskInstances(task, taskData.recurrencePattern, taskData.recurrenceEndDate);
    }

    console.log('✅ Task created:', task.id);

    res.status(201).json({
      message: 'Task created successfully',
      task: {
        ...task,
        postedAt: task.createdAt,
        schedulingInfo: {
          originalScheduledFor: taskData.scheduledFor,
          originalScheduledDate: taskData.scheduledDate,
          originalScheduledTime: taskData.scheduledTime,
          finalScheduledFor: task.scheduledFor,
          wasAutoScheduled: !taskData.scheduledFor && !taskData.scheduledDate
        }
      }
    });

  } catch (error) {
    console.error('Create task error:', error);
    
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        error: 'Validation failed',
        details: error.errors?.map(err => ({
          field: err.path?.join('.') || 'unknown',
          message: err.message
        })) || [{ field: 'unknown', message: 'Validation error' }]
      });
    }

    res.status(500).json({ error: 'Internal server error' });
  }
};

// Generate recurring task instances
const generateRecurringTaskInstances = async (parentTask, pattern, endDate) => {
  const instances = [];
  const startDate = new Date();
  const finalEndDate = endDate ? new Date(endDate) : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days default

  let currentDate = new Date(startDate);
  
  while (currentDate <= finalEndDate && instances.length < 100) { // Max 100 instances for safety
    let nextDate = new Date(currentDate);
    
    switch (pattern) {
      case 'daily':
        nextDate.setDate(nextDate.getDate() + 1);
        break;
      case 'weekly':
        nextDate.setDate(nextDate.getDate() + 7);
        break;
      case 'monthly':
        nextDate.setMonth(nextDate.getMonth() + 1);
        break;
    }

    if (nextDate <= finalEndDate) {
      instances.push({
        hotelId: parentTask.hotelId,
        roomId: parentTask.roomId,
        taskType: parentTask.taskType,
        assignedToId: parentTask.assignedToId,
        assignedById: parentTask.assignedById,
        status: 'pending',
        priority: parentTask.priority,
        description: parentTask.description,
        scheduledFor: nextDate,
        estimatedDuration: parentTask.estimatedDuration,
        specialInstructions: parentTask.specialInstructions,
        isRecurring: false,
        parentTaskId: parentTask.id
      });
    }

    currentDate = nextDate;
  }

  if (instances.length > 0) {
    await prisma.task.createMany({
      data: instances
    });
    console.log(`✅ Generated ${instances.length} recurring task instances`);
  }
};

// Get all tasks for a hotel
const getTasks = async (req, res) => {
  try {
    const hotelId = req.user.hotelId;
    const { 
      page = 1, 
      limit = 20, 
      status,
      taskType,
      priority,
      assignedToId,
      roomId,
      scheduledDate,
      showRecurring = 'true'
    } = req.query;

    const skip = (parseInt(page) - 1) * parseInt(limit);

    // Build filters
    const filters = { hotelId };

    if (status) {
      filters.status = status;
    }

    if (taskType) {
      filters.taskType = taskType;
    }

    if (priority) {
      filters.priority = priority;
    }

    if (assignedToId) {
      filters.assignedToId = parseInt(assignedToId);
    }

    if (roomId) {
      filters.roomId = parseInt(roomId);
    }

    if (scheduledDate) {
      const date = new Date(scheduledDate);
      const nextDay = new Date(date);
      nextDay.setDate(date.getDate() + 1);
      
      filters.scheduledFor = {
        gte: date,
        lt: nextDay
      };
    }

    // Optionally hide recurring parent tasks
    if (showRecurring === 'false') {
      filters.isRecurring = false;
    }

    // Get tasks with pagination
    const [tasks, totalCount] = await prisma.$transaction([
      prisma.task.findMany({
        where: filters,
        skip,
        take: parseInt(limit),
        orderBy: [
          { priority: 'desc' },
          { scheduledFor: 'asc' },
          { createdAt: 'desc' }
        ],
        include: {
          assignedTo: {
            select: {
              id: true,
              name: true,
              role: true
            }
          },
          assignedBy: {
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
          },
          parentTask: {
            select: {
              id: true,
              description: true,
              recurrencePattern: true
            }
          }
        }
      }),
      prisma.task.count({ where: filters })
    ]);

    res.json({
      message: 'Tasks retrieved successfully',
      tasks,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: totalCount,
        totalPages: Math.ceil(totalCount / parseInt(limit))
      }
    });

  } catch (error) {
    console.error('Get tasks error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Get today's tasks (for daily management)
const getTodaysTasks = async (req, res) => {
  try {
    const hotelId = req.user.hotelId;
    const { assignedToId } = req.query;

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(today.getDate() + 1);

    const filters = {
      hotelId,
      OR: [
        {
          scheduledFor: {
            gte: today,
            lt: tomorrow
          }
        },
        {
          scheduledFor: null,
          status: { in: ['pending', 'in_progress'] }
        }
      ]
    };

    if (assignedToId) {
      filters.assignedToId = parseInt(assignedToId);
    }

    const tasks = await prisma.task.findMany({
      where: filters,
      orderBy: [
        { priority: 'desc' },
        { scheduledFor: 'asc' },
        { createdAt: 'asc' }
      ],
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
      }
    });

    // Group tasks by status for easy dashboard display
    const tasksByStatus = {
      pending: tasks.filter(t => t.status === 'pending'),
      in_progress: tasks.filter(t => t.status === 'in_progress'),
      completed: tasks.filter(t => t.status === 'completed'),
      cancelled: tasks.filter(t => t.status === 'cancelled')
    };

    res.json({
      message: 'Today\'s tasks retrieved successfully',
      date: today.toDateString(),
      tasks,
      tasksByStatus,
      summary: {
        total: tasks.length,
        pending: tasksByStatus.pending.length,
        inProgress: tasksByStatus.in_progress.length,
        completed: tasksByStatus.completed.length,
        cancelled: tasksByStatus.cancelled.length
      }
    });

  } catch (error) {
    console.error('Get today\'s tasks error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Get task by ID
const getTaskById = async (req, res) => {
  try {
    const { taskId } = req.params;
    const hotelId = req.user.hotelId;

    const task = await prisma.task.findFirst({
      where: {
        id: parseInt(taskId),
        hotelId
      },
      include: {
        assignedTo: {
          select: {
            id: true,
            name: true,
            role: true,
            phone: true
          }
        },
        assignedBy: {
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
            status: true,
            roomType: {
              select: {
                name: true
              }
            }
          }
        },
        parentTask: {
          select: {
            id: true,
            description: true,
            recurrencePattern: true
          }
        },
        childTasks: {
          select: {
            id: true,
            status: true,
            scheduledFor: true,
            completedAt: true
          },
          orderBy: {
            scheduledFor: 'asc'
          },
          take: 10
        }
      }
    });

    if (!task) {
      return res.status(404).json({ error: 'Task not found' });
    }

    res.json({
      message: 'Task retrieved successfully',
      task
    });

  } catch (error) {
    console.error('Get task by ID error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Update task
const updateTask = async (req, res) => {
  try {
    const { taskId } = req.params;
    const hotelId = req.user.hotelId;
    const updateData = updateTaskSchema.parse(req.body);

    console.log('📋 Updating task:', taskId, updateData);

    // Get existing task
    const existingTask = await prisma.task.findFirst({
      where: {
        id: parseInt(taskId),
        hotelId
      }
    });

    if (!existingTask) {
      return res.status(404).json({ error: 'Task not found' });
    }

    // If marking as completed, set completion time
    if (updateData.status === 'completed' && existingTask.status !== 'completed') {
      updateData.completedAt = new Date();
      if (!updateData.startedAt && existingTask.startedAt === null) {
        updateData.startedAt = new Date();
      }
    }

    // If marking as in progress, set start time
    if (updateData.status === 'in_progress' && existingTask.status === 'pending') {
      updateData.startedAt = new Date();
    }

    // Handle scheduling updates
    let updatedScheduledFor = undefined;
    if (updateData.scheduledFor) {
      updatedScheduledFor = new Date(updateData.scheduledFor);
    } else if (updateData.scheduledDate) {
      const schedDate = new Date(updateData.scheduledDate);
      if (updateData.scheduledTime) {
        const [hours, minutes] = updateData.scheduledTime.split(':');
        schedDate.setHours(parseInt(hours), parseInt(minutes), 0, 0);
      } else {
        schedDate.setHours(9, 0, 0, 0);
      }
      updatedScheduledFor = schedDate;
    }

    // Prepare data for database (exclude helper fields)
    const { scheduledDate, scheduledTime, ...dbUpdateData } = updateData;

    // Update task
    const updatedTask = await prisma.task.update({
      where: { id: parseInt(taskId) },
      data: {
        ...dbUpdateData,
        scheduledFor: updatedScheduledFor,
        recurrenceEndDate: updateData.recurrenceEndDate ? new Date(updateData.recurrenceEndDate) : undefined
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
      }
    });

    res.json({
      message: 'Task updated successfully',
      task: updatedTask
    });

  } catch (error) {
    console.error('Update task error:', error);
    
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        error: 'Validation failed',
        details: error.errors?.map(err => ({
          field: err.path?.join('.') || 'unknown',
          message: err.message
        })) || [{ field: 'unknown', message: 'Validation error' }]
      });
    }

    res.status(500).json({ error: 'Internal server error' });
  }
};

// Start task (for staff to begin working)
const startTask = async (req, res) => {
  try {
    const { taskId } = req.params;
    const hotelId = req.user.hotelId;

    const task = await prisma.task.findFirst({
      where: {
        id: parseInt(taskId),
        hotelId,
        status: 'pending'
      },
      include: {
        room: {
          select: {
            roomNumber: true
          }
        }
      }
    });

    if (!task) {
      return res.status(404).json({ error: 'Task not found or already started' });
    }

    // Check if user can start this task (assigned to them or unassigned)
    if (task.assignedToId && task.assignedToId !== req.user.userId) {
      return res.status(403).json({ error: 'Task is assigned to another user' });
    }

    const updatedTask = await prisma.task.update({
      where: { id: parseInt(taskId) },
      data: {
        status: 'in_progress',
        startedAt: new Date(),
        assignedToId: req.user.userId // Assign to current user if unassigned
      }
    });

    console.log('✅ Task started:', task.description, 'by user:', req.user.userId);

    res.json({
      message: 'Task started successfully',
      task: updatedTask
    });

  } catch (error) {
    console.error('Start task error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Complete task
const completeTask = async (req, res) => {
  try {
    const { taskId } = req.params;
    const { completionNotes } = req.body;
    const hotelId = req.user.hotelId;

    const task = await prisma.task.findFirst({
      where: {
        id: parseInt(taskId),
        hotelId,
        status: { in: ['pending', 'in_progress'] }
      },
      include: {
        room: true
      }
    });

    if (!task) {
      return res.status(404).json({ error: 'Task not found or already completed' });
    }

    // Update task as completed
    const updatedTask = await prisma.task.update({
      where: { id: parseInt(taskId) },
      data: {
        status: 'completed',
        completedAt: new Date(),
        startedAt: task.startedAt || new Date(),
        completionNotes: completionNotes || null
      }
    });

    // Auto-update room status if it's a cleaning task
    if (task.taskType === 'cleaning' && task.room && task.room.status === 'dirty') {
      await prisma.room.update({
        where: { id: task.roomId },
        data: { 
          status: 'available',
          lastUpdated: new Date(),
          notes: 'Cleaned and ready for guests'
        }
      });
      console.log('✅ Room', task.room.roomNumber, 'marked as available after cleaning');
    }

    console.log('✅ Task completed:', task.description);

    // 🔌 WEBSOCKET: Broadcast task completion
    if (global.socketServer) {
      const taskCompletionData = {
        taskId: task.id,
        taskType: task.taskType,
        description: task.description,
        priority: task.priority,
        roomNumber: task.room?.roomNumber,
        completedBy: {
          userId: req.user.userId,
          userName: req.user.name,
          userRole: req.user.role
        },
        completedAt: updatedTask.completedAt,
        completionNotes: updatedTask.completionNotes
      };

      // Notify managers about all task completions
      global.socketServer.broadcastToRole(hotelId, 'hotel_manager', 'task_completed', taskCompletionData);
      global.socketServer.broadcastToRole(hotelId, 'hotel_owner', 'task_completed', taskCompletionData);

      // Special notifications for urgent tasks
      if (task.priority === 'urgent') {
        global.socketServer.broadcastToHotel(hotelId, 'urgent_task_completed', taskCompletionData);
        console.log(`🚨 Urgent task completed notification sent for: ${task.description}`);
      }

      // If it was a cleaning task that updated room status
      if (task.taskType === 'cleaning' && task.room && task.room.status === 'dirty') {
        const roomReadyData = {
          ...taskCompletionData,
          roomId: task.roomId,
          roomNumber: task.room.roomNumber,
          newRoomStatus: 'available'
        };
        global.socketServer.broadcastToRole(hotelId, 'front_desk', 'room_cleaned_and_ready', roomReadyData);
      }

      console.log(`📡 WebSocket: Task completion broadcasted for task ${task.id}`);
    }

    // 📊 Update manager dashboard with new task completion stats
    await broadcastDashboardUpdate(hotelId);

    res.json({
      message: 'Task completed successfully',
      task: updatedTask
    });

  } catch (error) {
    console.error('Complete task error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Get task statistics
const getTaskStats = async (req, res) => {
  try {
    const hotelId = req.user.hotelId;
    const { fromDate, toDate, assignedToId } = req.query;

    const dateFilter = {};
    if (fromDate) dateFilter.gte = new Date(fromDate);
    if (toDate) dateFilter.lte = new Date(toDate);

    const whereClause = { hotelId };
    if (Object.keys(dateFilter).length > 0) {
      whereClause.createdAt = dateFilter;
    }
    if (assignedToId) {
      whereClause.assignedToId = parseInt(assignedToId);
    }

    const stats = await prisma.$transaction(async (tx) => {
      const totalTasks = await tx.task.count({ where: whereClause });
      
      const pendingTasks = await tx.task.count({
        where: { ...whereClause, status: 'pending' }
      });
      
      const inProgressTasks = await tx.task.count({
        where: { ...whereClause, status: 'in_progress' }
      });
      
      const completedTasks = await tx.task.count({
        where: { ...whereClause, status: 'completed' }
      });
      
      const cancelledTasks = await tx.task.count({
        where: { ...whereClause, status: 'cancelled' }
      });

      const tasksByType = await tx.task.groupBy({
        by: ['taskType'],
        where: whereClause,
        _count: true
      });

      const tasksByPriority = await tx.task.groupBy({
        by: ['priority'],
        where: whereClause,
        _count: true
      });

      return {
        totalTasks,
        pendingTasks,
        inProgressTasks,
        completedTasks,
        cancelledTasks,
        completionRate: totalTasks > 0 ? ((completedTasks / totalTasks) * 100).toFixed(2) : 0,
        tasksByType: tasksByType.reduce((acc, item) => {
          acc[item.taskType] = item._count;
          return acc;
        }, {}),
        tasksByPriority: tasksByPriority.reduce((acc, item) => {
          acc[item.priority] = item._count;
          return acc;
        }, {})
      };
    });

    res.json({
      message: 'Task statistics retrieved',
      stats,
      period: {
        fromDate: fromDate || 'All time',
        toDate: toDate || 'All time'
      }
    });

  } catch (error) {
    console.error('Task stats error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

module.exports = {
  createTask,
  getTasks,
  getTodaysTasks,
  getTaskById,
  updateTask,
  startTask,
  completeTask,
  getTaskStats
};