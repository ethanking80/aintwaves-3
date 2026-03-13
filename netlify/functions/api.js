import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL);

// Simple helpers
const json = (data, status = 200, headers = {}) => ({
  statusCode: status,
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(data)
});

const parseCookies = (str) => {
  const cookies = {};
  if (str) {
    str.split(';').forEach(c => {
      const [k, ...v] = c.split('=');
      if (k) cookies[k.trim()] = v.join('=');
    });
  }
  return cookies;
};

const genId = () => 's' + Date.now().toString(36) + Math.random().toString(36).slice(2);
const COOKIE_NAME = 'airwaves_sid';
const DAY = 86400000;

// Session helpers
async function getSession(event) {
  const sid = parseCookies(event.headers?.cookie)[COOKIE_NAME];
  if (!sid) return null;
  const [session] = await sql`SELECT * FROM sessions WHERE id = ${sid} AND expires_at > NOW()`;
  return session || null;
}

async function createSession(customerId, isAdmin) {
  const id = genId();
  const expires = new Date(Date.now() + DAY);
  await sql`INSERT INTO sessions (id, customer_id, is_admin, expires_at) VALUES (${id}, ${customerId}, ${isAdmin}, ${expires})`;
  return id;
}

// Main handler
export async function handler(event) {
  const method = event.httpMethod;
  const path = event.path.replace('/.netlify/functions/api', '').replace('/api', '') || '/';
  
  console.log(`${method} ${path}`);
  
  // CORS
  if (method === 'OPTIONS') {
    return { statusCode: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': '*', 'Access-Control-Allow-Headers': '*' }};
  }

  try {
    // ===== AUTH ROUTES =====
    
    if (path === '/auth/me' && method === 'GET') {
      const session = await getSession(event);
      if (!session) return json({ loggedIn: false, isGuest: true });
      if (session.is_admin) return json({ loggedIn: true, isAdmin: true, username: 'Admin' });
      
      const [customer] = await sql`SELECT * FROM customers WHERE id = ${session.customer_id}`;
      if (!customer) return json({ loggedIn: false, isGuest: true });
      
      return json({ loggedIn: true, user: { id: customer.id, username: customer.username, email: customer.email, phone: customer.phone, address: customer.address, city: customer.city, state: customer.state, zip: customer.zip }});
    }

    if (path === '/auth/login' && method === 'POST') {
      const { username, password } = JSON.parse(event.body || '{}');
      const oldSid = parseCookies(event.headers?.cookie)[COOKIE_NAME];
      
      // Admin login
      if (username === 'admin' && password === 'airwaves1') {
        const sid = await createSession(null, true);
        // Transfer cart from old session
        if (oldSid) {
          await sql`UPDATE cart_items SET session_id = ${sid} WHERE session_id = ${oldSid}`;
          await sql`DELETE FROM sessions WHERE id = ${oldSid}`;
        }
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json', 'Set-Cookie': `${COOKIE_NAME}=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400` },
          body: JSON.stringify({ success: true, isAdmin: true })
        };
      }
      
      // Customer login
      const [customer] = await sql`SELECT * FROM customers WHERE (LOWER(username) = LOWER(${username}) OR LOWER(email) = LOWER(${username})) AND password = ${password}`;
      if (!customer) return json({ error: 'Invalid credentials' }, 401);
      
      const sid = await createSession(customer.id, false);
      // Transfer cart from old session
      if (oldSid) {
        await sql`UPDATE cart_items SET session_id = ${sid} WHERE session_id = ${oldSid}`;
        await sql`DELETE FROM sessions WHERE id = ${oldSid}`;
      }
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json', 'Set-Cookie': `${COOKIE_NAME}=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400` },
        body: JSON.stringify({ success: true, user: { id: customer.id, username: customer.username, email: customer.email }})
      };
    }

    if (path === '/auth/register' && method === 'POST') {
      const { username, email, password } = JSON.parse(event.body || '{}');
      if (!username || !email || !password) return json({ error: 'All fields required' }, 400);
      
      const [existing] = await sql`SELECT id FROM customers WHERE LOWER(email) = LOWER(${email}) OR LOWER(username) = LOWER(${username})`;
      if (existing) return json({ error: 'Username or email already exists' }, 400);
      
      const oldSid = parseCookies(event.headers?.cookie)[COOKIE_NAME];
      const id = 'c' + Date.now().toString(36);
      await sql`INSERT INTO customers (id, username, email, password, age_verified) VALUES (${id}, ${username}, ${email}, ${password}, true)`;
      
      const sid = await createSession(id, false);
      // Transfer cart from old session
      if (oldSid) {
        await sql`UPDATE cart_items SET session_id = ${sid} WHERE session_id = ${oldSid}`;
        await sql`DELETE FROM sessions WHERE id = ${oldSid}`;
      }
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json', 'Set-Cookie': `${COOKIE_NAME}=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400` },
        body: JSON.stringify({ success: true, user: { id, username, email }})
      };
    }

    if (path === '/auth/logout' && method === 'POST') {
      const session = await getSession(event);
      if (session) {
        await sql`DELETE FROM sessions WHERE id = ${session.id}`;
        await sql`DELETE FROM inventory_locks WHERE session_id = ${session.id}`;
      }
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json', 'Set-Cookie': `${COOKIE_NAME}=; Path=/; Max-Age=0` },
        body: '{"success":true}'
      };
    }

    if (path === '/auth/profile' && method === 'PUT') {
      const session = await getSession(event);
      if (!session?.customer_id) return json({ error: 'Not logged in' }, 401);
      
      const data = JSON.parse(event.body || '{}');
      await sql`UPDATE customers SET 
        name = COALESCE(${data.name}, name),
        phone = COALESCE(${data.phone}, phone),
        address = COALESCE(${data.address}, address),
        city = COALESCE(${data.city}, city),
        state = COALESCE(${data.state}, state),
        zip = COALESCE(${data.zip}, zip)
        WHERE id = ${session.customer_id}`;
      
      const [customer] = await sql`SELECT * FROM customers WHERE id = ${session.customer_id}`;
      return json({ success: true, user: customer });
    }

    // ===== PRODUCTS =====
    
    if (path === '/products' && method === 'GET') {
      const products = await sql`SELECT * FROM products ORDER BY id`;
      const categories = await sql`SELECT * FROM categories ORDER BY id`;
      
      // Clean expired locks
      await sql`DELETE FROM inventory_locks WHERE expires_at < NOW()`;
      
      // Get session for excluding own locks
      const session = await getSession(event);
      const sid = session?.id || 'none';
      
      const result = [];
      for (const p of products) {
        const [lockInfo] = await sql`SELECT COALESCE(SUM(quantity), 0)::int as locked FROM inventory_locks WHERE product_id = ${p.id} AND session_id != ${sid}`;
        result.push({
          ...p,
          price: parseFloat(p.price),
          availableStock: p.stock - (lockInfo?.locked || 0)
        });
      }
      
      return json({ products: result, categories });
    }

    // ===== CART =====
    
    if (path === '/cart' && method === 'GET') {
      const session = await getSession(event);
      const sid = session?.id || parseCookies(event.headers?.cookie)[COOKIE_NAME] || 'guest';
      
      const items = await sql`
        SELECT ci.*, p.name, p.price, p.category, p.weight, p.image 
        FROM cart_items ci 
        JOIN products p ON ci.product_id = p.id 
        WHERE ci.session_id = ${sid}
      `;
      
      return json({ 
        cart: items.map(i => ({
          productId: i.product_id,
          name: i.name,
          price: parseFloat(i.price),
          category: i.category,
          weight: i.weight,
          image: i.image,
          qty: i.quantity
        }))
      });
    }

    if (path === '/cart' && method === 'POST') {
      let session = await getSession(event);
      let sid = session?.id;
      let newCookie = null;
      
      // Create session if needed
      if (!sid) {
        sid = await createSession(null, false);
        newCookie = `${COOKIE_NAME}=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`;
      }
      
      const { productId, qty = 1 } = JSON.parse(event.body || '{}');
      
      // Check product exists
      const [product] = await sql`SELECT * FROM products WHERE id = ${productId}`;
      if (!product) return json({ error: 'Product not found' }, 404);
      
      // Check stock
      const [lockInfo] = await sql`SELECT COALESCE(SUM(quantity), 0)::int as locked FROM inventory_locks WHERE product_id = ${productId} AND session_id != ${sid}`;
      const [cartInfo] = await sql`SELECT COALESCE(quantity, 0)::int as qty FROM cart_items WHERE session_id = ${sid} AND product_id = ${productId}`;
      
      const available = product.stock - (lockInfo?.locked || 0);
      const currentQty = cartInfo?.qty || 0;
      
      if (currentQty + qty > available) {
        return json({ error: `Only ${available} available` }, 400);
      }
      
      // Add to cart (upsert)
      await sql`
        INSERT INTO cart_items (session_id, product_id, quantity) 
        VALUES (${sid}, ${productId}, ${qty})
        ON CONFLICT (session_id, product_id) 
        DO UPDATE SET quantity = cart_items.quantity + ${qty}
      `;
      
      // Get updated cart
      const items = await sql`
        SELECT ci.*, p.name, p.price, p.category, p.weight, p.image 
        FROM cart_items ci 
        JOIN products p ON ci.product_id = p.id 
        WHERE ci.session_id = ${sid}
      `;
      
      const response = json({ 
        success: true, 
        cart: items.map(i => ({
          productId: i.product_id,
          name: i.name,
          price: parseFloat(i.price),
          category: i.category,
          weight: i.weight,
          image: i.image,
          qty: i.quantity
        }))
      });
      
      if (newCookie) {
        response.headers['Set-Cookie'] = newCookie;
      }
      
      return response;
    }

    // Cart item operations (PUT/DELETE)
    const cartMatch = path.match(/^\/cart\/(\d+)$/);
    if (cartMatch) {
      const productId = parseInt(cartMatch[1]);
      const session = await getSession(event);
      const sid = session?.id || parseCookies(event.headers?.cookie)[COOKIE_NAME];
      
      if (!sid) return json({ error: 'No cart' }, 404);
      
      if (method === 'PUT') {
        const { qty } = JSON.parse(event.body || '{}');
        if (qty <= 0) {
          await sql`DELETE FROM cart_items WHERE session_id = ${sid} AND product_id = ${productId}`;
        } else {
          await sql`UPDATE cart_items SET quantity = ${qty} WHERE session_id = ${sid} AND product_id = ${productId}`;
        }
      } else if (method === 'DELETE') {
        await sql`DELETE FROM cart_items WHERE session_id = ${sid} AND product_id = ${productId}`;
      }
      
      const items = await sql`
        SELECT ci.*, p.name, p.price, p.category, p.weight, p.image 
        FROM cart_items ci 
        JOIN products p ON ci.product_id = p.id 
        WHERE ci.session_id = ${sid}
      `;
      
      return json({ 
        success: true, 
        cart: items.map(i => ({
          productId: i.product_id,
          name: i.name,
          price: parseFloat(i.price),
          category: i.category,
          weight: i.weight,
          image: i.image,
          qty: i.quantity
        }))
      });
    }

    // ===== SETTINGS =====
    
    if (path === '/settings' && method === 'GET') {
      const settings = await sql`SELECT * FROM settings`;
      const cfg = { freeShippingThreshold: 75, taxRate: 0.0625, wallets: { btc: '', xmr: '', ltc: '' }};
      
      for (const s of settings) {
        if (s.key === 'free_shipping_threshold') cfg.freeShippingThreshold = parseFloat(s.value);
        if (s.key === 'tax_rate') cfg.taxRate = parseFloat(s.value);
        if (s.key === 'wallet_btc') cfg.wallets.btc = s.value;
        if (s.key === 'wallet_xmr') cfg.wallets.xmr = s.value;
        if (s.key === 'wallet_ltc') cfg.wallets.ltc = s.value;
      }
      
      return json({ settings: cfg });
    }

    // ===== CHECKOUT =====
    
    if (path === '/checkout/start' && method === 'POST') {
      const session = await getSession(event);
      if (!session?.customer_id) return json({ error: 'Must be logged in' }, 401);
      
      const cart = await sql`
        SELECT ci.*, p.stock 
        FROM cart_items ci 
        JOIN products p ON ci.product_id = p.id 
        WHERE ci.session_id = ${session.id}
      `;
      
      if (!cart.length) return json({ error: 'Cart is empty' }, 400);
      
      // Lock inventory
      const lockExpires = new Date(Date.now() + 300000); // 5 minutes
      
      for (const item of cart) {
        await sql`
          INSERT INTO inventory_locks (session_id, product_id, quantity, expires_at) 
          VALUES (${session.id}, ${item.product_id}, ${item.quantity}, ${lockExpires})
          ON CONFLICT DO NOTHING
        `;
      }
      
      return json({ success: true, lockExpires: lockExpires.getTime() });
    }

    if (path === '/checkout/complete' && method === 'POST') {
      const session = await getSession(event);
      if (!session?.customer_id) return json({ error: 'Must be logged in' }, 401);
      
      const { shippingInfo, paymentMethod } = JSON.parse(event.body || '{}');
      if (!shippingInfo?.firstName || !shippingInfo?.email) return json({ error: 'Missing shipping info' }, 400);
      
      const cart = await sql`
        SELECT ci.*, p.name, p.price 
        FROM cart_items ci 
        JOIN products p ON ci.product_id = p.id 
        WHERE ci.session_id = ${session.id}
      `;
      
      if (!cart.length) return json({ error: 'Cart is empty' }, 400);
      
      // Deduct inventory
      for (const item of cart) {
        await sql`UPDATE products SET stock = stock - ${item.quantity} WHERE id = ${item.product_id}`;
      }
      
      // Calculate totals
      const subtotal = cart.reduce((sum, i) => sum + parseFloat(i.price) * i.quantity, 0);
      const shipping = subtotal >= 75 ? 0 : 7.99;
      const tax = subtotal * 0.0625;
      const total = subtotal + shipping + tax;
      
      // Create order with sequential order number
      const orderId = 'o' + Date.now().toString(36);
      const [orderCount] = await sql`SELECT COUNT(*)::int as count FROM orders`;
      const orderNum = (orderCount?.count || 0) + 1001;
      const orderNumber = 'AW-' + String(orderNum).padStart(6, '0');
      const customerName = (shippingInfo.firstName || '') + ' ' + (shippingInfo.lastName || '');
      const payMethod = paymentMethod || 'Demo';
      
      await sql`
        INSERT INTO orders (id, order_number, customer_id, customer_name, customer_email, customer_phone, shipping_address, shipping_city, shipping_state, shipping_zip, subtotal, shipping, tax, total, payment_method, status)
        VALUES (${orderId}, ${orderNumber}, ${session.customer_id}, ${customerName}, ${shippingInfo.email}, ${shippingInfo.phone || ''}, ${shippingInfo.address || ''}, ${shippingInfo.city || ''}, ${shippingInfo.state || ''}, ${shippingInfo.zip || ''}, ${subtotal}, ${shipping}, ${tax}, ${total}, ${payMethod}, 'pending')
      `;
      
      // Log initial status (ignore if table doesn't exist yet)
      try {
        await sql`INSERT INTO order_status_history (order_id, status, notes) VALUES (${orderId}, 'pending', 'Order placed')`;
      } catch (e) {
        console.log('order_status_history table not found, skipping');
      }
      
      // Add order items
      for (const item of cart) {
        await sql`
          INSERT INTO order_items (order_id, product_id, product_name, product_price, quantity)
          VALUES (${orderId}, ${item.product_id}, ${item.name}, ${item.price}, ${item.quantity})
        `;
      }
      
      // Clear cart and locks
      await sql`DELETE FROM cart_items WHERE session_id = ${session.id}`;
      await sql`DELETE FROM inventory_locks WHERE session_id = ${session.id}`;
      
      return json({ success: true, order: { orderNumber, orderId, total }});
    }

    if (path === '/checkout/cancel' && method === 'POST') {
      const session = await getSession(event);
      if (session) {
        await sql`DELETE FROM inventory_locks WHERE session_id = ${session.id}`;
      }
      return json({ success: true });
    }

    // ===== ORDERS =====
    
    if (path === '/orders' && method === 'GET') {
      const session = await getSession(event);
      if (!session) return json({ error: 'Not logged in' }, 401);
      
      const orders = session.is_admin
        ? await sql`SELECT * FROM orders ORDER BY created_at DESC`
        : await sql`SELECT * FROM orders WHERE customer_id = ${session.customer_id} ORDER BY created_at DESC`;
      
      const result = [];
      for (const o of orders) {
        const items = await sql`SELECT * FROM order_items WHERE order_id = ${o.id}`;
        let history = [];
        try {
          history = await sql`SELECT * FROM order_status_history WHERE order_id = ${o.id} ORDER BY created_at ASC`;
        } catch (e) {
          // table doesn't exist yet
        }
        // Transform to camelCase for frontend
        result.push({
          id: o.id,
          orderNumber: o.order_number,
          customer: {
            id: o.customer_id,
            name: o.customer_name,
            email: o.customer_email,
            phone: o.customer_phone
          },
          shipping: {
            address: o.shipping_address,
            city: o.shipping_city,
            state: o.shipping_state,
            zip: o.shipping_zip
          },
          subtotal: parseFloat(o.subtotal || 0),
          shippingCost: parseFloat(o.shipping || 0),
          tax: parseFloat(o.tax || 0),
          total: parseFloat(o.total || 0),
          paymentMethod: o.payment_method,
          paymentStatus: o.payment_method || 'pending',
          status: o.status,
          notes: o.notes || '',
          createdAt: o.created_at,
          items: items.map(i => ({
            productId: i.product_id,
            name: i.product_name,
            price: parseFloat(i.product_price || 0),
            quantity: i.quantity
          })),
          statusHistory: history
        });
      }
      
      return json({ orders: result });
    }

    // ===== ADMIN =====
    
    if (path === '/admin/data' && method === 'GET') {
      const session = await getSession(event);
      if (!session?.is_admin) return json({ error: 'Admin only' }, 403);
      
      const products = await sql`SELECT * FROM products ORDER BY id`;
      const orders = await sql`SELECT * FROM orders ORDER BY created_at DESC`;
      const customers = await sql`SELECT * FROM customers ORDER BY created_at DESC`;
      const settings = await sql`SELECT * FROM settings`;
      const [lockCount] = await sql`SELECT COUNT(*)::int as c FROM inventory_locks WHERE expires_at > NOW()`;
      
      const cfg = { freeShippingThreshold: 75, taxRate: 0.0625, wallets: { btc: '', xmr: '', ltc: '' }};
      for (const s of settings) {
        if (s.key === 'free_shipping_threshold') cfg.freeShippingThreshold = parseFloat(s.value);
        if (s.key === 'tax_rate') cfg.taxRate = parseFloat(s.value);
        if (s.key === 'wallet_btc') cfg.wallets.btc = s.value;
        if (s.key === 'wallet_xmr') cfg.wallets.xmr = s.value;
        if (s.key === 'wallet_ltc') cfg.wallets.ltc = s.value;
      }
      
      // Transform orders
      const ordersWithItems = [];
      for (const o of orders) {
        const items = await sql`SELECT * FROM order_items WHERE order_id = ${o.id}`;
        let history = [];
        try {
          history = await sql`SELECT * FROM order_status_history WHERE order_id = ${o.id} ORDER BY created_at ASC`;
        } catch (e) {}
        
        ordersWithItems.push({
          id: o.id,
          orderNumber: o.order_number,
          customer: {
            id: o.customer_id,
            name: o.customer_name,
            email: o.customer_email,
            phone: o.customer_phone
          },
          shipping: {
            address: o.shipping_address,
            city: o.shipping_city,
            state: o.shipping_state,
            zip: o.shipping_zip
          },
          subtotal: parseFloat(o.subtotal || 0),
          shippingCost: parseFloat(o.shipping || 0),
          tax: parseFloat(o.tax || 0),
          total: parseFloat(o.total || 0),
          paymentMethod: o.payment_method,
          status: o.status,
          notes: o.notes || '',
          createdAt: o.created_at,
          items: items.map(i => ({
            productId: i.product_id,
            name: i.product_name,
            price: parseFloat(i.product_price || 0),
            quantity: i.quantity
          })),
          statusHistory: history
        });
      }
      
      // Transform customers
      const customersTransformed = customers.map(c => ({
        id: c.id,
        username: c.username,
        email: c.email,
        phone: c.phone || '',
        address: c.address || '',
        city: c.city || '',
        state: c.state || '',
        zip: c.zip || '',
        notes: c.notes || '',
        createdAt: c.created_at
      }));
      
      return json({
        products: products.map(p => ({ ...p, price: parseFloat(p.price), createdAt: p.created_at })),
        orders: ordersWithItems,
        customers: customersTransformed,
        settings: cfg,
        stats: {
          totalRevenue: orders.reduce((s, o) => s + parseFloat(o.total || 0), 0),
          totalOrders: orders.length,
          totalProducts: products.length,
          totalCustomers: customers.length,
          lowStockProducts: products.filter(p => p.stock < 20).length
        },
        activeLocks: lockCount?.c || 0
      });
    }

    if (path === '/admin/settings' && method === 'PUT') {
      const session = await getSession(event);
      if (!session?.is_admin) return json({ error: 'Admin only' }, 403);
      
      const data = JSON.parse(event.body || '{}');
      
      if (data.freeShippingThreshold !== undefined) {
        await sql`INSERT INTO settings (key, value) VALUES ('free_shipping_threshold', ${String(data.freeShippingThreshold)}) ON CONFLICT (key) DO UPDATE SET value = ${String(data.freeShippingThreshold)}`;
      }
      if (data.taxRate !== undefined) {
        await sql`INSERT INTO settings (key, value) VALUES ('tax_rate', ${String(data.taxRate)}) ON CONFLICT (key) DO UPDATE SET value = ${String(data.taxRate)}`;
      }
      if (data.wallets?.btc !== undefined) {
        await sql`INSERT INTO settings (key, value) VALUES ('wallet_btc', ${data.wallets.btc}) ON CONFLICT (key) DO UPDATE SET value = ${data.wallets.btc}`;
      }
      if (data.wallets?.xmr !== undefined) {
        await sql`INSERT INTO settings (key, value) VALUES ('wallet_xmr', ${data.wallets.xmr}) ON CONFLICT (key) DO UPDATE SET value = ${data.wallets.xmr}`;
      }
      if (data.wallets?.ltc !== undefined) {
        await sql`INSERT INTO settings (key, value) VALUES ('wallet_ltc', ${data.wallets.ltc}) ON CONFLICT (key) DO UPDATE SET value = ${data.wallets.ltc}`;
      }
      
      // Return updated settings
      const settings = await sql`SELECT * FROM settings`;
      const cfg = { freeShippingThreshold: 75, taxRate: 0.0625, wallets: { btc: '', xmr: '', ltc: '' }};
      for (const s of settings) {
        if (s.key === 'free_shipping_threshold') cfg.freeShippingThreshold = parseFloat(s.value);
        if (s.key === 'tax_rate') cfg.taxRate = parseFloat(s.value);
        if (s.key === 'wallet_btc') cfg.wallets.btc = s.value;
        if (s.key === 'wallet_xmr') cfg.wallets.xmr = s.value;
        if (s.key === 'wallet_ltc') cfg.wallets.ltc = s.value;
      }
      return json({ settings: cfg });
    }

    if (path === '/admin/products' && method === 'POST') {
      const session = await getSession(event);
      if (!session?.is_admin) return json({ error: 'Admin only' }, 403);
      
      const data = JSON.parse(event.body || '{}');
      const [product] = await sql`
        INSERT INTO products (name, category, price, thc, cbd, weight, description, stock, image)
        VALUES (${data.name || 'New Product'}, ${data.category || 'flower'}, ${data.price || 0}, ${data.thc || ''}, ${data.cbd || ''}, ${data.weight || ''}, ${data.description || ''}, ${data.stock || 0}, ${data.image || ''})
        RETURNING *
      `;
      return json({ success: true, product });
    }

    // Admin product operations
    const adminProductMatch = path.match(/^\/admin\/products\/(\d+)$/);
    if (adminProductMatch) {
      const session = await getSession(event);
      if (!session?.is_admin) return json({ error: 'Admin only' }, 403);
      
      const productId = parseInt(adminProductMatch[1]);
      
      if (method === 'PUT') {
        const data = JSON.parse(event.body || '{}');
        await sql`UPDATE products SET
          name = COALESCE(${data.name}, name),
          category = COALESCE(${data.category}, category),
          price = COALESCE(${data.price}, price),
          thc = COALESCE(${data.thc}, thc),
          cbd = COALESCE(${data.cbd}, cbd),
          weight = COALESCE(${data.weight}, weight),
          description = COALESCE(${data.description}, description),
          stock = COALESCE(${data.stock}, stock),
          image = COALESCE(${data.image}, image)
          WHERE id = ${productId}`;
        return json({ success: true });
      }
      
      if (method === 'DELETE') {
        await sql`DELETE FROM products WHERE id = ${productId}`;
        return json({ success: true });
      }
    }

    // Admin order operations
    const adminOrderMatch = path.match(/^\/admin\/orders\/(.+)$/);
    if (adminOrderMatch) {
      const session = await getSession(event);
      if (!session?.is_admin) return json({ error: 'Admin only' }, 403);
      
      const orderId = adminOrderMatch[1];
      
      if (method === 'PUT') {
        const { status, notes } = JSON.parse(event.body || '{}');
        
        // Update all provided fields
        const data = JSON.parse(event.body || '{}');
        
        // Build dynamic update
        const updates = [];
        if (data.status !== undefined) {
          await sql`UPDATE orders SET status = ${data.status} WHERE id = ${orderId}`;
          try {
            await sql`INSERT INTO order_status_history (order_id, status, notes) VALUES (${orderId}, ${data.status}, 'Status updated')`;
          } catch (e) {}
        }
        if (data.order_number !== undefined) await sql`UPDATE orders SET order_number = ${data.order_number} WHERE id = ${orderId}`;
        if (data.payment_method !== undefined) await sql`UPDATE orders SET payment_method = ${data.payment_method} WHERE id = ${orderId}`;
        if (data.customer_name !== undefined) await sql`UPDATE orders SET customer_name = ${data.customer_name} WHERE id = ${orderId}`;
        if (data.customer_email !== undefined) await sql`UPDATE orders SET customer_email = ${data.customer_email} WHERE id = ${orderId}`;
        if (data.customer_phone !== undefined) await sql`UPDATE orders SET customer_phone = ${data.customer_phone} WHERE id = ${orderId}`;
        if (data.shipping_address !== undefined) await sql`UPDATE orders SET shipping_address = ${data.shipping_address} WHERE id = ${orderId}`;
        if (data.shipping_city !== undefined) await sql`UPDATE orders SET shipping_city = ${data.shipping_city} WHERE id = ${orderId}`;
        if (data.shipping_state !== undefined) await sql`UPDATE orders SET shipping_state = ${data.shipping_state} WHERE id = ${orderId}`;
        if (data.shipping_zip !== undefined) await sql`UPDATE orders SET shipping_zip = ${data.shipping_zip} WHERE id = ${orderId}`;
        if (data.subtotal !== undefined) await sql`UPDATE orders SET subtotal = ${data.subtotal} WHERE id = ${orderId}`;
        if (data.shipping !== undefined) await sql`UPDATE orders SET shipping = ${data.shipping} WHERE id = ${orderId}`;
        if (data.tax !== undefined) await sql`UPDATE orders SET tax = ${data.tax} WHERE id = ${orderId}`;
        if (data.total !== undefined) await sql`UPDATE orders SET total = ${data.total} WHERE id = ${orderId}`;
        if (data.notes !== undefined) {
          try {
            await sql`UPDATE orders SET notes = ${data.notes} WHERE id = ${orderId}`;
          } catch (e) {}
        }
        
        return json({ success: true });
      }
      
      if (method === 'DELETE') {
        try {
          await sql`DELETE FROM order_status_history WHERE order_id = ${orderId}`;
        } catch (e) {
          // table doesn't exist
        }
        await sql`DELETE FROM order_items WHERE order_id = ${orderId}`;
        await sql`DELETE FROM orders WHERE id = ${orderId}`;
        return json({ success: true });
      }
    }

    // Admin customer operations
    const adminCustomerMatch = path.match(/^\/admin\/customers\/(.+)$/);
    if (adminCustomerMatch) {
      const session = await getSession(event);
      if (!session?.is_admin) return json({ error: 'Admin only' }, 403);
      
      const customerId = adminCustomerMatch[1];
      
      if (method === 'PUT') {
        const data = JSON.parse(event.body || '{}');
        
        if (data.username !== undefined) await sql`UPDATE customers SET username = ${data.username} WHERE id = ${customerId}`;
        if (data.email !== undefined) await sql`UPDATE customers SET email = ${data.email} WHERE id = ${customerId}`;
        if (data.phone !== undefined) await sql`UPDATE customers SET phone = ${data.phone} WHERE id = ${customerId}`;
        if (data.password) await sql`UPDATE customers SET password = ${data.password} WHERE id = ${customerId}`;
        if (data.address !== undefined) await sql`UPDATE customers SET address = ${data.address} WHERE id = ${customerId}`;
        if (data.city !== undefined) await sql`UPDATE customers SET city = ${data.city} WHERE id = ${customerId}`;
        if (data.state !== undefined) await sql`UPDATE customers SET state = ${data.state} WHERE id = ${customerId}`;
        if (data.zip !== undefined) await sql`UPDATE customers SET zip = ${data.zip} WHERE id = ${customerId}`;
        if (data.notes !== undefined) {
          try {
            await sql`UPDATE customers SET notes = ${data.notes} WHERE id = ${customerId}`;
          } catch (e) {}
        }
        
        return json({ success: true });
      }
      
      if (method === 'DELETE') {
        // Delete customer's orders first
        const orders = await sql`SELECT id FROM orders WHERE customer_id = ${customerId}`;
        for (const o of orders) {
          try { await sql`DELETE FROM order_status_history WHERE order_id = ${o.id}`; } catch (e) {}
          await sql`DELETE FROM order_items WHERE order_id = ${o.id}`;
        }
        await sql`DELETE FROM orders WHERE customer_id = ${customerId}`;
        await sql`DELETE FROM sessions WHERE customer_id = ${customerId}`;
        await sql`DELETE FROM customers WHERE id = ${customerId}`;
        return json({ success: true });
      }
    }

    // Not found
    return json({ error: 'Not found: ' + path }, 404);

  } catch (error) {
    console.error('API Error:', error);
    return json({ error: 'Server error: ' + error.message }, 500);
  }
}
