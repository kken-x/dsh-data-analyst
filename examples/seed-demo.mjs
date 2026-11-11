import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const target = resolve(here, 'demo.sqlite')
mkdirSync(here, { recursive: true })

const db = new DatabaseSync(target)
db.exec(`
  PRAGMA journal_mode = DELETE;
  DROP TABLE IF EXISTS sales;
  DROP TABLE IF EXISTS products;
  DROP TABLE IF EXISTS regions;
  DROP TABLE IF EXISTS customers;

  CREATE TABLE regions (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    country TEXT NOT NULL
  );
  CREATE TABLE products (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    category TEXT NOT NULL,
    unit_price REAL NOT NULL
  );
  CREATE TABLE customers (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    segment TEXT,
    signed_up_at TEXT
  );
  CREATE TABLE sales (
    id INTEGER PRIMARY KEY,
    sale_date TEXT NOT NULL,
    region_id INTEGER NOT NULL REFERENCES regions(id),
    product_id INTEGER NOT NULL REFERENCES products(id),
    customer_id INTEGER REFERENCES customers(id),
    units INTEGER NOT NULL,
    revenue REAL NOT NULL,
    discount REAL
  );
  CREATE INDEX idx_sales_date ON sales(sale_date);
  CREATE INDEX idx_sales_region ON sales(region_id);
`)

const regions = [
  { id: 1, name: '华东', country: '中国' },
  { id: 2, name: '华南', country: '中国' },
  { id: 3, name: '北美', country: '美国' },
  { id: 4, name: '欧洲', country: '德国' },
]
const products = [
  { id: 1, name: 'Atlas Pro', category: '硬件', price: 1299 },
  { id: 2, name: 'Atlas Mini', category: '硬件', price: 499 },
  { id: 3, name: 'Cloud Sync', category: '软件', price: 99 },
  { id: 4, name: 'Insight Pack', category: '软件', price: 299 },
  { id: 5, name: 'Care Plus', category: '服务', price: 199 },
  { id: 6, name: 'Onboarding', category: '服务', price: 899 },
]
const customers = [
  { id: 1, name: '远山科技', segment: 'Enterprise', signed: '2023-03-12' },
  { id: 2, name: '蓝湖零售', segment: 'SMB', signed: '2023-08-02' },
  { id: 3, name: 'Northwind', segment: 'Enterprise', signed: '2024-01-19' },
  { id: 4, name: 'Kite Labs', segment: 'Startup', signed: '2024-05-30' },
  { id: 5, name: '晨光教育', segment: 'SMB', signed: '2024-09-11' },
  { id: 6, name: 'Helios GmbH', segment: 'Enterprise', signed: '2025-02-14' },
  { id: 7, name: '小溪工作室', segment: null, signed: '2025-06-01' },
]

const insertRegion = db.prepare('INSERT INTO regions (id, name, country) VALUES (?, ?, ?)')
for (const region of regions) insertRegion.run(region.id, region.name, region.country)
const insertProduct = db.prepare('INSERT INTO products (id, name, category, unit_price) VALUES (?, ?, ?, ?)')
for (const product of products) insertProduct.run(product.id, product.name, product.category, product.price)
const insertCustomer = db.prepare('INSERT INTO customers (id, name, segment, signed_up_at) VALUES (?, ?, ?, ?)')
for (const customer of customers) insertCustomer.run(customer.id, customer.name, customer.segment, customer.signed)

const insertSale = db.prepare('INSERT INTO sales (sale_date, region_id, product_id, customer_id, units, revenue, discount) VALUES (?, ?, ?, ?, ?, ?, ?)')
let seed = 42
function random() {
  seed = (seed * 1664525 + 1013904223) % 4294967296
  return seed / 4294967296
}
db.exec('BEGIN')
for (let year = 2024; year <= 2025; year += 1) {
  for (let month = 1; month <= 12; month += 1) {
    const seasonal = 1 + 0.28 * Math.sin((month / 12) * Math.PI * 2)
    const growth = 1 + (year - 2024) * 0.18
    for (const region of regions) {
      for (const product of products) {
        const base = product.price * (region.id === 3 ? 1.15 : region.id === 4 ? 1.08 : 1)
        const units = Math.max(1, Math.round((2 + random() * 8) * seasonal * growth * (region.id === 1 ? 1.25 : 1)))
        const revenue = Math.round(base * units * (0.9 + random() * 0.2) * 100) / 100
        const day = 1 + Math.floor(random() * 27)
        const date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
        insertSale.run(date, region.id, product.id, region.id === 4 && month === 11 ? null : ((product.id + region.id + month) % 6) + 1, units, revenue, product.id === 1 ? Math.round(random() * 15) / 100 : null)
      }
    }
  }
}
db.exec('COMMIT')
const count = db.prepare('SELECT COUNT(*) AS n FROM sales').get().n
console.log(`seeded ${count} sales rows -> ${target}`)
db.close()
