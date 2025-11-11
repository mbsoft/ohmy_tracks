const axios = require('axios');

function determineDepotLocation(fileName) {
  if (fileName && fileName.startsWith('ATL')) {
    return '33.807970,-84.43696';
  } else if (fileName && fileName.startsWith('NB Mays')) {
    return '39.44214,-74.70332';
  }
  return null; // Default or handle error
}

function getTimezoneOffsetSeconds(routeDateTime) {
  const s = String(routeDateTime || '').toUpperCase();
  // Handle common US time zone abbreviations that may appear in the report
  if (s.includes('EDT')) return 4 * 3600; // UTC-4
  if (s.includes('EST')) return 5 * 3600; // UTC-5
  if (s.includes('CDT')) return 5 * 3600; // UTC-5
  if (s.includes('CST')) return 6 * 3600; // UTC-6
  if (s.includes('MDT')) return 6 * 3600; // UTC-6
  if (s.includes('MST')) return 7 * 3600; // UTC-7
  if (s.includes('PDT')) return 7 * 3600; // UTC-7
  if (s.includes('PST')) return 8 * 3600; // UTC-8
  return 0;
}

function computeEndOfShift1900(routeDateTime) {
  if (!routeDateTime) return 0;
  const dateOnly = String(routeDateTime).split(' ')[0];
  const d = new Date(`${dateOnly} 19:00:00`);
  const tzAdjust = getTimezoneOffsetSeconds(routeDateTime);
  return Math.floor(d.getTime() / 1000) + tzAdjust;
}

function computeEndOfShift1700(routeDateTime) {
  if (!routeDateTime) return 0;
  const dateOnly = String(routeDateTime).split(' ')[0];
  const d = new Date(`${dateOnly} 17:00:00`);
  const tzAdjust = getTimezoneOffsetSeconds(routeDateTime);
  return Math.floor(d.getTime() / 1000) + tzAdjust;
}

function parseTimeToEpoch(timeStr, routeDateTime) {
  if (!timeStr || !routeDateTime) return 0;
  const dateOnly = String(routeDateTime).split(' ')[0];
  const t = String(timeStr).trim();
  const m = t.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (!m) {
    const d = new Date(`${dateOnly} ${t}`);
    const epoch = Math.floor(d.getTime() / 1000);
    const tzAdjust = getTimezoneOffsetSeconds(routeDateTime);
    return Number.isFinite(epoch) ? epoch + tzAdjust : 0;
  }
  let hours = parseInt(m[1], 10);
  const minutes = parseInt(m[2], 10);
  const seconds = m[3] ? parseInt(m[3], 10) : 0;
  const ampm = m[4] ? m[4].toLowerCase() : '';
  if (ampm === 'pm' && hours !== 12) hours += 12;
  if (ampm === 'am' && hours === 12) hours = 0;
  const d = new Date(`${dateOnly} ${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`);
  const tzAdjust = getTimezoneOffsetSeconds(routeDateTime);
  return Math.floor(d.getTime() / 1000) + tzAdjust;
}

function deriveTimeWindowEpochs(openCloseTime, routeDateTime, fallbackArrival, fallbackDepart) {
  if (openCloseTime) {
    const tokens = [];
    const re = /(\d{1,2}:\d{2}(?::\d{2})?\s*(?:am|pm)?)/gi;
    let match;
    while ((match = re.exec(openCloseTime)) !== null) {
      tokens.push(match[1].trim());
      if (tokens.length === 2) break;
    }
    if (tokens.length === 2) {
      const start = parseTimeToEpoch(tokens[0], routeDateTime);
      const end = parseTimeToEpoch(tokens[1], routeDateTime);
      if (start && end && end >= start) return [start, end];
    }
    const openMatch = /open\s+(\d{1,2}:\d{2}(?::\d{2})?\s*(?:am|pm)?)/i.exec(openCloseTime);
    const closeMatch = /close\s+(\d{1,2}:\d{2}(?::\d{2})?\s*(?:am|pm)?)/i.exec(openCloseTime);
    if (openMatch && closeMatch) {
      const start = parseTimeToEpoch(openMatch[1], routeDateTime);
      const end = parseTimeToEpoch(closeMatch[1], routeDateTime);
      if (start && end && end >= start) return [start, end];
    }
  }
  const start = convertToEpoch(fallbackArrival, routeDateTime);
  const end = convertToEpoch(fallbackDepart, routeDateTime);
  return [start, end];
}

async function submitAndPoll(requestBody, apiKey) {
  const url = `https://api.nextbillion.io/optimization/v2?key=${apiKey}`;
  console.log('NB Optimization request URL:', url);
  console.log('NB Optimization request body:', JSON.stringify(requestBody, null, 2));
  const submitResp = await axios.post(url, requestBody, { headers: { 'Content-Type': 'application/json' } });
  const requestId = submitResp?.data?.id || submitResp?.data?.requestId;
  if (!requestId) {
    console.error('Unexpected submit response:', submitResp?.data);
    throw new Error('Failed to get request id from NB optimization submit');
  }
  const result = await pollOptimizationStatus(requestId, apiKey);
  return { result, requestId };
}

async function optimizeRoutes(routeData, fileName, env, depotLocationFromClient) {
  const routes = routeData?.routes || [];
  const apiKey = env.NEXTBILLION_API_KEY || 'opensesame';

  const depotLocation = depotLocationFromClient || determineDepotLocation(fileName);
  if (!depotLocation) {
    throw new Error('Depot location is required for route optimization');
  }

  let finalCombined = null;
  for (const route of routes) {
    const locations = [];
    const indexByKey = new Map();
    const addLocation = (key, latlng) => {
      if (!indexByKey.has(key)) {
        indexByKey.set(key, locations.length);
        locations.push(latlng);
      }
      return indexByKey.get(key);
    };

    const depotIndex = addLocation('depot', depotLocation);

    const baseJobs = [];
    for (const delivery of route.deliveries) {
      const lat = delivery?.geocode?.latitude ?? delivery?.latitude;
      const lng = delivery?.geocode?.longitude ?? delivery?.longitude;
      if (lat == null || lng == null) continue;
      const locIdx = addLocation(`stop-${delivery.stopNumber}`, `${lat},${lng}`);
      const [twStart, twEnd] = deriveTimeWindowEpochs(
        delivery.openCloseTime,
        route.routeStartTime,
        delivery.arrival,
        delivery.depart
      );
      baseJobs.push({
        id: `${delivery.stopNumber}-${route.routeId}`,
        description: `${delivery.stopNumber}|${delivery.locationName}|${delivery.address}|${delivery.arrival}-${delivery.depart}`,
        service: convertToSecondsSafe(delivery.service),
        location_index: locIdx,
        time_windows: [[twStart, twEnd]],
      });
    }

    const vehicle = {
      id: route.routeId,
      description: `${route.routeId}-${route.driverName}-${route.deliveries.length}`,
      time_window: [new Date(route.routeStartTime).getTime() / 1000, new Date(route.routeEndTime).getTime() / 1000],
      start_index: depotIndex,
      end_index: depotIndex,
      layover_config: {
        max_continuous_time: 18000,
        layover_duration: 1800,
        include_service_time: true
      }
    };

    const vehicleSeq = {
      ...vehicle,
      time_window: [vehicle.time_window[0], computeEndOfShift1700(route.routeStartTime)]
    };
    const vehicleNoSeq = {
      ...vehicle,
      time_window: [vehicle.time_window[0], computeEndOfShift1900(route.routeStartTime)]
    };

    // 1) In-sequence run (sequence_order)
  let seq = 1;
  const jobsInSeq = baseJobs.map((j, idx) => {
    const sequence_order = idx + 1;
    if (sequence_order === 1) {
      return { ...j, sequence_order };
    }
    const { time_windows, ...rest } = j;
    return { ...rest, sequence_order };
  });
    const requestBodySeq = {
      locations: { location: locations },
      vehicles: [vehicleSeq],
      jobs: jobsInSeq,
      options: { routing: { mode: 'truck', traffic_timestamp: 1760648400},objective: { travel_cost: 'duration' } },
      description: `Optimization (in-sequence) for ${route.routeId}`
    };
    const { result: resultInSeq, requestId: requestIdInSeq } = await submitAndPoll(requestBodySeq, apiKey);

    // 2) No predefined sequence run
    const requestBodyNoSeq = {
      locations: { location: locations },
      vehicles: [vehicleNoSeq],
      jobs: baseJobs,
      options: { routing: { mode: 'truck', traffic_timestamp: 1760648400 },objective: { travel_cost: 'duration' } },
      description: `Optimization (no sequence) for ${route.routeId}`
    };
    const { result: resultNoSeq, requestId: requestIdNoSeq } = await submitAndPoll(requestBodyNoSeq, apiKey);

    const seqUnassigned = Array.isArray(resultInSeq?.result?.unassigned) ? resultInSeq.result.unassigned.length : 0;
    const noUnassigned = Array.isArray(resultNoSeq?.result?.unassigned) ? resultNoSeq.result.unassigned.length : 0;

    finalCombined = {
      ...resultNoSeq,
      requestId: requestIdNoSeq,
      requestIds: { inSequence: requestIdInSeq, noSequence: requestIdNoSeq },
      summaries: {
        inSequence: resultInSeq?.result?.summary,
        noSequence: resultNoSeq?.result?.summary,
      },
      unassignedCounts: {
        inSequence: seqUnassigned,
        noSequence: noUnassigned
      }
    };
  }

  return finalCombined;
}

async function pollOptimizationStatus(requestId, apiKey) {
  try {
    let attempt = 0;
    while (true) {
      attempt += 1;
      const pollUrl = `https://api.nextbillion.io/optimization/v2/result?id=${requestId}&key=${apiKey}`;
      console.log(`Polling URL: ${pollUrl}`);
      const response = await axios.get(pollUrl);
      const status = response.data.status || response.data.result?.status || 'error';
      const message = response.data.message || response.data.result?.message || '';
      console.log(`Polling attempt #${attempt} requestId=${requestId} -> status='${status}', message='${message || ''}'`);
      if (status === 'Ok' && message !== 'Job still processing') return response.data;
      await new Promise((r) => setTimeout(r, 5000));
    }
  } catch (error) {
    console.error('Error while polling optimization result:', error?.response?.data || error.message);
    throw error;
  }
}

function convertToSecondsSafe(val) {
  if (val == null) return 0;
  if (typeof val === 'number') return Math.max(0, Math.round(val));
  const parts = String(val).trim().split(':').map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 3600 + parts[1] * 60;
  const num = Number(val);
  return Number.isFinite(num) ? Math.max(0, Math.round(num)) : 0;
}

function convertToEpoch(time, dateTimeStr) {
  if (!time || !dateTimeStr) return 0;
  const base = new Date(`${dateTimeStr.split(' ')[0]} ${time}`);
  const tzAdjust = getTimezoneOffsetSeconds(dateTimeStr);
  return Math.floor(base.getTime() / 1000) + tzAdjust;
}

// ---------------- Concurrency helpers & optimizer -----------------
function createLimiter(limit) {
  let active = 0;
  const queue = [];
  const runNext = () => {
    if (active >= limit) return;
    const item = queue.shift();
    if (!item) return;
    active++;
    Promise.resolve()
      .then(item.fn)
      .then((res) => { active--; item.resolve(res); runNext(); })
      .catch((err) => { active--; item.reject(err); runNext(); });
  };
  return (fn) => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); runNext(); });
}

async function optimizeAllRoutes(routeData, fileName, env, depotLocationFromClient, options = {}) {
  const routes = routeData?.routes || [];
  const apiKey = env.NEXTBILLION_API_KEY;
  const depotLocation = depotLocationFromClient || determineDepotLocation(fileName);
  if (!depotLocation) throw new Error('Depot location is required for route optimization');

  const submitConcurrency = options.submitConcurrency || 12; // keep < 25/2
  const pollConcurrency = options.pollConcurrency || 8;
  const submitLimit = createLimiter(submitConcurrency);
  const pollLimit = createLimiter(pollConcurrency);

  const routeTasks = routes.map((route) => (async () => {
    // Build locations/jobs as in optimizeRoutes
    const locations = [];
    const indexByKey = new Map();
    const addLocation = (key, latlng) => {
      if (!indexByKey.has(key)) {
        indexByKey.set(key, locations.length);
        locations.push(latlng);
      }
      return indexByKey.get(key);
    };
    const depotIndex = addLocation('depot', depotLocation);

    const baseJobs = [];
    for (const delivery of route.deliveries) {
      const lat = delivery?.geocode?.latitude ?? delivery?.latitude;
      const lng = delivery?.geocode?.longitude ?? delivery?.longitude;
      if (lat == null || lng == null) continue;
      const locIdx = addLocation(`stop-${delivery.stopNumber}`, `${lat},${lng}`);
      const [twStart, twEnd] = deriveTimeWindowEpochs(
        delivery.openCloseTime,
        route.routeStartTime,
        delivery.arrival,
        delivery.depart
      );
      baseJobs.push({
        id: `${delivery.stopNumber}-${route.routeId}`,
        description: `${delivery.stopNumber}|${delivery.locationName}|${delivery.address}|${delivery.arrival}-${delivery.depart}`,
        service: convertToSecondsSafe(delivery.service),
        location_index: locIdx,
        time_windows: [[twStart, twEnd]],
      });
    }

    const vehicle = {
      id: route.routeId,
      description: `${route.routeId}-${route.driverName}-${route.deliveries.length}`,
      time_window: [new Date(route.routeStartTime).getTime() / 1000, new Date(route.routeEndTime).getTime() / 1000],
      start_index: depotIndex,
      end_index: depotIndex,
      layover_config: { max_continuous_time: 18000, layover_duration: 1800, include_service_time: true }
    };

    const vehicleSeq = {
      ...vehicle,
      time_window: [vehicle.time_window[0], computeEndOfShift1700(route.routeStartTime)]
    };
    const vehicleNoSeq = {
      ...vehicle,
      time_window: [vehicle.time_window[0], computeEndOfShift1900(route.routeStartTime)]
    };

    let seq = 1;
    const jobsInSeq = baseJobs.map((j, idx) => {
      const sequence_order = idx + 1;
      if (sequence_order === 1) {
        return { ...j, sequence_order };
      }
      const { time_windows, ...rest } = j;
      return { ...rest, sequence_order };
    });

    const requestBodySeq = {
      locations: { location: locations },
      vehicles: [vehicleSeq],
      jobs: jobsInSeq,
      options: { routing: { mode: 'truck', traffic_timestamp: 1760648400 }, objective: { travel_cost: 'duration' } },
      description: `Optimization (in-sequence) for ${route.routeId}`
    };
    const requestBodyNoSeq = {
      locations: { location: locations },
      vehicles: [vehicleNoSeq],
      jobs: baseJobs,
      options: { routing: { mode: 'truck', traffic_timestamp: 1760648400 }, objective: { travel_cost: 'duration' } },
      description: `Optimization (no sequence) for ${route.routeId}`
    };

    // Submit both runs under submit limiter
    console.log('NB Optimization (All) request URL:', `https://api.nextbillion.io/optimization/v2?key=${apiKey}`);
    console.log('NB Optimization (All) in-sequence body:', JSON.stringify(requestBodySeq, null, 2));
    const submitSeq = await submitLimit(() => axios.post(`https://api.nextbillion.io/optimization/v2?key=${apiKey}`, requestBodySeq, { headers: { 'Content-Type': 'application/json' } }));
    console.log('NB Optimization (All) no-sequence body:', JSON.stringify(requestBodyNoSeq, null, 2));
    const submitNo  = await submitLimit(() => axios.post(`https://api.nextbillion.io/optimization/v2?key=${apiKey}`, requestBodyNoSeq, { headers: { 'Content-Type': 'application/json' } }));

    const requestIdInSeq = submitSeq?.data?.id || submitSeq?.data?.requestId;
    const requestIdNoSeq = submitNo?.data?.id || submitNo?.data?.requestId;
    if (!requestIdInSeq || !requestIdNoSeq) throw new Error('Failed to get request IDs');

    const pollSeq = pollLimit(() => pollOptimizationStatus(requestIdInSeq, apiKey));
    const pollNo  = pollLimit(() => pollOptimizationStatus(requestIdNoSeq, apiKey));
    const [resultInSeq, resultNoSeq] = await Promise.all([pollSeq, pollNo]);

    const seqUnassigned = Array.isArray(resultInSeq?.result?.unassigned) ? resultInSeq.result.unassigned.length : 0;
    const noUnassigned = Array.isArray(resultNoSeq?.result?.unassigned) ? resultNoSeq.result.unassigned.length : 0;

    return {
      routeId: route.routeId,
      requestIds: { inSequence: requestIdInSeq, noSequence: requestIdNoSeq },
      result: resultNoSeq,
      summaries: {
        inSequence: resultInSeq?.result?.summary,
        noSequence: resultNoSeq?.result?.summary,
      },
      unassignedCounts: {
        inSequence: seqUnassigned,
        noSequence: noUnassigned
      }
    };
  })());

  const results = await Promise.all(routeTasks);
  return { routes: results };
}

module.exports = { optimizeRoutes, optimizeAllRoutes };
