const fs = require('fs');
const path = require('path');

/**
 * Simple in-memory cache for geocoded addresses
 * Uses location ID as the key
 */
class GeocodeCache {
  constructor(cacheFilePath = path.join(__dirname, 'geocode-cache.json')) {
    this.cache = new Map();
    this.cacheFilePath = cacheFilePath;
    this.loadCache();
  }

  /**
   * Load cache from disk if it exists
   */
  loadCache() {
    try {
      if (fs.existsSync(this.cacheFilePath)) {
        const data = fs.readFileSync(this.cacheFilePath, 'utf8');
        const cacheData = JSON.parse(data);
        
        // Convert array back to Map
        this.cache = new Map(Object.entries(cacheData));
        console.log(`Loaded ${this.cache.size} geocoded entries from cache`);
      }
    } catch (error) {
      console.error('Error loading geocode cache:', error.message);
      this.cache = new Map();
    }
  }

  /**
   * Save cache to disk
   */
  saveCache() {
    try {
      // Convert Map to object for JSON serialization
      const cacheData = Object.fromEntries(this.cache);
      fs.writeFileSync(this.cacheFilePath, JSON.stringify(cacheData, null, 2), 'utf8');
      console.log(`Saved ${this.cache.size} geocoded entries to cache`);
    } catch (error) {
      console.error('Error saving geocode cache:', error.message);
    }
  }

  /**
   * Get geocoded result from cache by location ID
   * @param {string} locationId - The location ID to lookup
   * @returns {Object|null} Cached geocode result or null if not found
   */
  get(locationId) {
    if (!locationId) return null;
    
    const key = String(locationId).trim();
    if (this.cache.has(key)) {
      const cached = this.cache.get(key);
      return {
        ...cached,
        fromCache: true
      };
    }
    
    return null;
  }

  /**
   * Store geocoded result in cache
   * @param {string} locationId - The location ID
   * @param {Object} geocodeResult - The geocoding result to cache
   */
  set(locationId, geocodeResult) {
    if (!locationId) return;
    
    const key = String(locationId).trim();
    
    // Only cache successful results
    if (geocodeResult && geocodeResult.success) {
      this.cache.set(key, {
        ...geocodeResult,
        cachedAt: new Date().toISOString()
      });
      
      // Don't save to disk during processing to avoid nodemon restarts
      // Cache will be saved at the end of the geocoding process or on exit
    }
  }

  /**
   * Check if a location ID exists in cache
   * @param {string} locationId - The location ID to check
   * @returns {boolean} True if cached, false otherwise
   */
  has(locationId) {
    if (!locationId) return false;
    const key = String(locationId).trim();
    return this.cache.has(key);
  }

  /**
   * Clear all cache entries
   */
  clear() {
    this.cache.clear();
    this.saveCache();
    console.log('Geocode cache cleared');
  }

  /**
   * Get cache statistics
   * @returns {Object} Cache statistics
   */
  getStats() {
    return {
      totalEntries: this.cache.size,
      cacheFilePath: this.cacheFilePath,
      keys: Array.from(this.cache.keys()).slice(0, 10) // First 10 keys for reference
    };
  }

  /**
   * Remove old cache entries (older than specified days)
   * @param {number} days - Number of days to keep
   */
  pruneOldEntries(days = 30) {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days);
    
    let prunedCount = 0;
    for (const [key, value] of this.cache.entries()) {
      if (value.cachedAt && new Date(value.cachedAt) < cutoffDate) {
        this.cache.delete(key);
        prunedCount++;
      }
    }
    
    if (prunedCount > 0) {
      console.log(`Pruned ${prunedCount} old cache entries`);
      this.saveCache();
    }
    
    return prunedCount;
  }
}

// Create singleton instance
const geocodeCache = new GeocodeCache();

// Save cache on process exit
process.on('exit', () => {
  geocodeCache.saveCache();
});

process.on('SIGINT', () => {
  geocodeCache.saveCache();
  process.exit();
});

module.exports = geocodeCache;

