const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

// Connect to PostgreSQL (Uses Render's DATABASE_URL for Neon in cloud, falls back to local DB)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:Kcoby_112805@localhost:5432/kscync_db',
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// Container Splitting Logic: 8 kg max per basket; >= 9 kg splits into 2 baskets
function validateAndSplitContainers(totalWeight, c1, c2) {
  const weight = parseFloat(totalWeight);
  if (weight <= 8.0) {
    return [
      { basket_number: 1, weight: weight, color: c1?.color || 'Green', material: c1?.material || 'Tote Bag', brand: c1?.brand || 'Unbranded' }
    ];
  } else if (weight >= 9.0 && weight <= 16.0) {
    return [
      { basket_number: 1, weight: 8.0, color: c1?.color || 'Green', material: c1?.material || 'Tote Bag', brand: c1?.brand || 'Unbranded' },
      {
        basket_number: 2,
        weight: Number((weight - 8.0).toFixed(2)),
        color: c2?.color || 'Blue',
        material: c2?.material || 'Plastic Hamper',
        brand: c2?.brand || 'Generic'
      }
    ];
  }
  throw new Error('Loads between 8.01 kg and 8.99 kg are invalid or loads > 16 kg must be logged as separate transactions.');
}

// POST: Register Endpoint (Now saves phone_number)
app.post('/api/register', async (req, res) => {
  const { full_name, phone_number, email, password } = req.body;
  try {
    const newUser = await pool.query(
      "INSERT INTO users (full_name, phone_number, email, password_hash, role) VALUES ($1, $2, $3, $4, 'customer') RETURNING *",
      [full_name, phone_number, email, password]
    );
    res.status(201).json({ 
      message: 'Registration successful', 
      user: { 
        id: newUser.rows[0].user_id, 
        name: newUser.rows[0].full_name, 
        phone: newUser.rows[0].phone_number,
        role: newUser.rows[0].role, 
        email: newUser.rows[0].email 
      } 
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST: Login Endpoint with Role Verification (RBAC) (Now returns phone)
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const userRes = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (userRes.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    const user = userRes.rows[0];
    if (user.password_hash !== password) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    res.json({ 
      message: 'Login successful', 
      user: { 
        id: user.user_id, 
        name: user.full_name, 
        phone: user.phone_number,
        role: user.role, 
        email: user.email 
      } 
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH: Update User Profile (Username & Mobile Number)
app.patch('/api/users/update', async (req, res) => {
  const { old_name, full_name, phone_number } = req.body;
  try {
    const updatedUser = await pool.query(
      'UPDATE users SET full_name = $1, phone_number = $2 WHERE full_name = $3 RETURNING *',
      [full_name, phone_number, old_name]
    );

    if (updatedUser.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Keep existing orders linked to the updated username
    if (old_name !== full_name) {
      await pool.query(
        'UPDATE orders SET customer_name = $1 WHERE customer_name = $2',
        [full_name, old_name]
      );
    }

    res.json({
      message: 'Profile updated successfully',
      user: {
        id: updatedUser.rows[0].user_id,
        name: updatedUser.rows[0].full_name,
        phone: updatedUser.rows[0].phone_number
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET: Fetch Live Shop Capacity, Orders, and Utility Overhead Rate
app.get('/api/dashboard', async (req, res) => {
  try {
    const ordersRes = await pool.query(`
      SELECT o.*, 
        COALESCE(json_agg(c.*) FILTER (WHERE c.container_id IS NOT NULL), '[]') AS containers
      FROM orders o
      LEFT JOIN containers c ON o.order_id = c.order_id
      GROUP BY o.order_id
      ORDER BY o.created_at DESC
    `);

    const activeBasketsRes = await pool.query(`
      SELECT COUNT(c.container_id) AS count
      FROM containers c
      JOIN orders o ON c.order_id = o.order_id
      WHERE o.status NOT IN ('Completed')
    `);

    const capRes = await pool.query('SELECT * FROM shop_capacity WHERE id = 1');
    const utilRes = await pool.query('SELECT * FROM utility_logs ORDER BY log_id DESC LIMIT 1');

    const activeCount = parseInt(activeBasketsRes.rows[0].count || 0);
    const maxBaskets = capRes.rows[0]?.max_active_baskets || 10;
    const threshold = (capRes.rows[0]?.tight_threshold_percent || 75) / 100;
    const capacityStatus = (activeCount / maxBaskets) >= threshold ? 'Tight' : 'Loose';

    const util = utilRes.rows[0] || { water_cost: 5500, electricity_cost: 20000, detergent_supplies_cost: 15000, total_volume_kg: 3000 };
    const totalUtilityCost = Number(util.water_cost) + Number(util.electricity_cost) + Number(util.detergent_supplies_cost);
    const overheadPerKg = Number((totalUtilityCost / Number(util.total_volume_kg)).toFixed(2));

    res.json({
      orders: ordersRes.rows,
      capacity: { activeBaskets: activeCount, maxBaskets, status: capacityStatus, tight_threshold_percent: capRes.rows[0]?.tight_threshold_percent || 75 },
      utility: { ...util, totalUtilityCost, overheadPerKg }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH: Update Shop Capacity Configuration
app.patch('/api/capacity', async (req, res) => {
  const { max_active_baskets, tight_threshold_percent } = req.body;
  try {
    const updated = await pool.query(
      'UPDATE shop_capacity SET max_active_baskets = $1, tight_threshold_percent = $2 WHERE id = 1 RETURNING *',
      [max_active_baskets, tight_threshold_percent]
    );
    res.json({ message: 'Capacity settings updated', capacity: updated.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST: Create New Order & Assign Physical Containers
app.post('/api/orders', async (req, res) => {
  const { customer_name, booking_type, total_weight_kg, target_completion_time, container1, container2 } = req.body;
  try {
    const splitBaskets = validateAndSplitContainers(total_weight_kg, container1, container2);

    const newOrder = await pool.query(
      `INSERT INTO orders (customer_name, booking_type, total_weight_kg, target_completion_time, status)
       VALUES ($1, $2, $3, $4, 'Received') RETURNING *`,
      [customer_name, booking_type, total_weight_kg, target_completion_time || 'Same Day']
    );

    const orderId = newOrder.rows[0].order_id;
    for (const basket of splitBaskets) {
      await pool.query(
        `INSERT INTO containers (order_id, basket_number, assigned_weight_kg, color, material, brand)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [orderId, basket.basket_number, basket.weight, basket.color, basket.material, basket.brand]
      );
    }

    res.status(201).json({ message: 'Order created', order: newOrder.rows[0], baskets: splitBaskets });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// PATCH: Advance Order Stage (Received -> Washing -> Drying -> Folding -> Ready -> Completed)
app.patch('/api/orders/:id/status', async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  try {
    const updated = await pool.query(
      'UPDATE orders SET status = $1 WHERE order_id = $2 RETURNING *',
      [status, id]
    );
    res.json(updated.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => console.log(`KSCync Backend API running on port ${PORT}`));