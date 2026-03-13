import { neon } from '@netlify/neon';

const sql = neon();

export default async (req, context) => {
  try {
    // Create users table
    await sql`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        name VARCHAR(255) NOT NULL,
        role VARCHAR(50) DEFAULT 'customer',
        created_at TIMESTAMP DEFAULT NOW()
      )
    `;

    // Create products table
    await sql`
      CREATE TABLE IF NOT EXISTS products (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        description TEXT,
        price DECIMAL(10,2) NOT NULL,
        image_url TEXT,
        category VARCHAR(100),
        strain_type VARCHAR(50),
        thc_content VARCHAR(20),
        cbd_content VARCHAR(20),
        weight VARCHAR(50),
        stock INTEGER DEFAULT 0,
        featured BOOLEAN DEFAULT false,
        active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `;

    // Create cart_items table
    await sql`
      CREATE TABLE IF NOT EXISTS cart_items (
        id SERIAL PRIMARY KEY,
        session_id VARCHAR(255) NOT NULL,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        product_id INTEGER REFERENCES products(id) ON DELETE CASCADE,
        quantity INTEGER DEFAULT 1,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `;

    // Create orders table
    await sql`
      CREATE TABLE IF NOT EXISTS orders (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        session_id VARCHAR(255),
        total DECIMAL(10,2) NOT NULL,
        status VARCHAR(50) DEFAULT 'pending',
        customer_name VARCHAR(255),
        customer_email VARCHAR(255),
        shipping_address TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `;

    // Create order_items table
    await sql`
      CREATE TABLE IF NOT EXISTS order_items (
        id SERIAL PRIMARY KEY,
        order_id INTEGER REFERENCES orders(id) ON DELETE CASCADE,
        product_id INTEGER REFERENCES products(id),
        product_name VARCHAR(255),
        quantity INTEGER NOT NULL,
        price DECIMAL(10,2) NOT NULL
      )
    `;

    // Create settings table
    await sql`
      CREATE TABLE IF NOT EXISTS settings (
        id SERIAL PRIMARY KEY,
        key VARCHAR(255) UNIQUE NOT NULL,
        value TEXT,
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `;

    // Insert default settings if none exist
    const existingSettings = await sql`SELECT COUNT(*) as count FROM settings`;
    if (parseInt(existingSettings[0].count) === 0) {
      await sql`INSERT INTO settings (key, value) VALUES
        ('store_name', 'AIRWAVES'),
        ('store_tagline', 'Premium Hemp Products'),
        ('store_email', 'info@airwaves.com'),
        ('store_phone', ''),
        ('shipping_flat_rate', '5.99'),
        ('free_shipping_threshold', '75.00'),
        ('tax_rate', '0.00'),
        ('age_verification', 'true')
      `;
    }

    // Insert sample products if none exist
    const existingProducts = await sql`SELECT COUNT(*) as count FROM products`;
    if (parseInt(existingProducts[0].count) === 0) {
      await sql`INSERT INTO products (name, description, price, category, strain_type, thc_content, cbd_content, weight, stock, featured, image_url) VALUES
        ('OG Kush Hemp Flower', 'Classic earthy and pine aroma with dense, trichome-rich buds. Lab-tested premium hemp flower.', 34.99, 'Flower', 'Hybrid', '<0.3%', '18.5%', '3.5g', 50, true, ''),
        ('Blue Dream Pre-Rolls', 'Smooth berry flavor in perfectly rolled 1g pre-rolls. Pack of 5 pre-rolls per tin.', 29.99, 'Pre-Rolls', 'Sativa', '<0.3%', '16.2%', '5g', 75, true, ''),
        ('Full Spectrum CBD Oil 1000mg', 'Organic MCT carrier oil with full-spectrum hemp extract. Natural flavor with dropper.', 49.99, 'Tinctures', 'N/A', '<0.3%', '33mg/ml', '30ml', 100, true, ''),
        ('Delta-8 Gummies - Mixed Berry', 'Delicious mixed berry gummies with 25mg Delta-8 per piece. 20 count jar.', 39.99, 'Edibles', 'N/A', '<0.3%', '10mg/pc', '20ct', 60, false, ''),
        ('CBG Isolate Powder', 'Pure CBG isolate, 99%+ purity. Lab-tested for potency and contaminants.', 44.99, 'Concentrates', 'N/A', '0%', '0%', '1g', 40, false, ''),
        ('Hemp Healing Balm', 'Topical balm infused with 500mg broad-spectrum CBD, lavender, and eucalyptus.', 24.99, 'Topicals', 'N/A', '0%', '500mg', '2oz', 80, true, ''),
        ('Sour Space Candy Flower', 'Bright citrus and sour apple notes. Dense sticky buds with vibrant trichomes.', 32.99, 'Flower', 'Sativa', '<0.3%', '19.1%', '3.5g', 45, false, ''),
        ('CBN Sleep Tincture', 'Specialized nighttime formula with CBN and CBD for restful sleep. Natural mint flavor.', 54.99, 'Tinctures', 'N/A', '0%', '20mg/ml', '30ml', 35, false, '')
      `;
    }

    // Create default admin if none exists
    const existingAdmin = await sql`SELECT COUNT(*) as count FROM users WHERE role = 'admin'`;
    if (parseInt(existingAdmin[0].count) === 0) {
      const crypto = await import('crypto');
      const defaultPass = 'admin123';
      const salt = crypto.randomBytes(16).toString('hex');
      const hash = crypto.pbkdf2Sync(defaultPass, salt, 1000, 64, 'sha512').toString('hex');
      const passwordHash = salt + ':' + hash;
      await sql`INSERT INTO users (email, password_hash, name, role) VALUES ('admin@airwaves.com', ${passwordHash}, 'Admin', 'admin')`;
    }

    return new Response(JSON.stringify({ success: true, message: 'Database initialized successfully' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.error('DB Init Error:', error);
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};

export const config = { path: "/api/db-init" };
