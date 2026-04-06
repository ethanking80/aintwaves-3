import { neon } from '@neondatabase/serverless';
import crypto from 'crypto';

const sql = neon(process.env.NETLIFY_DATABASE_URL || process.env.DATABASE_URL);

const json = (data, status = 200) => ({
  statusCode: status,
  headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': '*', 'Access-Control-Allow-Headers': '*' },
  body: JSON.stringify(data)
});

function genToken() { return crypto.randomBytes(32).toString('hex'); }

async function getUserByToken(token) {
  if (!token) return null;
  try {
    const [session] = await sql`SELECT * FROM sessions WHERE id = ${token} AND expires_at > NOW()`;
    if (!session) return null;
    if (session.is_admin) return { id: 'admin', name: 'Admin', email: 'admin@airwaves.com', role: 'admin', _isAdmin: true };
    const [user] = await sql`SELECT * FROM customers WHERE id = ${session.customer_id}`;
    return user || null;
  } catch { return null; }
}

async function requireAdmin(token) {
  const user = await getUserByToken(token);
  return (user && user._isAdmin) ? user : null;
}

let logTableReady = false;
async function ensureLogTable() {
  if (logTableReady) return;
  try {
    await sql`CREATE TABLE IF NOT EXISTS activity_log (
      id SERIAL PRIMARY KEY, action VARCHAR(100) NOT NULL, category VARCHAR(50) NOT NULL,
      actor VARCHAR(255) DEFAULT 'system', target VARCHAR(255) DEFAULT '', details TEXT DEFAULT '',
      ip VARCHAR(50) DEFAULT '', created_at TIMESTAMP DEFAULT NOW()
    )`;
    logTableReady = true;
  } catch {}
}

async function log(action, category, actor, target, details, ip) {
  try {
    await ensureLogTable();
    await sql`INSERT INTO activity_log (action, category, actor, target, details, ip) VALUES (${action}, ${category}, ${actor || 'system'}, ${target || ''}, ${details || ''}, ${ip || ''})`;
  } catch (e) { console.error('Log error:', e.message); }
}

export async function handler(event) {
  const method = event.httpMethod;
  const rawPath = event.path.replace('/.netlify/functions/api', '').replace('/api', '') || '/';
  const params = event.queryStringParameters || {};
  const sessionId = params.session || 'guest';
  const clientIp = event.headers?.['x-forwarded-for']?.split(',')[0]?.trim() || event.headers?.['client-ip'] || '';

  if (method === 'OPTIONS') {
    return { statusCode: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': '*', 'Access-Control-Allow-Headers': '*' }};
  }

  const authHeader = event.headers?.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  try {
    // ===== AUTH =====
    if (rawPath === '/auth') {
      const action = params.action;

      if (action === 'me' && method === 'GET') {
        const user = await getUserByToken(token);
        if (!user) return json({ user: null });
        return json({ user: { id: user.id, name: user.name || user.username, email: user.email, role: user._isAdmin ? 'admin' : 'customer' } });
      }

      if (action === 'login' && method === 'POST') {
        const { email, password } = JSON.parse(event.body || '{}');
        if (!email || !password) return json({ error: 'Email and password required' }, 400);

        // Admin login
        if ((email === 'admin' || email === 'admin@airwaves.com') && password === 'airwaves1') {
          const tok = genToken();
          const expires = new Date(Date.now() + 86400000);
          await sql`INSERT INTO sessions (id, customer_id, is_admin, expires_at) VALUES (${tok}, NULL, true, ${expires})`;
          await log('login', 'auth', 'admin', 'admin@airwaves.com', 'Admin login successful', clientIp);
          return json({ token: tok, user: { id: 'admin', name: 'Admin', email: 'admin@airwaves.com', role: 'admin' } });
        }

        const [user] = await sql`SELECT * FROM customers WHERE (LOWER(email) = LOWER(${email}) OR LOWER(username) = LOWER(${email})) AND password = ${password}`;
        if (!user) {
          await log('login_failed', 'auth', email, email, 'Invalid credentials', clientIp);
          return json({ error: 'Invalid credentials' }, 401);
        }

        const tok = genToken();
        const expires = new Date(Date.now() + 86400000);
        await sql`INSERT INTO sessions (id, customer_id, is_admin, expires_at) VALUES (${tok}, ${user.id}, false, ${expires})`;
        try { await sql`UPDATE cart_items SET session_id = ${tok} WHERE session_id = ${sessionId}`; } catch {}

        await log('login', 'auth', user.name || user.username, user.email, 'Customer login successful', clientIp);
        return json({ token: tok, user: { id: user.id, name: user.name || user.username, email: user.email, role: 'customer' } });
      }

      if (action === 'register' && method === 'POST') {
        const { email, password, name } = JSON.parse(event.body || '{}');
        if (!email || !password || !name) return json({ error: 'All fields required' }, 400);

        const [existing] = await sql`SELECT id FROM customers WHERE LOWER(email) = LOWER(${email})`;
        if (existing) {
          await log('register_failed', 'auth', name, email, 'Email already exists', clientIp);
          return json({ error: 'Email already exists' }, 400);
        }

        const id = 'c' + Date.now().toString(36);
        await sql`INSERT INTO customers (id, username, email, password, name, age_verified) VALUES (${id}, ${name}, ${email}, ${password}, ${name}, true)`;

        const tok = genToken();
        const expires = new Date(Date.now() + 86400000);
        await sql`INSERT INTO sessions (id, customer_id, is_admin, expires_at) VALUES (${tok}, ${id}, false, ${expires})`;
        try { await sql`UPDATE cart_items SET session_id = ${tok} WHERE session_id = ${sessionId}`; } catch {}

        await log('register', 'auth', name, email, `New customer account created (${id})`, clientIp);
        return json({ token: tok, user: { id, name, email, role: 'customer' } });
      }

      if (action === 'logout' && method === 'POST') {
        const user = await getUserByToken(token);
        if (user) {
          await log('logout', 'auth', user.name || user.username || 'admin', user.email, 'User logged out', clientIp);
        }
        if (token) {
          try { await sql`DELETE FROM sessions WHERE id = ${token}`; } catch {}
        }
        return json({ success: true });
      }

      return json({ error: 'Unknown auth action' }, 400);
    }

    // ===== PRODUCTS =====
    if (rawPath === '/products') {
      if (method === 'GET') {
        const products = await sql`SELECT * FROM products ORDER BY id`;
        return json(products.map(p => ({
          id: p.id, name: p.name, description: p.description || '',
          price: parseFloat(p.price), image_url: p.image_url || p.image || '',
          category: p.category || '', strain_type: p.strain_type || '',
          thc_content: p.thc_content || p.thc || '', cbd_content: p.cbd_content || p.cbd || '',
          weight: p.weight || '', stock: p.stock || 0,
          featured: p.featured || false, active: p.active !== false,
          created_at: p.created_at
        })));
      }

      if (method === 'POST') {
        const admin = await requireAdmin(token);
        if (!admin) return json({ error: 'Admin only' }, 403);
        const d = JSON.parse(event.body || '{}');
        const [product] = await sql`
          INSERT INTO products (name, category, price, strain_type, thc_content, cbd_content, weight, description, stock, image_url, featured)
          VALUES (${d.name || 'New Product'}, ${d.category || 'Flower'}, ${d.price || 0}, ${d.strain_type || ''}, ${d.thc_content || ''}, ${d.cbd_content || ''}, ${d.weight || ''}, ${d.description || ''}, ${d.stock || 0}, ${d.image_url || ''}, ${d.featured || false})
          RETURNING *
        `;
        await log('product_created', 'product', 'Admin', d.name, `New product: ${d.name} @ $${d.price}, stock: ${d.stock || 0}, category: ${d.category || 'Flower'}`, clientIp);
        return json({ success: true, product });
      }

      if (method === 'PUT') {
        const pid = parseInt(params.id);
        if (!pid) return json({ error: 'Missing product id' }, 400);
        const d = JSON.parse(event.body || '{}');
        const changes = [];
        if (d.name !== undefined) { await sql`UPDATE products SET name = ${d.name} WHERE id = ${pid}`; changes.push(`name="${d.name}"`); }
        if (d.price !== undefined) { await sql`UPDATE products SET price = ${d.price} WHERE id = ${pid}`; changes.push(`price=$${d.price}`); }
        if (d.description !== undefined) { await sql`UPDATE products SET description = ${d.description} WHERE id = ${pid}`; changes.push('description updated'); }
        if (d.category !== undefined) { await sql`UPDATE products SET category = ${d.category} WHERE id = ${pid}`; changes.push(`category="${d.category}"`); }
        if (d.strain_type !== undefined) { await sql`UPDATE products SET strain_type = ${d.strain_type} WHERE id = ${pid}`; changes.push(`strain="${d.strain_type}"`); }
        if (d.thc_content !== undefined) { await sql`UPDATE products SET thc_content = ${d.thc_content} WHERE id = ${pid}`; changes.push(`thc="${d.thc_content}"`); }
        if (d.cbd_content !== undefined) { await sql`UPDATE products SET cbd_content = ${d.cbd_content} WHERE id = ${pid}`; changes.push(`cbd="${d.cbd_content}"`); }
        if (d.weight !== undefined) { await sql`UPDATE products SET weight = ${d.weight} WHERE id = ${pid}`; changes.push(`weight="${d.weight}"`); }
        if (d.stock !== undefined) { await sql`UPDATE products SET stock = ${d.stock} WHERE id = ${pid}`; changes.push(`stock=${d.stock}`); }
        if (d.image_url !== undefined) { await sql`UPDATE products SET image_url = ${d.image_url} WHERE id = ${pid}`; changes.push('image updated'); }
        if (d.featured !== undefined) { await sql`UPDATE products SET featured = ${d.featured} WHERE id = ${pid}`; changes.push(`featured=${d.featured}`); }
        const actor = (await getUserByToken(token))?.name || 'system';
        await log('product_updated', 'product', actor, `product #${pid}`, changes.join(', '), clientIp);
        return json({ success: true });
      }

      if (method === 'DELETE') {
        const admin = await requireAdmin(token);
        if (!admin) return json({ error: 'Admin only' }, 403);
        const pid = parseInt(params.id);
        if (!pid) return json({ error: 'Missing product id' }, 400);
        const [p] = await sql`SELECT name FROM products WHERE id = ${pid}`;
        await sql`DELETE FROM cart_items WHERE product_id = ${pid}`;
        await sql`DELETE FROM products WHERE id = ${pid}`;
        await log('product_deleted', 'product', 'Admin', p?.name || `#${pid}`, `Product removed from catalog`, clientIp);
        return json({ success: true });
      }
    }

    // ===== CART =====
    if (rawPath === '/cart') {
      const user = await getUserByToken(token);
      const sid = user ? token : sessionId;
      const actorName = user ? (user.name || user.username || 'customer') : `guest(${sessionId.slice(0,8)})`;

      const getCart = async () => {
        const items = await sql`
          SELECT ci.id, ci.product_id, ci.quantity, p.name, p.price, p.category, p.weight,
                 COALESCE(p.image_url, p.image, '') as image_url
          FROM cart_items ci JOIN products p ON ci.product_id = p.id WHERE ci.session_id = ${sid}
        `;
        const total = items.reduce((s, i) => s + parseFloat(i.price) * i.quantity, 0);
        return {
          items: items.map(i => ({ id: i.id, product_id: i.product_id, name: i.name, price: parseFloat(i.price), category: i.category, weight: i.weight, image_url: i.image_url, quantity: i.quantity })),
          total: total.toFixed(2),
          count: items.reduce((s, i) => s + i.quantity, 0)
        };
      };

      if (method === 'GET') return json(await getCart());

      if (method === 'POST') {
        const { product_id, quantity = 1 } = JSON.parse(event.body || '{}');
        const [product] = await sql`SELECT * FROM products WHERE id = ${product_id}`;
        if (!product) return json({ error: 'Product not found' }, 404);
        await sql`
          INSERT INTO cart_items (session_id, product_id, quantity) VALUES (${sid}, ${product_id}, ${quantity})
          ON CONFLICT (session_id, product_id) DO UPDATE SET quantity = cart_items.quantity + ${quantity}
        `;
        await log('cart_add', 'cart', actorName, product.name, `Added ${quantity}x ${product.name} ($${parseFloat(product.price).toFixed(2)} ea)`, clientIp);
        return json(await getCart());
      }

      const itemId = params.id;
      if (itemId && method === 'PUT') {
        const { quantity } = JSON.parse(event.body || '{}');
        const [item] = await sql`SELECT ci.*, p.name FROM cart_items ci JOIN products p ON ci.product_id = p.id WHERE ci.id = ${itemId}`;
        if (quantity <= 0) {
          await sql`DELETE FROM cart_items WHERE id = ${itemId} AND session_id = ${sid}`;
          await log('cart_remove', 'cart', actorName, item?.name || `item#${itemId}`, `Removed from cart (qty set to 0)`, clientIp);
        } else {
          await sql`UPDATE cart_items SET quantity = ${quantity} WHERE id = ${itemId} AND session_id = ${sid}`;
          await log('cart_update', 'cart', actorName, item?.name || `item#${itemId}`, `Quantity changed to ${quantity}`, clientIp);
        }
      }
      if (itemId && method === 'DELETE') {
        const [item] = await sql`SELECT ci.*, p.name FROM cart_items ci JOIN products p ON ci.product_id = p.id WHERE ci.id = ${itemId}`;
        await sql`DELETE FROM cart_items WHERE id = ${itemId} AND session_id = ${sid}`;
        await log('cart_remove', 'cart', actorName, item?.name || `item#${itemId}`, `Item removed from cart`, clientIp);
      }
      if (itemId) return json(await getCart());
    }

    // ===== ORDERS =====
    if (rawPath === '/orders') {
      const user = await getUserByToken(token);

      if (method === 'GET') {
        if (!user) return json({ error: 'Not logged in' }, 401);
        const orders = (user._isAdmin || params.all === 'true')
          ? await sql`SELECT * FROM orders ORDER BY created_at DESC`
          : await sql`SELECT * FROM orders WHERE customer_id = ${user.id} ORDER BY created_at DESC`;
        const result = [];
        for (const o of orders) {
          let items = [];
          try { items = await sql`SELECT * FROM order_items WHERE order_id = ${o.id}`; } catch {}
          result.push({
            ...o, subtotal: parseFloat(o.subtotal || 0), shipping: parseFloat(o.shipping || 0),
            tax: parseFloat(o.tax || 0), total: parseFloat(o.total || 0),
            items: items.map(i => ({ product_id: i.product_id, name: i.product_name, price: parseFloat(i.product_price || 0), quantity: i.quantity }))
          });
        }
        return json(result);
      }

      if (method === 'POST') {
        if (!user) return json({ error: 'Not logged in' }, 401);
        const { customer_name, customer_email, shipping_address, payment_method } = JSON.parse(event.body || '{}');
        const sid = token;
        const cart = await sql`SELECT ci.*, p.name, p.price FROM cart_items ci JOIN products p ON ci.product_id = p.id WHERE ci.session_id = ${sid}`;
        if (!cart.length) return json({ error: 'Cart is empty' }, 400);
        const subtotal = cart.reduce((s, i) => s + parseFloat(i.price) * i.quantity, 0);
        const shipping = subtotal >= 75 ? 0 : 5.99;
        const total = subtotal + shipping;
        const orderId = 'o' + Date.now().toString(36);
        const [maxOrder] = await sql`SELECT order_number FROM orders WHERE order_number LIKE 'OR-%' ORDER BY order_number DESC LIMIT 1`;
        const lastNum = maxOrder ? parseInt(maxOrder.order_number.replace('OR-', '')) : 0;
        const orderNumber = 'OR-' + String(lastNum + 1).padStart(4, '0');
        const payMethod = payment_method || 'cash';
        await sql`INSERT INTO orders (id, order_number, customer_id, customer_name, customer_email, shipping_address, subtotal, shipping, total, payment_method, status) VALUES (${orderId}, ${orderNumber}, ${user.id}, ${customer_name}, ${customer_email}, ${shipping_address}, ${subtotal}, ${shipping}, ${total}, ${payMethod}, 'pending')`;
        const itemSummary = cart.map(i => `${i.quantity}x ${i.name}`).join(', ');
        for (const item of cart) {
          await sql`INSERT INTO order_items (order_id, product_id, product_name, product_price, quantity) VALUES (${orderId}, ${item.product_id}, ${item.name}, ${item.price}, ${item.quantity})`;
          await sql`UPDATE products SET stock = stock - ${item.quantity} WHERE id = ${item.product_id}`;
        }
        await sql`DELETE FROM cart_items WHERE session_id = ${sid}`;
        await log('order_placed', 'order', customer_name || user.name || 'customer', orderNumber, `Order ${orderNumber}: $${total.toFixed(2)} — ${itemSummary}`, clientIp);
        await log('payment_pending', 'finance', customer_name || 'customer', orderNumber, `Subtotal: $${subtotal.toFixed(2)}, Shipping: $${shipping.toFixed(2)}, Total: $${total.toFixed(2)}`, clientIp);
        for (const item of cart) {
          await log('stock_deducted', 'inventory', 'system', item.name, `Stock reduced by ${item.quantity} (order ${orderNumber})`, clientIp);
        }
        return json({ success: true, order: { id: orderId, orderNumber, total } });
      }

      if (method === 'PUT') {
        const admin = await requireAdmin(token);
        if (!admin) return json({ error: 'Admin only' }, 403);
        const orderId = params.id;
        if (!orderId) return json({ error: 'Missing order id' }, 400);
        const d = JSON.parse(event.body || '{}');
        const [order] = await sql`SELECT * FROM orders WHERE id = ${orderId}`;
        if (d.status !== undefined) {
          const oldStatus = order?.status || 'unknown';
          await sql`UPDATE orders SET status = ${d.status} WHERE id = ${orderId}`;
          await log('order_status_changed', 'order', 'Admin', order?.order_number || orderId, `Status: ${oldStatus} → ${d.status}`, clientIp);
          if (d.status === 'delivered') {
            await log('payment_completed', 'finance', 'system', order?.order_number || orderId, `Payment confirmed — $${parseFloat(order?.total || 0).toFixed(2)}`, clientIp);
          }
          if (d.status === 'cancelled') {
            await log('order_cancelled', 'finance', 'Admin', order?.order_number || orderId, `Order cancelled — $${parseFloat(order?.total || 0).toFixed(2)} reversed`, clientIp);
          }
        }
        if (d.notes !== undefined) {
          await sql`UPDATE orders SET notes = ${d.notes} WHERE id = ${orderId}`;
          await log('order_note_added', 'order', 'Admin', order?.order_number || orderId, d.notes, clientIp);
        }
        return json({ success: true });
      }

      if (method === 'DELETE') {
        const admin = await requireAdmin(token);
        if (!admin) return json({ error: 'Admin only' }, 403);
        const orderId = params.id;
        if (!orderId) return json({ error: 'Missing order id' }, 400);
        const [order] = await sql`SELECT * FROM orders WHERE id = ${orderId}`;
        await sql`DELETE FROM order_items WHERE order_id = ${orderId}`;
        await sql`DELETE FROM orders WHERE id = ${orderId}`;
        await log('order_deleted', 'order', 'Admin', order?.order_number || orderId, `Order deleted — was $${parseFloat(order?.total || 0).toFixed(2)}, status: ${order?.status || 'unknown'}`, clientIp);
        return json({ success: true });
      }
    }

    // ===== CUSTOMERS =====
    if (rawPath === '/customers') {
      const admin = await requireAdmin(token);
      if (!admin) return json({ error: 'Admin only' }, 403);

      if (method === 'GET') {
        const customers = await sql`SELECT id, username, email, name, phone, address, city, state, zip, notes, created_at FROM customers ORDER BY created_at DESC`;
        return json(customers.map(c => ({
          id: c.id, username: c.username || '', name: c.name || c.username || '', email: c.email,
          phone: c.phone || '', address: c.address || '', city: c.city || '',
          state: c.state || '', zip: c.zip || '', notes: c.notes || '',
          role: 'customer', created_at: c.created_at
        })));
      }

      if (method === 'POST') {
        const d = JSON.parse(event.body || '{}');
        if (!d.email || !d.name) return json({ error: 'Name and email required' }, 400);
        const [existing] = await sql`SELECT id FROM customers WHERE LOWER(email) = LOWER(${d.email})`;
        if (existing) return json({ error: 'Email already exists' }, 400);
        const id = 'c' + Date.now().toString(36);
        await sql`INSERT INTO customers (id, username, email, password, name, phone, address, city, state, zip, notes, age_verified)
          VALUES (${id}, ${d.username || d.name}, ${d.email}, ${d.password || 'changeme'}, ${d.name}, ${d.phone || ''}, ${d.address || ''}, ${d.city || ''}, ${d.state || ''}, ${d.zip || ''}, ${d.notes || ''}, true)`;
        await log('customer_created', 'customer', 'Admin', d.name, `New customer: ${d.name} (${d.email})${d.phone ? ', phone: ' + d.phone : ''}${d.city ? ', city: ' + d.city : ''}`, clientIp);
        return json({ success: true, id });
      }

      if (method === 'PUT') {
        const customerId = params.id;
        if (!customerId) return json({ error: 'Missing customer id' }, 400);
        const d = JSON.parse(event.body || '{}');
        const changes = [];
        if (d.name !== undefined) { await sql`UPDATE customers SET name = ${d.name} WHERE id = ${customerId}`; changes.push(`name="${d.name}"`); }
        if (d.username !== undefined) { await sql`UPDATE customers SET username = ${d.username} WHERE id = ${customerId}`; changes.push(`username="${d.username}"`); }
        if (d.email !== undefined) { await sql`UPDATE customers SET email = ${d.email} WHERE id = ${customerId}`; changes.push(`email="${d.email}"`); }
        if (d.phone !== undefined) { await sql`UPDATE customers SET phone = ${d.phone} WHERE id = ${customerId}`; changes.push(`phone="${d.phone}"`); }
        if (d.address !== undefined) { await sql`UPDATE customers SET address = ${d.address} WHERE id = ${customerId}`; changes.push(`address="${d.address}"`); }
        if (d.city !== undefined) { await sql`UPDATE customers SET city = ${d.city} WHERE id = ${customerId}`; changes.push(`city="${d.city}"`); }
        if (d.state !== undefined) { await sql`UPDATE customers SET state = ${d.state} WHERE id = ${customerId}`; changes.push(`state="${d.state}"`); }
        if (d.zip !== undefined) { await sql`UPDATE customers SET zip = ${d.zip} WHERE id = ${customerId}`; changes.push(`zip="${d.zip}"`); }
        if (d.notes !== undefined) { await sql`UPDATE customers SET notes = ${d.notes} WHERE id = ${customerId}`; changes.push('notes updated'); }
        if (d.password) { await sql`UPDATE customers SET password = ${d.password} WHERE id = ${customerId}`; changes.push('password changed'); }
        await log('customer_updated', 'customer', 'Admin', customerId, changes.join(', '), clientIp);
        return json({ success: true });
      }

      if (method === 'DELETE') {
        const customerId = params.id;
        if (!customerId) return json({ error: 'Missing customer id' }, 400);
        const [c] = await sql`SELECT name, email FROM customers WHERE id = ${customerId}`;
        await sql`DELETE FROM cart_items WHERE session_id IN (SELECT id FROM sessions WHERE customer_id = ${customerId})`;
        await sql`DELETE FROM sessions WHERE customer_id = ${customerId}`;
        try { await sql`DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE customer_id = ${customerId})`; } catch {}
        try { await sql`DELETE FROM orders WHERE customer_id = ${customerId}`; } catch {}
        await sql`DELETE FROM customers WHERE id = ${customerId}`;
        await log('customer_deleted', 'customer', 'Admin', c?.name || customerId, `Customer deleted: ${c?.name || ''} (${c?.email || ''}) — all orders and sessions removed`, clientIp);
        return json({ success: true });
      }
    }

    // ===== SETTINGS =====
    if (rawPath === '/settings') {
      if (method === 'GET') {
        const settings = await sql`SELECT * FROM settings`;
        const cfg = {};
        for (const s of settings) cfg[s.key] = s.value;
        return json({
          store_name: cfg.store_name || 'AIRWAVES', store_tagline: cfg.store_tagline || 'Premium Hemp Products',
          store_email: cfg.store_email || '', store_phone: cfg.store_phone || '',
          shipping_flat_rate: cfg.shipping_flat_rate || '5.99', free_shipping_threshold: cfg.free_shipping_threshold || '75',
          tax_rate: cfg.tax_rate || '0.0625', age_verification: cfg.age_verification || 'true',
          wallet_btc: cfg.wallet_btc || '', wallet_xmr: cfg.wallet_xmr || '', wallet_ltc: cfg.wallet_ltc || ''
        });
      }

      if (method === 'PUT') {
        const admin = await requireAdmin(token);
        if (!admin) return json({ error: 'Admin only' }, 403);
        const d = JSON.parse(event.body || '{}');
        const changes = [];
        for (const [key, value] of Object.entries(d)) {
          await sql`INSERT INTO settings (key, value) VALUES (${key}, ${String(value)}) ON CONFLICT (key) DO UPDATE SET value = ${String(value)}, updated_at = NOW()`;
          changes.push(`${key}="${value}"`);
        }
        await log('settings_updated', 'settings', 'Admin', 'store settings', changes.join(', '), clientIp);
        return json({ success: true });
      }
    }

    // ===== STATS =====
    if (rawPath === '/stats' && method === 'GET') {
      const admin = await requireAdmin(token);
      if (!admin) return json({ error: 'Admin only' }, 403);
      const [productCount] = await sql`SELECT COUNT(*)::int as count FROM products`;
      const [customerCount] = await sql`SELECT COUNT(*)::int as count FROM customers`;
      const [orderCount] = await sql`SELECT COUNT(*)::int as count FROM orders`;
      const [revenueResult] = await sql`SELECT COALESCE(SUM(total), 0) as total FROM orders`;
      const [pendingOrders] = await sql`SELECT COUNT(*)::int as count FROM orders WHERE status = 'pending'`;
      const lowStock = await sql`SELECT id, name, stock FROM products WHERE stock < 10 ORDER BY stock ASC LIMIT 10`;
      const recentOrders = await sql`SELECT * FROM orders ORDER BY created_at DESC LIMIT 5`;
      const recentCustomers = await sql`SELECT id, name, username, email, created_at FROM customers ORDER BY created_at DESC LIMIT 5`;
      const statusCounts = await sql`SELECT status, COUNT(*)::int as count FROM orders GROUP BY status`;
      return json({
        products: productCount?.count || 0, customers: customerCount?.count || 0,
        orders: orderCount?.count || 0, revenue: parseFloat(revenueResult?.total || 0),
        pendingOrders: pendingOrders?.count || 0,
        lowStock: lowStock.map(p => ({ id: p.id, name: p.name, stock: p.stock })),
        recentOrders, recentCustomers: recentCustomers.map(c => ({ id: c.id, name: c.name || c.username, email: c.email, created_at: c.created_at })),
        statusCounts: statusCounts.reduce((o, s) => { o[s.status] = s.count; return o; }, {})
      });
    }

    // ===== ACTIVITY LOG =====
    if (rawPath === '/logs') {
      const admin = await requireAdmin(token);
      if (!admin) return json({ error: 'Admin only' }, 403);

      if (method === 'GET') {
        const category = params.category || null;
        const limit = Math.min(parseInt(params.limit) || 100, 500);
        const offset = parseInt(params.offset) || 0;

        let logs;
        if (category) {
          logs = await sql`SELECT * FROM activity_log WHERE category = ${category} ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`;
        } else {
          logs = await sql`SELECT * FROM activity_log ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`;
        }

        const [total] = category
          ? await sql`SELECT COUNT(*)::int as count FROM activity_log WHERE category = ${category}`
          : await sql`SELECT COUNT(*)::int as count FROM activity_log`;

        return json({ logs, total: total?.count || 0 });
      }
    }

    // ===== DB INIT =====
    if (rawPath === '/db-init') {
      return json({ success: true, message: 'Use /api/db-init edge function' });
    }

    return json({ error: 'Not found: ' + rawPath }, 404);

  } catch (error) {
    console.error('API Error:', error);
    return json({ error: 'Server error: ' + error.message }, 500);
  }
}
