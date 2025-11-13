require('dotenv').config();

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const { parseOmnitracXLS } = require('./parser');
const { geocodeRoutes } = require('./geocoding');
const { optimizeRoutes, optimizeAllRoutes, optimizeCustom } = require('./routeOptimizer');

const app = express();
const PORT = process.env.PORT || 5001;

// Middleware
app.use(cors());
// Increase body size limits to handle large optimize payloads
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));

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

    const apiKey = process.env.NEXTBILLION_API_KEY || 'opensesame';
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
    const apiKey = process.env.NEXTBILLION_API_KEY || 'opensesame';
    const geocodedData = await geocodeRoutes(parsedData, apiKey);

    // Update status to 'complete'
    parsedData.routes.forEach(route => route.status = 'complete');

    console.log('Geocoding complete for all routes');
    res.json({ ...geocodedData, fileName: req.file.originalname });
  } catch (error) {
    console.error('Error processing file:', error);
    res.status(500).json({
      error: 'Failed to process file',
      details: error.message
    });
  }
});

// Serve frontend build (Render serves a single web service)
const frontendDir = path.join(__dirname, '../frontend/dist');
app.use(express.static(frontendDir));
// SPA fallback for non-API routes
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(frontendDir, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Backend server running on http://localhost:${PORT}`);
  const apiKey = process.env.NEXTBILLION_API_KEY || 'opensesame';
  console.log(`NextBillion API Key: ${apiKey.substring(0, 10)}...${apiKey.length > 10 ? ' (loaded)' : ' (default)'}`);
});

