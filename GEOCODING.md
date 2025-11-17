# Geocoding Implementation

## Overview

This system automatically geocodes delivery addresses when XLS files are uploaded, using the NextBillion.ai Discover API with intelligent local caching.

## Features

### 1. Automatic Geocoding
- Every delivery address is automatically geocoded during file upload
- Uses NextBillion.ai Discover API endpoint:
  ```
  https://sgpstg.nextbillion.io/h/discover?q={address}&key={apiKey}&fallback=true&score=0.75
  ```

### 2. Intelligent Caching
- **Cache Key**: Location ID from the XLS file
- **Cache Storage**: JSON file (`backend/geocode-cache.json`)
- **Persistence**: Survives server restarts
- **Auto-save**: Saves every 10 entries and on process exit

### 3. Performance Benefits
- Reduces API calls for repeat locations
- Faster processing for previously geocoded addresses
- Detailed statistics (cache hits/misses, hit rate)

## Files Created/Modified**

### New Files**
1. **`backend/geocoding.js`** - Geocoding service
   - `geocodeAddress()` - Geocode single address
   - `geocodeMultiple()` - Batch geocoding with rate limiting
   - `geocodeRoutes()` - Geocode all deliveries in parsed data

2. **`backend/geocodeCache.js`** - Cache management
   - In-memory cache with disk persistence
   - Automatic save/load functionality
   - Cache statistics and pruning

3. **`backend/geocode-cache.json`** - Cache storage (auto-generated)

### Modified Files
1. **`backend/server.js`** - Integrated geocoding into upload flow
2. **`backend/package.json`** - Added axios dependency
3. **`.gitignore`** - Excluded cache file from git
4. **`README.md`** - Documented geocoding and caching features

## API Response Format

Each delivery object will include a `geocode` field:

```javascript
{
  stopNumber: "1",
  locationId: "ABC123",
  address: "123 Main St, City, State",
  geocode: {
    success: true,
    address: "123 Main St, City, State",
    latitude: 37.7749,
    longitude: -122.4194,
    formattedAddress: "123 Main Street, City, State, 12345",
    confidence: 0.95,
    fromCache: true,  // Indicates if result came from cache
    cachedAt: "2025-10-27T12:00:00.000Z"  // When it was cached
  }
}
```

## Geocoding Statistics

The API response includes geocoding statistics:

```javascript
{
  routes: [...],
  totalRoutes: 10,
  totalDeliveries: 150,
  geocodingStats: {
    total: 150,
    succeeded: 145,
    failed: 5,
    cacheHits: 120,
    cacheMisses: 30,
    cacheSize: 500  // Total entries in cache
  }
}
```

## Console Output

During geocoding, the console shows:
```
Starting geocoding for 150 deliveries...
✓ Geocoded (cached): 123 Main St -> (37.7749, -122.4194)
✓ Geocoded (API): 456 Oak Ave -> (37.7858, -122.4068)
✗ Failed: Invalid Address - No results found

Geocoding complete: 145 succeeded, 5 failed
Cache stats: 120 hits, 30 misses (80.0% hit rate)
Saved 500 geocoded entries to cache
```

## Cache Management

### Manual Cache Operations

The cache can be managed programmatically:

```javascript
const geocodeCache = require('./backend/geocodeCache');

// Get cache stats
const stats = geocodeCache.getStats();

// Clear all cache
geocodeCache.clear();

// Prune old entries (older than 30 days)
geocodeCache.pruneOldEntries(30);

// Check if location exists in cache
if (geocodeCache.has('ABC123')) {
  const result = geocodeCache.get('ABC123');
}
```

### Cache File Location
- Path: `backend/geocode-cache.json`
- Format: JSON object with location IDs as keys
- Auto-created on first successful geocode
- Auto-saved every 10 entries and on process exit

## Configuration

### API Key

**IMPORTANT**: The default API key `'opensesame'` is a placeholder and will likely not work. You need to obtain a valid API key from NextBillion.ai.

Set your NextBillion API key via environment variable:

```bash
export NEXTBILLION_API_KEY=your_actual_api_key_here
```

Or create a `.env` file in the `backend/` directory:
```
NEXTBILLION_API_KEY=your_actual_api_key_here
```

**To get an API key:**
1. Sign up at https://nextbillion.ai
2. Navigate to your dashboard
3. Generate an API key for the Discover API
4. Set the key using one of the methods above
5. Restart the backend server


### Rate Limiting
- 100ms delay between API requests (configurable in `geocoding.js`)
- No delay for cached results
- Helps prevent API rate limit errors

## Error Handling

### Failed Geocoding
When geocoding fails, the delivery includes:
```javascript
{
  geocode: {
    success: false,
    error: "No results found",
    address: "Invalid Address"
  }
}
```

### Empty Addresses
```javascript
{
  geocode: {
    success: false,
    error: "No address provided"
  }
}
```

## Best Practices

1. **Upload files with Location IDs** - Ensures caching works effectively
2. **Monitor cache hit rate** - Higher is better (aim for >80%)
3. **Prune old entries periodically** - Keeps cache fresh and relevant
4. **Backup cache file** - Preserve your geocoded data

## Troubleshooting

### Cache not working
- Check that Location ID field is populated in XLS
- Verify cache file has write permissions
- Check console for cache statistics

### API rate limiting
- Increase delay in `geocoding.js` (line 135)
- Use caching to reduce API calls

### Cache file corruption
- Delete `backend/geocode-cache.json`
- Cache will rebuild on next upload

