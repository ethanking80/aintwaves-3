import { neon } from '@netlify/neon';

const sql = neon();

export default async (req, context) => {
  try {
    // Create categories table
    await sql`
      CREATE TABLE IF NOT EXISTS categories (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        slug VARCHAR(255) UNIQUE
      )
    `;

    // Create products table
    await sql`
      CREATE TABLE IF NOT EXISTS products (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        description TEXT,
        price DECIMAL(10,2) NOT NULL,
        image TEXT DEFAULT '',
        category VARCHAR(100),
        thc VARCHAR(50) DEFAULT '',
        cbd VARCHAR(50) DEFAULT '',
        weight VARCHAR(50) DEFAULT '',
        stock INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `;

    // Create customers table
    await sql`
      CREATE TABLE IF NOT EXISTS customers (
        id VARCHAR(255) PRIMARY KEY,
        username VARCHAR(255) UNIQUE NOT NULL,
        email VARCHAR(255) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        name VARCHAR(255) DEFAULT '',
        phone VARCHAR(50) DEFAULT '',
        address TEXT DEFAULT '',
        city VARCHAR(255) DEFAULT '',
        state VARCHAR(100) DEFAULT '',
        zip VARCHAR(20) DEFAULT '',
        notes TEXT DEFAULT '',
        age_verified BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `;

    // Create sessions table
    await sql`
      CREATE TABLE IF NOT EXISTS sessions (
        id VARCHAR(255) PRIMARY KEY,
        customer_id VARCHAR(255) REFERENCES customers(id) ON DELETE CASCADE,
        is_admin BOOLEAN DEFAULT false,
        expires_at TIMESTAMP NOT NULL
      )
    `;

    // Create cart_items table
    await sql`
      CREATE TABLE IF NOT EXISTS cart_items (
        id SERIAL PRIMARY KEY,
        session_id VARCHAR(255) NOT NULL,
        product_id INTEGER REFERENCES products(id) ON DELETE CASCADE,
        quantity INTEGER DEFAULT 1,
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(session_id, product_id)
      )
    `;

    // Create inventory_locks table
    await sql`
      CREATE TABLE IF NOT EXISTS inventory_locks (
        id SERIAL PRIMARY KEY,
        session_id VARCHAR(255) NOT NULL,
        product_id INTEGER REFERENCES products(id) ON DELETE CASCADE,
        quantity INTEGER DEFAULT 1,
        expires_at TIMESTAMP NOT NULL,
        UNIQUE(session_id, product_id)
      )
    `;

    // Create orders table
    await sql`
      CREATE TABLE IF NOT EXISTS orders (
        id VARCHAR(255) PRIMARY KEY,
        order_number VARCHAR(50),
        customer_id VARCHAR(255) REFERENCES customers(id),
        customer_name VARCHAR(255),
        customer_email VARCHAR(255),
        customer_phone VARCHAR(50) DEFAULT '',
        shipping_address TEXT DEFAULT '',
        shipping_city VARCHAR(255) DEFAULT '',
        shipping_state VARCHAR(100) DEFAULT '',
        shipping_zip VARCHAR(20) DEFAULT '',
        subtotal DECIMAL(10,2) DEFAULT 0,
        shipping DECIMAL(10,2) DEFAULT 0,
        tax DECIMAL(10,2) DEFAULT 0,
        total DECIMAL(10,2) NOT NULL,
        payment_method VARCHAR(100) DEFAULT 'Demo',
        status VARCHAR(50) DEFAULT 'pending',
        notes TEXT DEFAULT '',
        created_at TIMESTAMP DEFAULT NOW()
      )
    `;

    // Create order_items table
    await sql`
      CREATE TABLE IF NOT EXISTS order_items (
        id SERIAL PRIMARY KEY,
        order_id VARCHAR(255) REFERENCES orders(id) ON DELETE CASCADE,
        product_id INTEGER REFERENCES products(id),
        product_name VARCHAR(255),
        product_price DECIMAL(10,2),
        quantity INTEGER NOT NULL
      )
    `;

    // Create order_status_history table
    await sql`
      CREATE TABLE IF NOT EXISTS order_status_history (
        id SERIAL PRIMARY KEY,
        order_id VARCHAR(255) REFERENCES orders(id) ON DELETE CASCADE,
        status VARCHAR(50) NOT NULL,
        notes TEXT DEFAULT '',
        created_at TIMESTAMP DEFAULT NOW()
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

    // Create activity_log table
    await sql`
      CREATE TABLE IF NOT EXISTS activity_log (
        id SERIAL PRIMARY KEY,
        action VARCHAR(100) NOT NULL,
        category VARCHAR(50) NOT NULL,
        actor VARCHAR(255) DEFAULT 'system',
        target VARCHAR(255) DEFAULT '',
        details TEXT DEFAULT '',
        ip VARCHAR(50) DEFAULT '',
        created_at TIMESTAMP DEFAULT NOW()
      )
    `;

    // Insert default categories if none exist
    const existingCategories = await sql`SELECT COUNT(*)::int as count FROM categories`;
    if (existingCategories[0].count === 0) {
      await sql`INSERT INTO categories (name, slug) VALUES
        ('Flower', 'flower'),
        ('Pre-Rolls', 'pre-rolls'),
        ('Tinctures', 'tinctures'),
        ('Edibles', 'edibles'),
        ('Concentrates', 'concentrates'),
        ('Topicals', 'topicals')
      `;
    }

    // Insert default settings if none exist
    const existingSettings = await sql`SELECT COUNT(*)::int as count FROM settings`;
    if (existingSettings[0].count === 0) {
      await sql`INSERT INTO settings (key, value) VALUES
        ('free_shipping_threshold', '75'),
        ('tax_rate', '0.0625'),
        ('wallet_btc', ''),
        ('wallet_xmr', ''),
        ('wallet_ltc', '')
      `;
    }

    // Insert sample products if none exist
    const existingProducts = await sql`SELECT COUNT(*)::int as count FROM products`;
    if (existingProducts[0].count === 0) {
      await sql`INSERT INTO products (name, description, price, category, thc, cbd, weight, stock, image) VALUES
        ('OG Kush Hemp Flower', 'Classic earthy and pine aroma with dense, trichome-rich buds. Lab-tested premium hemp flower.', 34.99, 'Flower', '<0.3%', '18.5%', '3.5g', 50, ''),
        ('Blue Dream Pre-Rolls', 'Smooth berry flavor in perfectly rolled 1g pre-rolls. Pack of 5 pre-rolls per tin.', 29.99, 'Pre-Rolls', '<0.3%', '16.2%', '5g', 75, ''),
        ('Full Spectrum CBD Oil 1000mg', 'Organic MCT carrier oil with full-spectrum hemp extract. Natural flavor with dropper.', 49.99, 'Tinctures', '<0.3%', '33mg/ml', '30ml', 100, ''),
        ('Delta-8 Gummies - Mixed Berry', 'Delicious mixed berry gummies with 25mg Delta-8 per piece. 20 count jar.', 39.99, 'Edibles', '<0.3%', '10mg/pc', '20ct', 60, ''),
        ('CBG Isolate Powder', 'Pure CBG isolate, 99%+ purity. Lab-tested for potency and contaminants.', 44.99, 'Concentrates', '0%', '0%', '1g', 40, ''),
        ('Hemp Healing Balm', 'Topical balm infused with 500mg broad-spectrum CBD, lavender, and eucalyptus.', 24.99, 'Topicals', '0%', '500mg', '2oz', 80, ''),
        ('Sour Space Candy Flower', 'Bright citrus and sour apple notes. Dense sticky buds with vibrant trichomes.', 32.99, 'Flower', '<0.3%', '19.1%', '3.5g', 45, ''),
        ('CBN Sleep Tincture', 'Specialized nighttime formula with CBN and CBD for restful sleep. Natural mint flavor.', 54.99, 'Tinctures', '0%', '20mg/ml', '30ml', 35, '')
      `;
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
