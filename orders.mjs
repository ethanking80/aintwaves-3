import { neon } from '@netlify/neon';

const sql = neon();

const headers = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS'
};

function getSessionId(req) {
  const authHeader = req.headers.get('Authorization');
  if (authHeader) {
    try {
      const token = authHeader.replace('Bearer ', '');
      const [data] = token.split('.');
      const payload = JSON.parse(Buffer.from(data, 'base64url').toString());
      return 'user_' + payload.id;
    } catch {}
  }
  const url = new URL(req.url);
  return url.searchParams.get('session') || null;
}

export default async (req, context) => {
  if (req.method === 'OPTIONS') {
    return new Response('', { status: 204, headers });
  }

  const url = new URL(req.url);
  const orderId = url.searchParams.get('id');
  const allOrders = url.searchParams.get('all');

  try {
    // GET - list orders
    if (req.method === 'GET') {
      if (orderId) {
        const [order] = await sql`SELECT * FROM orders WHERE id = ${orderId}`;
        if (!order) return new Response(JSON.stringify({ error: 'Order not found' }), { status: 404, headers });
        const items = await sql`SELECT * FROM order_items WHERE order_id = ${orderId}`;
        return new Response(JSON.stringify({ ...order, items }), { status: 200, headers });
      }
      // Admin: get all orders
      if (allOrders === 'true') {
        const orders = await sql`SELECT * FROM orders ORDER BY created_at DESC`;
        return new Response(JSON.stringify(orders), { status: 200, headers });
      }
      // Customer: get their orders
      const sessionId = getSessionId(req);
      if (!sessionId) return new Response(JSON.stringify([]), { status: 200, headers });
      const orders = await sql`SELECT * FROM orders WHERE session_id = ${sessionId} ORDER BY created_at DESC`;
      return new Response(JSON.stringify(orders), { status: 200, headers });
    }

    // POST - create order from cart
    if (req.method === 'POST') {
      const sessionId = getSessionId(req);
      const { customer_name, customer_email, shipping_address } = await req.json();

      // Get cart items
      const cartItems = await sql`
        SELECT ci.*, p.name as product_name, p.price 
        FROM cart_items ci JOIN products p ON ci.product_id = p.id
        WHERE ci.session_id = ${sessionId}
      `;
      if (cartItems.length === 0) {
        return new Response(JSON.stringify({ error: 'Cart is empty' }), { status: 400, headers });
      }

      const total = cartItems.reduce((sum, item) => sum + (parseFloat(item.price) * item.quantity), 0);

      // Create order
      const [order] = await sql`
        INSERT INTO orders (session_id, total, customer_name, customer_email, shipping_address, status)
        VALUES (${sessionId}, ${total.toFixed(2)}, ${customer_name || ''}, ${customer_email || ''}, ${shipping_address || ''}, 'pending')
        RETURNING *
      `;

      // Create order items
      for (const item of cartItems) {
        await sql`
          INSERT INTO order_items (order_id, product_id, product_name, quantity, price)
          VALUES (${order.id}, ${item.product_id}, ${item.product_name}, ${item.quantity}, ${item.price})
        `;
      }

      // Clear cart
      await sql`DELETE FROM cart_items WHERE session_id = ${sessionId}`;

      return new Response(JSON.stringify({ success: true, order }), { status: 201, headers });
    }

    // PUT - update order status (admin)
    if (req.method === 'PUT') {
      if (!orderId) return new Response(JSON.stringify({ error: 'Order ID required' }), { status: 400, headers });
      const { status } = await req.json();
      const [order] = await sql`UPDATE orders SET status = ${status} WHERE id = ${orderId} RETURNING *`;
      return new Response(JSON.stringify({ success: true, order }), { status: 200, headers });
    }

    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers });
  } catch (error) {
    console.error('Orders Error:', error);
    return new Response(JSON.stringify({ error: 'Server error: ' + error.message }), { status: 500, headers });
  }
};

export const config = { path: "/api/orders" };
