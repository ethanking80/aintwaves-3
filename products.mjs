import { neon } from '@netlify/neon';

const sql = neon();

const headers = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS'
};

export default async (req, context) => {
  if (req.method === 'OPTIONS') {
    return new Response('', { status: 204, headers });
  }

  const url = new URL(req.url);
  const productId = url.searchParams.get('id');
  const category = url.searchParams.get('category');
  const featured = url.searchParams.get('featured');
  const search = url.searchParams.get('search');

  try {
    // GET - list or single product
    if (req.method === 'GET') {
      if (productId) {
        const [product] = await sql`SELECT * FROM products WHERE id = ${productId}`;
        if (!product) return new Response(JSON.stringify({ error: 'Product not found' }), { status: 404, headers });
        return new Response(JSON.stringify(product), { status: 200, headers });
      }
      
      let products;
      if (category && category !== 'all') {
        products = await sql`SELECT * FROM products WHERE active = true AND category = ${category} ORDER BY featured DESC, created_at DESC`;
      } else if (featured === 'true') {
        products = await sql`SELECT * FROM products WHERE active = true AND featured = true ORDER BY created_at DESC`;
      } else if (search) {
        products = await sql`SELECT * FROM products WHERE active = true AND (LOWER(name) LIKE ${'%' + search.toLowerCase() + '%'} OR LOWER(description) LIKE ${'%' + search.toLowerCase() + '%'}) ORDER BY featured DESC, created_at DESC`;
      } else {
        products = await sql`SELECT * FROM products WHERE active = true ORDER BY featured DESC, created_at DESC`;
      }
      return new Response(JSON.stringify(products), { status: 200, headers });
    }

    // POST - create product (admin)
    if (req.method === 'POST') {
      const body = await req.json();
      const { name, description, price, image_url, category: cat, strain_type, thc_content, cbd_content, weight, stock, featured: feat } = body;
      if (!name || !price) return new Response(JSON.stringify({ error: 'Name and price are required' }), { status: 400, headers });
      const [product] = await sql`
        INSERT INTO products (name, description, price, image_url, category, strain_type, thc_content, cbd_content, weight, stock, featured)
        VALUES (${name}, ${description || ''}, ${price}, ${image_url || ''}, ${cat || 'General'}, ${strain_type || ''}, ${thc_content || ''}, ${cbd_content || ''}, ${weight || ''}, ${stock || 0}, ${feat || false})
        RETURNING *
      `;
      return new Response(JSON.stringify(product), { status: 201, headers });
    }

    // PUT - update product
    if (req.method === 'PUT') {
      if (!productId) return new Response(JSON.stringify({ error: 'Product ID required' }), { status: 400, headers });
      const body = await req.json();
      const { name, description, price, image_url, category: cat, strain_type, thc_content, cbd_content, weight, stock, featured: feat, active } = body;
      const [product] = await sql`
        UPDATE products SET 
          name = COALESCE(${name}, name),
          description = COALESCE(${description}, description),
          price = COALESCE(${price}, price),
          image_url = COALESCE(${image_url}, image_url),
          category = COALESCE(${cat}, category),
          strain_type = COALESCE(${strain_type}, strain_type),
          thc_content = COALESCE(${thc_content}, thc_content),
          cbd_content = COALESCE(${cbd_content}, cbd_content),
          weight = COALESCE(${weight}, weight),
          stock = COALESCE(${stock !== undefined ? stock : null}, stock),
          featured = COALESCE(${feat !== undefined ? feat : null}, featured),
          active = COALESCE(${active !== undefined ? active : null}, active)
        WHERE id = ${productId}
        RETURNING *
      `;
      if (!product) return new Response(JSON.stringify({ error: 'Product not found' }), { status: 404, headers });
      return new Response(JSON.stringify(product), { status: 200, headers });
    }

    // DELETE - remove product
    if (req.method === 'DELETE') {
      if (!productId) return new Response(JSON.stringify({ error: 'Product ID required' }), { status: 400, headers });
      await sql`DELETE FROM products WHERE id = ${productId}`;
      return new Response(JSON.stringify({ success: true }), { status: 200, headers });
    }

    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers });
  } catch (error) {
    console.error('Products Error:', error);
    return new Response(JSON.stringify({ error: 'Server error: ' + error.message }), { status: 500, headers });
  }
};

export const config = { path: "/api/products" };
