import { neon } from '@netlify/neon';

const sql = neon();

const headers = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS'
};

export default async (req, context) => {
  if (req.method === 'OPTIONS') {
    return new Response('', { status: 204, headers });
  }

  try {
    // GET - fetch all settings as key-value object
    if (req.method === 'GET') {
      const rows = await sql`SELECT key, value FROM settings`;
      const settings = {};
      rows.forEach(row => { settings[row.key] = row.value; });
      return new Response(JSON.stringify(settings), { status: 200, headers });
    }

    // PUT/POST - update settings (admin only)
    if (req.method === 'PUT' || req.method === 'POST') {
      const body = await req.json();
      for (const [key, value] of Object.entries(body)) {
        await sql`
          INSERT INTO settings (key, value, updated_at) 
          VALUES (${key}, ${value}, NOW())
          ON CONFLICT (key) DO UPDATE SET value = ${value}, updated_at = NOW()
        `;
      }
      return new Response(JSON.stringify({ success: true }), { status: 200, headers });
    }

    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers });
  } catch (error) {
    console.error('Settings Error:', error);
    return new Response(JSON.stringify({ error: 'Server error: ' + error.message }), { status: 500, headers });
  }
};

export const config = { path: "/api/settings" };
