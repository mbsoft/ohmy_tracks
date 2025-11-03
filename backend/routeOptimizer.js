const axios = require('axios');
const { parseOmnitracXLS } = require('./parser');

async function optimizeRoutes(parsedData, fileName, env, depotLocation) {
  const routes = parsedData.routes;

  if (!depotLocation) {
    throw new Error('Depot location is required for route optimization');
  }

  // We expect a single route for optimization. Use the first (and only) one.
  const route = routes[0];
  if (!route) {
    throw new Error('No route provided for optimization');
  }

    const locations = [];
    let location_index = 0;
    locations.push(depotLocation);
    // Build vehicle (with optional breaks from Paid Break rows)
    const vehicle = {
      id: route.routeId,
      description: `${route.routeId}-${route.driverName}-${route.deliveries.length}`,
      time_window: [new Date(route.routeStartTime).getTime() / 1000, new Date(route.routeEndTime).getTime() / 1000],
      start_index: location_index,
      end_index: location_index++
    };
    // Build breaks array from Paid Break rows (expand window by ±30 minutes)
    const breaks = [];
    for (const delivery of route.deliveries) {
      if (delivery.isBreak) {
        const startEpoch = convertToEpoch(delivery.arrival, route.routeStartTime);
        const endEpoch = convertToEpoch(delivery.depart, route.routeEndTime);
        if (Number.isFinite(startEpoch) && Number.isFinite(endEpoch) && endEpoch > startEpoch) {
          const durationSec = convertToSeconds(delivery.service);
          breaks.push({
            id: breaks.length + 1,
            time_windows: [[startEpoch - 1800, endEpoch + 1800]],
            description: 'Paid Break Time',
            service: durationSec
          });
        }
      }
    }
    if (breaks.length > 0) {
      vehicle.breaks = breaks;
    }
    const jobs = [];

    for (const delivery of route.deliveries) {
      // Skip breaks and any stops without valid geocode
      if (delivery.isBreak) {
        continue;
      }
      if (!delivery.geocode || !delivery.geocode.success || !delivery.geocode.latitude || !delivery.geocode.longitude) {
        continue;
      }
      const job = {
        id: `${delivery.stopNumber}-${route.routeId}`,
        description: `${delivery.stopNumber}|${delivery.locationName}|${delivery.address}|${delivery.arrival}-${delivery.depart}`,
        service: convertToSeconds(delivery.service),
        location_index: location_index++,
        time_windows: [
          [convertToEpoch(delivery.arrival, route.routeStartTime), convertToEpoch(delivery.depart, route.routeEndTime)]
        ]
      };
      locations.push(`${delivery.geocode.latitude},${delivery.geocode.longitude}`);
      jobs.push(job);
    }

    const requestBody = {
      locations: { location: locations },
      vehicles: [vehicle],
      jobs: jobs,
      options: {
        objective: { travel_cost: "duration" }
      },
      description: `Optimization for ${route.routeId}`
    };

    const response = await axios.post(`https://api.nextbillion.io/optimization/v2?key=${env.NEXTBILLION_API_KEY}`, requestBody, {
      headers: { 'Authorization': `Bearer ${env.NEXTBILLION_API_KEY}` }
    });

    const requestId = response.data.id;
    console.log(`Request ID for Route '${vehicle.id}': ${requestId}`);

    const finalResult = await pollOptimizationStatus(requestId, env.NEXTBILLION_API_KEY);
    return finalResult;
}

async function pollOptimizationStatus(requestId, apiKey, websocketClient) {
  try {
    let status = 'pending';
    let message = '';
    let lastResponse = null;
    let attempt = 0;
    console.log(`Starting optimization polling for requestId=${requestId}`);
    while (true) {
      attempt += 1;
      const pollUrl = `https://api.nextbillion.io/optimization/v2/result?id=${requestId}&key=${apiKey}`;
      console.log(`Polling URL: ${pollUrl}`);
      const response = await axios.get(pollUrl);
      lastResponse = response.data;
      // NextBillion returns status/message at the top level
      status = response.data.status || response.data.result?.status || 'error';
      message = response.data.message || response.data.result?.message || '';
      console.log(`Polling attempt #${attempt} for requestId=${requestId} -> status='${status}', message='${message || ''}'`);

      // Send updates to WebSocket clients
      if (websocketClient) {
        websocketClient.send(JSON.stringify({ requestId, status, message }));
      }

      if (status === 'Ok' && message !== 'Job still processing') {
        console.log(`Optimization for Request ID ${requestId} is complete.`);
        return lastResponse;
      }

      // Wait before polling again
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
    return lastResponse;
  } catch (error) {
    console.error(`Error polling status for Request ID ${requestId}:`, error);
    throw error;
  }
}

function convertToSeconds(hhmmss) {
  const [hh, mm, ss] = hhmmss.split(':').map(Number);
  return hh * 3600 + mm * 60 + ss;
}

function convertToEpoch(time, date) {
  return new Date(`${date.split(' ')[0]} ${time}`).getTime() / 1000;
}

module.exports = { optimizeRoutes };
