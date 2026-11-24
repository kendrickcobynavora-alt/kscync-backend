const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:Kcoby_112805@localhost:5432/kscync_db',
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

function validateAndSplitContainers(totalWeight, c1, c2) {
  const weight = totalWeight === null || totalWeight === undefined || totalWeight === '' ? 0 : parseFloat(totalWeight);

  if (isNaN(weight) || weight < 0) {
    throw new Error('Weight must be a valid positive number.');
  }

  if (weight === 0 || weight < 12.0) {
    return [
      {
        basket_number: 1,
        weight: weight,
        color: c1?.color || 'Green',
        material: c1?.material || 'Tote Bag',
        brand: c1?.brand || 'Unbranded'
      }
    ];
  } else if (weight >= 12.0 && weight <= 24.0) {
    const half = Number((weight / 2).toFixed(2));
    return [
      {
        basket_number: 1,
        weight: half,
        color: c1?.color || 'Green',
        material: c1?.material || 'Tote Bag',
        brand: c1?.brand || 'Unbranded'
      },
      {
        basket_number: 2,
        weight: Number((weight - half).toFixed(2)),
        color: c2?.color || c1?.color || 'Blue',
        material: c2?.material || 'Plastic Hamper',
        brand: c2?.brand || 'Generic'
      }
    ];
  }
  throw new Error('Loads above 24 kg must be logged as separate transactions.');
}

app.post('/api/register', async (req, res) => {
  const { full_name, phone_number, email, password } = req.body;
  try {
    const newUser = await pool.query(
      "INSERT INTO users (full_name, phone_number, email, password_hash, role) VALUES ($1, $2, $3, $4, 'customer') RETURNING *",
      [full_name, phone_number, email, password || 'kscync123']
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

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const userRes = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (userRes.rows.length === 0 || userRes.rows[0].password_hash !== password) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    const user = userRes.rows[0];
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

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const userRes = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (userRes.rows.length === 0 || userRes.rows[0].password_hash !== password) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    const user = userRes.rows[0];
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

app.put('/api/users/:id', async (req, res) => {
  const { id } = req.params;
  const { full_name, phone_number, email } = req.body;
  try {
    const updated = await pool.query(
      'UPDATE users SET full_name = $1, phone_number = $2, email = $3 WHERE user_id = $4 RETURNING *',
      [full_name, phone_number, email, parseInt(id, 10)]
    );
    if (updated.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    res.json({ message: 'Customer updated successfully', user: updated.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/users/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query('DELETE FROM users WHERE user_id = $1', [parseInt(id, 10)]);
    res.json({ message: 'Customer deleted successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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
    if (old_name !== full_name) {
      await pool.query('UPDATE orders SET customer_name = $1 WHERE customer_name = $2', [full_name, old_name]);
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

app.patch('/api/users/push-token', async (req, res) => {
  const { full_name, expo_push_token } = req.body;
  try {
    await pool.query(
      'UPDATE users SET expo_push_token = $1 WHERE full_name = $2',
      [expo_push_token, full_name]
    );
    res.json({ message: 'Push token saved' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/dashboard', async (req, res) => {
  try {
    const ordersRes = await pool.query(`
      SELECT o.*, 
        COALESCE(json_agg(c.*) FILTER (WHERE c.container_id IS NOT NULL), '[]') AS containers,
        EXISTS(SELECT 1 FROM reviews r WHERE r.order_id = o.order_id) AS has_review
      FROM orders o
      LEFT JOIN containers c ON o.order_id = c.order_id
      GROUP BY o.order_id
      ORDER BY o.created_at DESC
    `);

    const activeBasketsRes = await pool.query(`
      SELECT COUNT(c.container_id) AS count
      FROM containers c
      JOIN orders o ON c.order_id = o.order_id
      WHERE o.status NOT IN ('Completed', 'Picked Up')
    `);

    const reviewsRes = await pool.query('SELECT * FROM reviews ORDER BY created_at DESC LIMIT 20');
    const usersRes = await pool.query('SELECT user_id, full_name, phone_number, role, email, expo_push_token FROM users');
    const capRes = await pool.query('SELECT * FROM shop_capacity WHERE id = 1');
    const utilRes = await pool.query('SELECT * FROM utility_logs ORDER BY log_id DESC LIMIT 1');
    const annRes = await pool.query('SELECT * FROM announcements WHERE is_active = TRUE ORDER BY created_at DESC');

    const activeCount = parseInt(activeBasketsRes.rows[0].count || 0);
    const maxBaskets = capRes.rows[0]?.max_active_baskets || 10;
    const threshold = (capRes.rows[0]?.tight_threshold_percent || 75) / 100;
    const capacityStatus = (activeCount / maxBaskets) >= threshold ? 'Tight' : 'Loose';

    const util = utilRes.rows[0] || { water_cost: 5500, electricity_cost: 20000, detergent_supplies_cost: 15000, total_volume_kg: 3000 };
    const totalUtilityCost = Number(util.water_cost) + Number(util.electricity_cost) + Number(util.detergent_supplies_cost);
    const overheadPerKg = Number((totalUtilityCost / Number(util.total_volume_kg)).toFixed(2));

    res.json({
      orders: ordersRes.rows,
      reviews: reviewsRes.rows,
      users: usersRes.rows,
      announcements: annRes.rows,
      capacity: { activeBaskets: activeCount, maxBaskets, status: capacityStatus, tight_threshold_percent: capRes.rows[0]?.tight_threshold_percent || 75 },
      utility: { ...util, totalUtilityCost, overheadPerKg }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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

app.post('/api/orders', async (req, res) => {
  const { customer_name, booking_type, total_weight_kg, target_completion_time, container1, container2 } = req.body;
  try {
    const safeWeight = total_weight_kg === null || total_weight_kg === undefined || total_weight_kg === '' ? 0 : parseFloat(total_weight_kg);
    const splitBaskets = validateAndSplitContainers(safeWeight, container1, container2);

    const newOrder = await pool.query(
      `INSERT INTO orders (customer_name, booking_type, total_weight_kg, target_completion_time, status, payment_status)
       VALUES ($1, $2, $3, $4, 'Received', 'Unpaid') RETURNING *`,
      [customer_name, booking_type, safeWeight, target_completion_time || 'Same Day, 6:00 PM - 8:00 PM']
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

app.patch('/api/orders/:id/weigh', async (req, res) => {
  const { id } = req.params;
  const { total_weight_kg, container_description, containers } = req.body;
  try {
    const updated = await pool.query(
      "UPDATE orders SET total_weight_kg = $1, status = 'Received at Shop' WHERE order_id = $2 RETURNING *",
      [parseFloat(total_weight_kg), parseInt(id, 10)]
    );

    if (updated.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }

    if (containers && Array.isArray(containers) && containers.length > 0) {
      await pool.query('DELETE FROM containers WHERE order_id = $1', [parseInt(id, 10)]);
      for (const b of containers) {
        await pool.query(
          `INSERT INTO containers (order_id, basket_number, assigned_weight_kg, color, material, brand) 
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            parseInt(id, 10), 
            b.basket_number || 1, 
            b.assigned_weight_kg || total_weight_kg || 0, 
            b.color || container_description || 'Standard Bag',
            b.material || 'Tote Bag',
            b.brand || 'Unbranded'
          ]
        );
      }
    } else {
      const checkContainer = await pool.query('SELECT * FROM containers WHERE order_id = $1 AND basket_number = 1', [parseInt(id, 10)]);
      if (checkContainer.rows.length > 0) {
        await pool.query(
          'UPDATE containers SET color = $1, assigned_weight_kg = $2 WHERE order_id = $3 AND basket_number = 1',
          [container_description || 'Standard Bag', parseFloat(total_weight_kg), parseInt(id, 10)]
        );
      } else {
        await pool.query(
          `INSERT INTO containers (order_id, basket_number, assigned_weight_kg, color, material, brand) 
           VALUES ($1, 1, $2, $3, $4, $5)`,
          [parseInt(id, 10), parseFloat(total_weight_kg), container_description || 'Standard Bag', 'Tote Bag', 'Unbranded']
        );
      }
    }
    res.json(updated.rows[0]);
  } catch (err) {
    console.error('Weigh-in error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/orders/:id/status', async (req, res) => {
  const { id } = req.params;
  const { status, total_weight_kg, containers } = req.body;
  try {
    let updated;
    if (total_weight_kg !== undefined && total_weight_kg !== null && total_weight_kg !== '') {
      updated = await pool.query(
        'UPDATE orders SET status = $1, total_weight_kg = $2 WHERE order_id = $3 RETURNING *',
        [status, parseFloat(total_weight_kg), parseInt(id, 10)]
      );
    } else {
      updated = await pool.query(
        'UPDATE orders SET status = $1 WHERE order_id = $2 RETURNING *',
        [status, parseInt(id, 10)]
      );
    }

    const order = updated.rows[0];
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    if (containers && Array.isArray(containers) && containers.length > 0) {
      await pool.query('DELETE FROM containers WHERE order_id = $1', [parseInt(id, 10)]);
      for (const b of containers) {
        await pool.query(
          'INSERT INTO containers (order_id, basket_number, assigned_weight_kg, color, material, brand) VALUES ($1, $2, $3, $4, $5, $6)',
          [parseInt(id, 10), b.basket_number || 1, b.assigned_weight_kg || total_weight_kg || 0, b.color || 'Standard Bag', 'Tote Bag', 'Unbranded']
        );
      }
    }

    try {
      const userRes = await pool.query(
        'SELECT expo_push_token FROM users WHERE full_name = $1',
        [order.customer_name]
      );
      const pushToken = userRes.rows[0]?.expo_push_token;
      if (pushToken) {
        await fetch('https://exp.host/--/api/v2/push/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            to: pushToken,
            sound: 'default',
            title: 'KSCync Laundry Update',
            body: `Hi ${order.customer_name}! Your laundry status is now: ${status.toUpperCase()}.`
          })
        });
      }
    } catch (pushErr) {
      console.log('Push notification skipped:', pushErr.message);
    }

    res.json(order);
  } catch (err) {
    console.error('Status update error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/orders/:id/payment', async (req, res) => {
  const { id } = req.params;
  const { payment_status } = req.body;
  try {
    const updated = await pool.query(
      'UPDATE orders SET payment_status = $1 WHERE order_id = $2 RETURNING *',
      [payment_status || 'Paid', parseInt(id, 10)]
    );
    res.json(updated.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/reviews', async (req, res) => {
  const { order_id, customer_name, rating, feedback } = req.body;
  try {
    const result = await pool.query(
      'INSERT INTO reviews (order_id, customer_name, rating, feedback) VALUES ($1, $2, $3, $4) RETURNING *',
      [order_id, customer_name, rating, feedback || '']
    );
    res.status(201).json({ message: 'Review submitted', review: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/announcements', async (req, res) => {
  const { title, message } = req.body;
  try {
    const result = await pool.query(
      'INSERT INTO announcements (title, message, is_active) VALUES ($1, $2, TRUE) RETURNING *',
      [title, message]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/announcements/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query('DELETE FROM announcements WHERE announcement_id = $1', [parseInt(id, 10)]);
    res.json({ message: 'Announcement deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => console.log(`KSCync Backend API running on port ${PORT}`));
