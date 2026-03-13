import { neon } from '@netlify/neon';
import crypto from 'crypto';

const sql = neon();

const headers = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
};

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
  return salt + ':' + hash;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const verify = crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
  return hash === verify;
}

function generateToken(user) {
  const payload = { id: user.id, email: user.email, role: user.role, name: user.name };
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', process.env.JWT_SECRET || 'airwaves-secret-key-2024').update(data).digest('base64url');
  return data + '.' + sig;
}

export function verifyToken(token) {
  try {
    const [data, sig] = token.split('.');
    const expected = crypto.createHmac('sha256', process.env.JWT_SECRET || 'airwaves-secret-key-2024').update(data).digest('base64url');
    if (sig !== expected) return null;
    return JSON.parse(Buffer.from(data, 'base64url').toString());
  } catch { return null; }
}

export default async (req, context) => {
  if (req.method === 'OPTIONS') {
    return new Response('', { status: 204, headers });
  }

  const url = new URL(req.url);
  const action = url.searchParams.get('action');

  try {
    if (req.method === 'POST' && action === 'register') {
      const { email, password, name } = await req.json();
      if (!email || !password || !name) {
        return new Response(JSON.stringify({ error: 'Email, password, and name are required' }), { status: 400, headers });
      }
      // Check if user exists
      const existing = await sql`SELECT id FROM users WHERE email = ${email.toLowerCase()}`;
      if (existing.length > 0) {
        return new Response(JSON.stringify({ error: 'An account with this email already exists' }), { status: 409, headers });
      }
      const passwordHash = hashPassword(password);
      const [user] = await sql`
        INSERT INTO users (email, password_hash, name, role) 
        VALUES (${email.toLowerCase()}, ${passwordHash}, ${name}, 'customer') 
        RETURNING id, email, name, role
      `;
      const token = generateToken(user);
      return new Response(JSON.stringify({ success: true, token, user: { id: user.id, email: user.email, name: user.name, role: user.role } }), { status: 201, headers });
    }

    if (req.method === 'POST' && action === 'login') {
      const { email, password } = await req.json();
      if (!email || !password) {
        return new Response(JSON.stringify({ error: 'Email and password are required' }), { status: 400, headers });
      }
      const [user] = await sql`SELECT * FROM users WHERE email = ${email.toLowerCase()}`;
      if (!user || !verifyPassword(password, user.password_hash)) {
        return new Response(JSON.stringify({ error: 'Invalid email or password' }), { status: 401, headers });
      }
      const token = generateToken(user);
      return new Response(JSON.stringify({ success: true, token, user: { id: user.id, email: user.email, name: user.name, role: user.role } }), { status: 200, headers });
    }

    if (req.method === 'GET' && action === 'me') {
      const authHeader = req.headers.get('Authorization');
      if (!authHeader) return new Response(JSON.stringify({ error: 'Not authenticated' }), { status: 401, headers });
      const token = authHeader.replace('Bearer ', '');
      const payload = verifyToken(token);
      if (!payload) return new Response(JSON.stringify({ error: 'Invalid token' }), { status: 401, headers });
      return new Response(JSON.stringify({ user: payload }), { status: 200, headers });
    }

    return new Response(JSON.stringify({ error: 'Invalid action. Use ?action=login, ?action=register, or ?action=me' }), { status: 400, headers });
  } catch (error) {
    console.error('Auth Error:', error);
    return new Response(JSON.stringify({ error: 'Server error: ' + error.message }), { status: 500, headers });
  }
};

export const config = { path: "/api/auth" };
