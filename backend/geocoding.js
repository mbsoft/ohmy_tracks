const axios = require('axios');
const geocodeCache = require('./geocodeCache');

/**
 * Geocode an address using NextBillion.ai Discover API
 * @param {string} address - The address to geocode
 * @param {string} apiKey - NextBillion API key (default: ' ')
 * @param {boolean} verbose - Whether to log detailed request/response info (default: false)
 * @param {Object} proximityHint - Optional {lat, lng, radius} for location-based search
 * @param {boolean} isLocationNameSearch - Whether this is a location name search (removes fallback/score params)
 * @returns {Promise<Object>} Geocoding result with coordinates
 */
async function geocodeAddress(address, apiKey = '', verbose = false, proximityHint = null, isLocationNameSearch = false) {
  if (!address || address.trim() === '') {
    return {
      success: false,
      error: 'Empty address',
      address: address
    };
  }

  try {
    const url = 'https://api.nextbillion.io/h/discover';
    const params = {
      q: address,
      key: apiKey
    };

    // Only add fallback and score for address-based searches, not location name searches
    if (!isLocationNameSearch) {
      params.fallback = true;
      params.score = 0.75;
    }

    // Add proximity circle if provided
    if (proximityHint && proximityHint.lat && proximityHint.lng) {
      const radius = proximityHint.radius || 5000;
      params.in = `circle:${proximityHint.lat},${proximityHint.lng};r=${radius}`;
    }

    // Always log location name searches
    if (isLocationNameSearch || verbose) {
      const queryParams = new URLSearchParams(params).toString();
      const logPrefix = isLocationNameSearch ? '🔍 Location Name API Request' : '🌐 API Request';
      console.log(`${logPrefix}: ${url}?${queryParams}`);
    }

    const response = await axios.get(url, { 
      params,
      timeout: 10000 // 10 second timeout
    });

    if (isLocationNameSearch || verbose) {
      console.log(`📡 API Response Status: ${response.status}, Items: ${response.data?.items?.length || 0}`);
    }

    if (response.data && response.data.items && response.data.items.length > 0) {
      const firstResult = response.data.items[0];
      const position = firstResult.position;
      
      return {
        success: true,
        address: address,
        latitude: position?.lat || null,
        longitude: position?.lng || null,
        formattedAddress: firstResult.title || firstResult.address?.label || address,
        confidence: firstResult.scoring?.queryScore || null,
        fullResponse: firstResult,
        usedProximityHint: !!proximityHint
      };
    } else {
      if (isLocationNameSearch || verbose) {
        console.log(`⚠️  No items found in response for: ${address}`);
      }
      return {
        success: false,
        error: 'No results found',
        address: address
      };
    }
  } catch (error) {
    try {
      // Log the full request URL we attempted, to aid debugging 404s
      const url = 'https://api.nextbillion.io/h/discover';
      // Reconstruct minimal params similar to above for logging context
      const loggingParams = new URLSearchParams({
        q: address,
        key: apiKey || '',
      }).toString();
      console.error(`❌ Geocoding error. Request: ${url}?${loggingParams} -> ${error?.response?.status || ''} ${error?.message}`);
    } catch (e) {
      // Fallback logging
      console.error(`Geocoding error for address "${address}":`, error.message);
    }
    return {
      success: false,
      error: error.message,
      address: address
    };
  }
}

/**
 * Geocode multiple addresses with rate limiting
 * @param {Array<string>} addresses - Array of addresses to geocode
 * @param {string} apiKey - NextBillion API key
 * @param {number} delayMs - Delay between requests in milliseconds
 * @returns {Promise<Array<Object>>} Array of geocoding results
 */
async function geocodeMultiple(addresses, apiKey = '', delayMs = 100) {
  const results = [];
  
  for (let i = 0; i < addresses.length; i++) {
    const result = await geocodeAddress(addresses[i], apiKey);
    results.push(result);
    
    // Add delay to avoid rate limiting (except for last item)
    if (i < addresses.length - 1 && delayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  
  return results;
}

/**
 * Find nearest adjacent geocoded location in the route
 * @param {Array} deliveries - Array of deliveries in the route
 * @param {number} currentIndex - Current delivery index
 * @returns {Object|null} Nearest geocoded location with {lat, lng} or null
 */
function findNearestGeocodedLocation(deliveries, currentIndex) {
  // Search in both directions, prioritizing closer stops
  let distance = 1;
  const maxDistance = Math.max(currentIndex, deliveries.length - currentIndex - 1);
  
  while (distance <= maxDistance) {
    // Check previous stop
    if (currentIndex - distance >= 0) {
      const prevDelivery = deliveries[currentIndex - distance];
      if (prevDelivery.geocode?.success && prevDelivery.geocode.latitude && prevDelivery.geocode.longitude) {
        return {
          lat: prevDelivery.geocode.latitude,
          lng: prevDelivery.geocode.longitude,
          distance: distance,
          direction: 'previous'
        };
      }
    }
    
    // Check next stop
    if (currentIndex + distance < deliveries.length) {
      const nextDelivery = deliveries[currentIndex + distance];
      if (nextDelivery.geocode?.success && nextDelivery.geocode.latitude && nextDelivery.geocode.longitude) {
        return {
          lat: nextDelivery.geocode.latitude,
          lng: nextDelivery.geocode.longitude,
          distance: distance,
          direction: 'next'
        };
      }
    }
    
    distance++;
  }
  
  return null;
}

/**
 * Geocode all deliveries in parsed route data
 * @param {Object} parsedData - Parsed data from parser.js
 * @param {string} apiKey - NextBillion API key
 * @returns {Promise<Object>} Parsed data with geocoded coordinates added
 */
async function geocodeRoutes(parsedData, apiKey = '') {
  console.log(`Starting geocoding for ${parsedData.totalDeliveries} deliveries...`);
  // Allow verbose request logging via env flag
  const verboseEnv = String(process.env.GEOCODE_VERBOSE || '').toLowerCase();
  const VERBOSE_REQUESTS = verboseEnv === '1' || verboseEnv === 'true';
  
  let geocodedCount = 0;
  let failedCount = 0;
  let cacheHits = 0;
  let cacheMisses = 0;
  let processedCount = 0;
  
  // PASS 1: Geocode all deliveries with addresses
  console.log('\n=== PASS 1: Geocoding with addresses ===');
  for (const route of parsedData.routes) {
    for (const delivery of route.deliveries) {
      // Skip Paid Break rows entirely
      if (delivery.isBreak) {
        continue;
      }
      const address = delivery.address;
      const locationId = delivery.locationId;
      
      if (!address || address.trim() === '') {
        // Skip for now, will process in pass 2
        delivery.geocode = null;
        continue;
      }
      
      processedCount++;
      
      // Check cache first using location ID
      let geocodeResult = null;
      if (locationId) {
        geocodeResult = geocodeCache.get(locationId);
        if (geocodeResult) {
          cacheHits++;
        }
      }
      
      // If not in cache, geocode using address
      if (!geocodeResult) {
        cacheMisses++;
        geocodeResult = await geocodeAddress(address, apiKey, VERBOSE_REQUESTS, null, false); // isLocationNameSearch = false
        
        // Add metadata about what was used for geocoding
        if (geocodeResult) {
          geocodeResult.geocodedWith = 'address';
        }
        
        // Cache the result if successful and we have a location ID
        if (geocodeResult.success && locationId) {
          geocodeCache.set(locationId, geocodeResult);
        }
        
        // Add small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      
      // Add geocoding result to delivery
      delivery.geocode = geocodeResult;
      
      if (geocodeResult.success) {
        geocodedCount++;
      } else {
        failedCount++;
      }
      
      // Log progress every 25 addresses
      if (processedCount % 25 === 0) {
        console.log(`Pass 1 Progress: ${processedCount} processed (${geocodedCount} succeeded, ${failedCount} failed)`);
      }
    }
  }
  
  console.log(`\nPass 1 Complete: ${geocodedCount} succeeded, ${failedCount} failed`);
  
  // PASS 2: Geocode deliveries without addresses or that failed, using location names with proximity hints
  console.log('\n=== PASS 2: Geocoding with location names (proximity-based) ===');
  let pass2Count = 0;
  let pass2Success = 0;
  let pass2Failed = 0;
  
  for (const route of parsedData.routes) {
    for (let i = 0; i < route.deliveries.length; i++) {
      const delivery = route.deliveries[i];
      // Skip Paid Break rows entirely
      if (delivery.isBreak) {
        continue;
      }
      const locationName = delivery.locationName;
      const locationId = delivery.locationId;
      
      // Skip if already successfully geocoded
      if (delivery.geocode?.success) {
        continue;
      }
      
      // Skip if no location name
      if (!locationName || locationName.trim() === '') {
        delivery.geocode = {
          success: false,
          error: 'No address or location name provided'
        };
        continue;
      }
      
      pass2Count++;
      processedCount++;
      
      // Check cache first (in case location name was cached)
      let geocodeResult = null;
      if (locationId) {
        geocodeResult = geocodeCache.get(locationId);
        if (geocodeResult) {
          cacheHits++;
        }
      }
      
      // If not in cache, geocode using location name with proximity hint
      if (!geocodeResult) {
        cacheMisses++;
        
        // Find nearest successfully geocoded location
        const proximityHint = findNearestGeocodedLocation(route.deliveries, i);
        
        if (proximityHint) {
          console.log(`  Using proximity hint from ${proximityHint.direction} stop (${proximityHint.distance} stops away): ${proximityHint.lat},${proximityHint.lng}`);
        }
        
        geocodeResult = await geocodeAddress(
          locationName, 
          apiKey, 
          VERBOSE_REQUESTS, 
          proximityHint ? { lat: proximityHint.lat, lng: proximityHint.lng, radius: 5000 } : null,
          true // isLocationNameSearch = true
        );
        
        // Add metadata about what was used for geocoding
        if (geocodeResult) {
          geocodeResult.geocodedWith = 'locationName';
          if (proximityHint) {
            geocodeResult.proximityHint = {
              lat: proximityHint.lat,
              lng: proximityHint.lng,
              distance: proximityHint.distance,
              direction: proximityHint.direction
            };
          }
        }
        
        // Cache the result if successful and we have a location ID
        if (geocodeResult.success && locationId) {
          geocodeCache.set(locationId, geocodeResult);
        }
        
        // Add small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      
      // Update delivery with geocoding result
      delivery.geocode = geocodeResult;
      
      if (geocodeResult.success) {
        pass2Success++;
        geocodedCount++;
        // Decrement failedCount if this was a retry
        if (delivery.geocode && !delivery.geocode.success) {
          failedCount--;
        }
      } else {
        pass2Failed++;
      }
      
      // Log progress every 10 addresses in pass 2
      if (pass2Count % 10 === 0) {
        console.log(`Pass 2 Progress: ${pass2Count} processed (${pass2Success} succeeded, ${pass2Failed} failed)`);
      }
    }
  }
  
  console.log(`\nPass 2 Complete: ${pass2Success} succeeded, ${pass2Failed} failed`);
  console.log(`\n=== FINAL RESULTS ===`);
  console.log(`Total geocoded: ${geocodedCount} succeeded, ${failedCount} failed`);
  console.log(`Cache stats: ${cacheHits} hits, ${cacheMisses} misses (${cacheHits + cacheMisses > 0 ? ((cacheHits / (cacheHits + cacheMisses)) * 100).toFixed(1) : 0}% hit rate)`);
  
  // Save cache after batch processing
  geocodeCache.saveCache();
  
  return {
    ...parsedData,
    geocodingStats: {
      total: parsedData.totalDeliveries,
      succeeded: geocodedCount,
      failed: failedCount,
      cacheHits: cacheHits,
      cacheMisses: cacheMisses,
      cacheSize: geocodeCache.getStats().totalEntries,
      pass1: { processed: processedCount - pass2Count, succeeded: geocodedCount - pass2Success },
      pass2: { processed: pass2Count, succeeded: pass2Success, failed: pass2Failed }
    }
  };
}

module.exports = {
  geocodeAddress,
  geocodeMultiple,
  geocodeRoutes
};

