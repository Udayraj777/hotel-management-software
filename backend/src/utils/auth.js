const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '24h';

const hashPassword = async (password) => {
  const saltRounds = 12;
  return await bcrypt.hash(password, saltRounds);
};

const comparePassword = async (password, hashedPassword) => {
  return await bcrypt.compare(password, hashedPassword);
};

const generateToken = (payload) => {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
};

const verifyToken = (token) => {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (error) {
    throw new Error('Invalid or expired token');
  }
};

const getUserRoleHierarchy = () => {
  return {
    'platform_admin': ['platform_admin'],
    'hotel_owner': ['hotel_owner', 'hotel_manager', 'front_desk'],
    'hotel_manager': ['hotel_manager', 'front_desk'],
    'front_desk': ['front_desk']
  };
};

const hasPermission = (userRole, requiredRole) => {
  const hierarchy = getUserRoleHierarchy();
  return hierarchy[userRole]?.includes(requiredRole) || false;
};

module.exports = {
  hashPassword,
  comparePassword,
  generateToken,
  verifyToken,
  getUserRoleHierarchy,
  hasPermission
};