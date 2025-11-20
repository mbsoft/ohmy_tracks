require('dotenv').config();

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const { parseOmnitracXLS } = require('./parser');
const { geocodeRoutes } = require('./geocoding');
const { optimizeRoutes, optimizeAllRoutes, optimizeCustom } = require('./routeOptimizer');
const uploads = require('./uploads');

const app = express();
const PORT = process.env.PORT || 5001;
// Use a sane default secret in development to avoid runtime errors if not configured
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const NODE_ENV = process.env.NODE_ENV || 'development';
const LOGIN_EMAIL = process.env.EMAIL || (NODE_ENV !== 'production' ? 'demo@nextbillion.ai' : undefined);
const LOGIN_PASSWORD = process.env.PASSWORD || (NODE_ENV !== 'production' ? 'demo2025' : undefined);
if (!process.env.EMAIL || !process.env.PASSWORD) {
  console.log(`[auth] Using ${NODE_ENV} fallback login creds: ${LOGIN_EMAIL ? LOGIN_EMAIL : '(missing email)'} / ${LOGIN_PASSWORD ? '******' : '(missing password)'}`);
}

// Middleware
app.use(cors());
// Increase body size limits to handle large optimize payloads
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));

// Login endpoint
app.post('/api/login', (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Missing email or password' });
  }
  if (LOGIN_EMAIL && LOGIN_PASSWORD && email === LOGIN_EMAIL && password === LOGIN_PASSWORD) {
    const token = jwt.sign({ email }, JWT_SECRET, { expiresIn: '4d' });
    res.json({ token });
  } else {
    res.status(401).json({ error: 'Invalid credentials' });
  }
});

// Middleware to protect API routes
app.use('/api', (req, res, next) => {
  if (req.path === '/login' || req.path === '/health') {
    return next();
  }

  const authHeader = req.headers.authorization;
  if (authHeader) {
    const token = authHeader.split(' ')[1];
    jwt.verify(token, JWT_SECRET, (err, user) => {
      if (err) {
        return res.sendStatus(403); // Forbidden
      }
      req.user = user;
      next();
    });
  } else {
    res.sendStatus(401); // Unauthorized
  }
});

// Configure multer for file uploads
const storage = multer.memoryStorage();
const upload = multer({ 
  storage: storage,
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB limit
  },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext === '.xls' || ext === '.xlsx') {
      cb(null, true);
    } else {
      cb(new Error('Only XLS and XLSX files are allowed'));
    }
  }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'Server is running' });
});

// Clear geocoding cache endpoint
app.delete('/api/cache/clear', (req, res) => {
  try {
    const geocodeCache = require('./geocodeCache');
    const statsBefore = geocodeCache.getStats();
    const entriesCleared = statsBefore.totalEntries;
    
    geocodeCache.clear();
    
    console.log(`Cache cleared: ${entriesCleared} entries removed`);
    
    res.json({ 
      success: true,
      message: `Successfully cleared ${entriesCleared} cache entries`,
      entriesCleared: entriesCleared
    });
  } catch (error) {
    console.error('Error clearing cache:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to clear cache', 
      details: error.message 
    });
  }
});

// Optimize all routes with in-process concurrency control
app.post('/api/optimize-all', async (req, res) => {
  const { routeData, fileName, depotLocation, submitConcurrency, pollConcurrency } = req.body;
  try {
    if (!routeData || !routeData.routes) {
      return res.status(400).json({ error: 'Missing route data' });
    }
    const result = await optimizeAllRoutes(routeData, fileName, process.env, depotLocation, { submitConcurrency, pollConcurrency });
    res.json(result);
  } catch (error) {
    console.error('Error optimizing all routes:', error);
    res.status(500).json({ error: 'Failed to optimize all routes', details: error.message });
  }
});

// Full optimization: submit arbitrary request body and poll on the server
app.post('/api/optimize-full', async (req, res) => {
  try {
    const { requestBody } = req.body;
    if (!requestBody || typeof requestBody !== 'object') {
      return res.status(400).json({ error: 'Missing requestBody' });
    }
    const { result, requestId } = await optimizeCustom(requestBody, process.env);
    res.json({ requestId, result });
  } catch (error) {
    console.error('Error in optimize-full:', error);
    res.status(500).json({ error: 'Failed to run full optimization', details: error.message });
  }
});

// Optimize a single route
app.post('/api/optimize/:routeId', async (req, res) => {
  const { routeId, routeData, fileName, depotLocation, inSequence } = req.body;  // Receive all necessary data from request

  try {
    if (!depotLocation) {
      return res.status(400).json({ error: 'Depot location is required', details: 'Please provide a start/end location (latitude,longitude)' });
    }

    const apiKey = process.env.NEXTBILLION_API_KEY || '';
    const summary = await optimizeRoutes(routeData, fileName, process.env, depotLocation, inSequence);
    console.log('Optimization complete:', routeId, 'summary:', summary?.result?.summary || 'no summary');
    res.json(summary);
  } catch (error) {
    console.error('Error optimizing route:', error);
    res.status(500).json({ error: 'Failed to optimize route', details: error.message });
  }
});

// File upload and parse endpoint
app.post('/api/upload', upload.single('file'), async (req, res) => {
  req.setTimeout(300000); // 5 minutes
  res.setTimeout(300000); // 5 minutes

  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    console.log('Processing file:', req.file.originalname);

    // Parse the XLS file
    const parsedData = parseOmnitracXLS(req.file.buffer);
    console.log(`Successfully parsed ${parsedData.routes.length} routes`);

    // Initialize status tracking
    parsedData.routes.forEach(route => route.status = 'in progress');

    // Geocode all deliveries
    const apiKey = process.env.NEXTBILLION_API_KEY || '';
    const geocodedData = await geocodeRoutes(parsedData, apiKey);

    // Update status to 'complete'
    parsedData.routes.forEach(route => route.status = 'complete');

    console.log('Geocoding complete for all routes');

    // Save the processed data
    const savedUpload = await uploads.saveUpload(req.file.originalname, geocodedData);

    res.json({ ...savedUpload.data, fileName: savedUpload.fileName, uploadId: savedUpload.id });
  } catch (error) {
    console.error('Error processing file:', error);
    res.status(500).json({
      error: 'Failed to process file',
      details: error.message
    });
  }
});

// Endpoints for managing prior uploads
app.get('/api/uploads', async (req, res) => {
  try {
    const priorUploads = await uploads.getUploads();
    res.json(priorUploads);
  } catch (error) {
    console.error('Error getting prior uploads:', error);
    res.status(500).json({ error: 'Failed to get prior uploads', details: error.message });
  }
});

app.get('/api/uploads/:id', async (req, res) => {
  try {
    const upload = await uploads.getUpload(req.params.id);
    if (upload) {
      res.json({ ...upload.data, fileName: upload.fileName, uploadId: upload.id });
    } else {
      res.status(404).json({ error: 'Upload not found' });
    }
  } catch (error) {
    console.error('Error getting upload:', error);
    res.status(500).json({ error: 'Failed to get upload', details: error.message });
  }
});

app.delete('/api/uploads/:id', async (req, res) => {
  try {
    const success = await uploads.deleteUpload(req.params.id);
    if (success) {
      res.status(204).send();
    } else {
      res.status(404).json({ error: 'Upload not found' });
    }
  } catch (error) {
    console.error('Error deleting upload:', error);
    res.status(500).json({ error: 'Failed to delete upload', details: error.message });
  }
});

// Serve frontend build (Render serves a single web service)
const candidateFrontendDirs = [
  path.join(__dirname, '../frontend/dist'),
  path.join(__dirname, './dist')
];
const frontendDir = candidateFrontendDirs.find((p) => fs.existsSync(path.join(p, 'index.html'))) || candidateFrontendDirs[0];
console.log('Serving frontend from:', frontendDir);
app.use(express.static(frontendDir));
// SPA fallback for non-API routes
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  const indexPath = path.join(frontendDir, 'index.html');
  if (!fs.existsSync(indexPath)) {
    console.error('Frontend index not found at', indexPath);
    return res.status(500).send('Frontend build not found. Please ensure the frontend build step ran.');
  }
  res.sendFile(indexPath);
});

app.listen(PORT, () => {
  console.log(`Backend server running on http://localhost:${PORT}`);
  const apiKey = process.env.NEXTBILLION_API_KEY || '';
  console.log(`NextBillion API Key: ${apiKey.substring(0, 10)}...${apiKey.length > 10 ? ' (loaded)' : ' (default)'}`);
});

