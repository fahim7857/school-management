import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
import { initDatabase } from './backend/database.js';
import { apiRouter } from './backend/api.js';
import { staffAdminRouter } from './backend/staffAdmin.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// cPanel (Passenger) অ্যাপ চালালে সার্ভার নিজে থেকে চালু হবে
const isDirectRun = process.argv[1] === __filename;
const isHosted = Boolean(
  process.env.PASSENGER_APP_ENV || process.env.IN_PASSENGER || process.env.START_SERVER
);
const shouldAutoStart = isDirectRun || isHosted || !process.versions.electron;

// সাব-পাথ (যেমন /abms)। লোকাল বা সাবডোমেইনে খালি রাখুন।
function normalizeBase(value) {
  let b = String(value || '').trim();
  if (!b || b === '/') return '';
  if (!b.startsWith('/')) b = '/' + b;
  return b.replace(/\/+$/, '');
}
const BASE_PATH = normalizeBase(process.env.BASE_PATH);

export async function startServer() {
  const app = express();
  const PORT = process.env.PORT || (isDirectRun && !isHosted ? 3000 : 0);

  // Initialize SQLite database
  await initDatabase();

  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  const frontendPath = path.join(__dirname, 'frontend');

  // HTML পেজ পাঠানো। BASE_PATH থাকলে <base> ট্যাগ ও fetch শিম ঢোকানো হয়।
  function sendPage(res, page) {
    const file = path.join(frontendPath, `${page}.html`);

    fs.readFile(file, 'utf8', (err, html) => {
      if (err) return res.status(404).send('Page not found');

      let out = html;



      if (BASE_PATH) {
        const inject =
          `<base href="${BASE_PATH}/">` +
          `<script>(function(){var B="${BASE_PATH}";var f=window.fetch;` +
          `window.fetch=function(u,o){if(typeof u==="string"&&u.charAt(0)==="/"&&u.charAt(1)!=="/"&&u.indexOf(B+"/")!==0){u=B+u;}return f.call(this,u,o);};})();</script>`;
        out = /<head[^>]*>/i.test(out)
          ? out.replace(/<head[^>]*>/i, m => m + inject)
          : inject + out;
      }

      res.type('html').send(out);
    });
  }

  // Pre-intercept any request with /api/ anywhere in the URL to route straight to API routers
  // This guarantees https://renbora.com/abms/api/staff always reaches API routers
  const handleApiRequest = (req, res, next) => {
    const apiIndex = req.originalUrl ? req.originalUrl.indexOf('/api/') : -1;
    if (apiIndex !== -1 && !req.url.startsWith('/api/')) {
      req.url = req.originalUrl.substring(apiIndex);
    }
    next();
  };

  app.use(handleApiRequest);
  app.use('/abms/api', staffAdminRouter);
  app.use('/abms/api', apiRouter);
  app.use('/api', staffAdminRouter);
  app.use('/api', apiRouter);

  if (BASE_PATH) {
    app.use(`${BASE_PATH}/api`, staffAdminRouter);
    app.use(`${BASE_PATH}/api`, apiRouter);
  }

  const router = express.Router();

  // API routes FIRST inside router as well
  router.use(handleApiRequest);
  router.use('/abms/api', staffAdminRouter);
  router.use('/abms/api', apiRouter);
  router.use('/api', staffAdminRouter);
  router.use('/api', apiRouter);

  router.use(express.static(frontendPath));

  // Explicit page routes
  const pages = [
    'login',
    'apply',
    'dashboard',
    'students',
    'student-details',
    'payments',
    'teachers',
    'staff',
    'monthly-overview',
    'expenses',
    'reports',
    'settings',
    'admin',
    'academic',
    'examinations',
    'result-cards'
  ];

  pages.forEach(page => {
    router.get(`/${page}`, (req, res) => sendPage(res, page));
    router.get(`/${page}.html`, (req, res) => sendPage(res, page));
  });

  // Root -> login page
  router.get('/', (req, res) => sendPage(res, 'login'));

  // Serve frontend files at /frontend path so /abms/frontend/*.html works
  // (critical when the app root is moved outside public_html)
  router.use('/frontend', express.static(frontendPath));

  // Safeguard: Any request targeting /api must NEVER fall through to sendPage('login')
  router.use((req, res, next) => {
    if (req.path.startsWith('/api') || (req.originalUrl && req.originalUrl.includes('/api/'))) {
      return res.status(404).json({ success: false, error: 'API route not found' });
    }
    next();
  });

  // Fallback for any other route
  router.get('*', (req, res) => {
    if (req.path.startsWith('/api') || (req.originalUrl && req.originalUrl.includes('/api/'))) {
      return res.status(404).json({ success: false, error: 'API route not found' });
    }
    sendPage(res, 'login');
  });

  if (BASE_PATH) {
    // /abms -> /abms/
    app.get(BASE_PATH, (req, res) => res.redirect(301, BASE_PATH + '/'));
    app.use(BASE_PATH, router);
  }
  // Passenger প্রিফিক্স কেটে দিলেও যেন কাজ করে
  app.use('/', router);

  return new Promise((resolve) => {
    const server = app.listen(PORT, process.env.HOST || '0.0.0.0', () => {
      const assignedPort = server.address().port;
      console.log(`Server running on http://127.0.0.1:${assignedPort}`);
      resolve(assignedPort);
    });
  });
}

// If run directly via node server.js, or hosted under cPanel/Passenger
if (shouldAutoStart) {
  startServer();
}