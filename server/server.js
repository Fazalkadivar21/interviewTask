const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const dotenv = require('dotenv');
const { body, validationResult } = require('express-validator');

console.log('Starting server...');

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// Database connection pool
const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || 'password',
  database: process.env.DB_NAME || 'technova_db',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

console.log('Database connection configured');

// Enhanced password validation
const passwordValidation = body('password')
  .isLength({ min: 8 }).withMessage('Password must be at least 8 characters')
  .matches(/[A-Z]/).withMessage('Password must contain at least one uppercase letter')
  .matches(/[a-z]/).withMessage('Password must contain at least one lowercase letter')
  .matches(/[0-9]/).withMessage('Password must contain at least one number')
  .matches(/[!@#$%^&*(),.?":{}|<>]/).withMessage('Password must contain at least one special character');

// Validation middleware
const validateUser = [
  body('name').trim().isLength({ min: 2 }).withMessage('Name must be at least 2 characters'),
  body('email').isEmail().withMessage('Invalid email address'),
  // Use different validations for create vs update
  body('password').custom((value, { req }) => {
    // Skip validation if updating user and password is empty
    if (req.method === 'PUT' && (!value || value.trim() === '')) {
      return true;
    }
    
    // Otherwise run full validation
    const result = passwordValidation.run(req);
    return result.then(() => true).catch(error => {
      throw new Error(error.msg);
    });
  }),
  body('role').isIn(['user', 'admin', 'developer']).withMessage('Invalid role'),
  body('phone').optional().matches(/^[+]?[(]?[0-9]{1,4}[)]?[-\s.]?[0-9]{1,4}[-\s.]?[0-9]{1,9}$/).withMessage('Invalid phone number format'),
  body('skills').isArray().withMessage('Skills must be an array')
];

// Database initialization
async function initializeDatabase() {
  try {
    console.log('Attempting to initialize database...');
    const connection = await pool.getConnection();
    
    // Create users table if not exists
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        email VARCHAR(100) NOT NULL UNIQUE,
        password VARCHAR(255) NOT NULL,
        phone VARCHAR(20),
        role ENUM('user', 'admin', 'developer') DEFAULT 'user',
        skills JSON,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);
    
    console.log('Database initialized successfully');
    connection.release();
    return true;
  } catch (error) {
    console.error('Error initializing database:', error);
    return false;
  }
}

// API Routes
// Get all users
app.get('/api/users', async (req, res) => {
  try {
    const [rows] = await pool.execute('SELECT id, name, email, phone, role, skills FROM users');
    
    // Parse JSON skills field
    const users = rows.map(user => ({
      ...user,
      skills: JSON.parse(user.skills || '[]')
    }));
    
    res.json(users);
  } catch (error) {
    console.error('Error fetching users:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get user by ID
app.get('/api/users/:id', async (req, res) => {
  try {
    const [rows] = await pool.execute(
      'SELECT id, name, email, phone, role, skills FROM users WHERE id = ?',
      [req.params.id]
    );
    
    if (rows.length === 0) {
      return res.status(404).json({ message: 'User not found' });
    }
    
    const user = {
      ...rows[0],
      skills: JSON.parse(rows[0].skills || '[]')
    };
    
    res.json(user);
  } catch (error) {
    console.error('Error fetching user:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Create user
app.post('/api/users', validateUser, async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }
  
  const { name, email, password, phone, role, skills } = req.body;
  
  try {
    // Check if email already exists
    const [existingUsers] = await pool.execute('SELECT id FROM users WHERE email = ?', [email]);
    if (existingUsers.length > 0) {
      return res.status(400).json({ message: 'Email already registered' });
    }
    
    // Hash password with higher cost factor (12) for better security
    const salt = await bcrypt.genSalt(12);
    const hashedPassword = await bcrypt.hash(password, salt);
    
    // Insert user
    const [result] = await pool.execute(
      'INSERT INTO users (name, email, password, phone, role, skills) VALUES (?, ?, ?, ?, ?, ?)',
      [name, email, hashedPassword, phone, role, JSON.stringify(skills || [])]
    );
    
    res.status(201).json({
      id: result.insertId,
      name,
      email,
      phone,
      role,
      skills
    });
  } catch (error) {
    console.error('Error creating user:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Update user
app.put('/api/users/:id', validateUser, async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }
  
  const { name, email, password, phone, role, skills } = req.body;
  const userId = req.params.id;
  
  try {
    // Check if user exists
    const [existingUser] = await pool.execute('SELECT id FROM users WHERE id = ?', [userId]);
    if (existingUser.length === 0) {
      return res.status(404).json({ message: 'User not found' });
    }
    
    // Check if email is already used by another user
    if (email) {
      const [emailCheck] = await pool.execute(
        'SELECT id FROM users WHERE email = ? AND id != ?',
        [email, userId]
      );
      if (emailCheck.length > 0) {
        return res.status(400).json({ message: 'Email already in use by another account' });
      }
    }
    
    // Update user
    if (password && password.trim() !== '') {
      // If password is provided, hash it with higher cost factor
      const salt = await bcrypt.genSalt(12);
      const hashedPassword = await bcrypt.hash(password, salt);
      
      await pool.execute(
        'UPDATE users SET name = ?, email = ?, password = ?, phone = ?, role = ?, skills = ? WHERE id = ?',
        [name, email, hashedPassword, phone, role, JSON.stringify(skills || []), userId]
      );
    } else {
      // If no password, don't update password field
      await pool.execute(
        'UPDATE users SET name = ?, email = ?, phone = ?, role = ?, skills = ? WHERE id = ?',
        [name, email, phone, role, JSON.stringify(skills || []), userId]
      );
    }
    
    res.json({ message: 'User updated successfully' });
  } catch (error) {
    console.error('Error updating user:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Delete user
app.delete('/api/users/:id', async (req, res) => {
  try {
    const [result] = await pool.execute('DELETE FROM users WHERE id = ?', [req.params.id]);
    
    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'User not found' });
    }
    
    res.json({ message: 'User deleted successfully' });
  } catch (error) {
    console.error('Error deleting user:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Health check route
app.get('/', (req, res) => {
  res.json({ message: 'TechNova API is running' });
});

// Initialize the database and start the server
const PORT = process.env.PORT || 5000;

initializeDatabase()
  .then((success) => {
    if (success) {
      app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
    } else {
      console.error('Failed to initialize database. Server not started.');
      process.exit(1);
    }
  })
  .catch(err => {
    console.error('Failed to initialize application:', err);
    process.exit(1);
  });