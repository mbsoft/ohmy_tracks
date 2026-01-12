const axios = require('axios');

function describeAxiosError(error) {
  const data = error?.response?.data;
  if (data) {
    try {
      return typeof data === 'string' ? data : JSON.stringify(data);
    } catch (_) {
      return String(data);
    }
  }
  return error?.message || 'Unknown error';
}

function determineDepotLocation(fileName) {
  if (fileName && fileName.startsWith('ATL')) {
    return '33.807970,-84.43696';
  } else if (fileName && fileName.startsWith('NB Mays')) {
    return '39.44214,-74.70332';
  } else if (fileName && fileName.startsWith('POC_Tiffin')) {
    return '41.11225919719799,-83.21798883794955';
  } else if (fileName && fileName.startsWith('POC_Kalamazoo')) {
    return '42.2550391777153,-85.52065590857512';
  } else if (fileName && fileName.startsWith('Chicago 35th')) {
    return '41.83071019891988,-87.66267818901879';
  } else if (fileName && fileName.startsWith('NB Mesquite,')) {
    return '32.761533,-96.591010';
  }
  return null; // Default or handle error
}

function buildJobId(fileName, delivery, route) {
  // Prefer explicit POC job id column when present
  if (fileName && fileName.startsWith('POC_') && delivery?.pocJobId) {
    return String(delivery.pocJobId);
  }
  const stop = String(delivery?.stopNumber || '').trim();
  const name = String(delivery?.locationName || '').trim();
  const routeId = String(route?.routeId || '').trim();
  // For POC_* files, use composite of stop number and location name
  if (fileName && fileName.startsWith('POC_') && stop && name) {
    return `${stop}-${name}`;
  }
  // Default: stop number plus route id (legacy behavior)
  return `${stop}-${routeId}`;
}

function deriveVehicleCapacity(equipmentTypeId) {
  const s = String(equipmentTypeId || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (s.startsWith('40LG')) return { weight: 29000, pallets: 22 };
  if (s.startsWith('32LG')) return { weight: 25000, pallets: 18 };
  if (s.startsWith('28LG')) return { weight: 20000, pallets: 18 };
  if (s.startsWith('48LG')) return { weight: 41000, pallets: 32 };
  if (s.startsWith('18BT')) return { weight: 12000, pallets: 12 };
  if (s.startsWith('20BT')) return { weight: 14000, pallets: 14 };
  if (s.startsWith('14BAY')) return { weight: 12000, pallets: 12 };
  if (s.startsWith('10BAY')) return { weight: 10000, pallets: 10 };
  if (s.startsWith('16BAY')) return { weight: 14000, pallets: 16 };
  if (s.startsWith('4BAY')) return { weight: 4000, pallets: 4 };
  if (s.startsWith('48FT')) return { weight: 41000, pallets: 32 };
  if (s.startsWith('53FT')) return { weight: 45000, pallets: 34 };
  return { weight: 0, pallets: 0 };
}

function getServiceSeconds(fileName, delivery) {
  // For POC_* files, override to fixed 10-minute service time
  if (fileName && fileName.startsWith('POC_')) {
    return 10 * 60;
  }
  return convertToSecondsSafe(delivery?.service);
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
  const dateOnly = String(routeDateTime).split(' ')[0]; // mm/dd/yyyy
  const t = String(timeStr).trim();
  const m = t.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?$/i);
  let hours, minutes, seconds;
  if (m) {
    hours = parseInt(m[1], 10);
    minutes = parseInt(m[2], 10);
    seconds = m[3] ? parseInt(m[3], 10) : 0;
    const ampm = m[4] ? m[4].toLowerCase() : '';
    if (ampm === 'pm' && hours !== 12) hours += 12;
    if (ampm === 'am' && hours === 12) hours = 0;
  } else {
    // Fallback: try to parse HH:MM(:SS) without am/pm
    const parts = t.split(':').map((x) => parseInt(x, 10));
    if (parts.length >= 2 && parts.every((n) => Number.isFinite(n))) {
      hours = parts[0]; minutes = parts[1]; seconds = parts[2] || 0;
    } else {
      return 0;
    }
  }
  const [mm, dd, yyyy] = dateOnly.split('/').map((x) => parseInt(x, 10));
  if (!Number.isFinite(mm) || !Number.isFinite(dd) || !Number.isFinite(yyyy)) return 0;
  const tzHours = getTimezoneOffsetSeconds(routeDateTime) / 3600; // e.g., EDT -> 4
  // Local time (zone UTC- tzHours) converted to UTC by adding tzHours
  const epochMs = Date.UTC(yyyy, mm - 1, dd, hours + tzHours, minutes, seconds);
  return Math.floor(epochMs / 1000);
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
  let submitResp;
  try {
    submitResp = await axios.post(url, requestBody, { headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    console.error('NB Optimization submit error:', describeAxiosError(err));
    throw new Error(describeAxiosError(err));
  }
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
  const apiKey = env.NEXTBILLION_API_KEY || '';

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
    const baseJobsNoSeq = [];
    const shipmentsNoSeq = [];
    const hasPickup = Array.isArray(route.deliveries) && route.deliveries.some((d) => !!d?.isDepotResupply);
    const shiftStartEpoch = new Date(route.routeStartTime).getTime() / 1000;
    const isPocFile = fileName && fileName.startsWith('POC_');
    const shiftEndSeqEpoch = isPocFile ? shiftStartEpoch + 24 * 3600 : shiftStartEpoch + 12 * 3600;
    const shiftEndNoSeqEpoch = isPocFile ? shiftStartEpoch + 24 * 3600 : shiftStartEpoch + 20 * 3600;
    // Ensure job ids are unique within this optimization request
    const jobIdCounts = new Map();
    for (const delivery of route.deliveries) {
      // Use depot location index for depot resupply even if stop has no coordinates
      let locIdx;
      if (delivery?.isDepotResupply) {
        locIdx = depotIndex;
      } else {
        const lat = delivery?.geocode?.latitude ?? delivery?.latitude;
        const lng = delivery?.geocode?.longitude ?? delivery?.longitude;
        if (lat == null || lng == null) continue;
        locIdx = addLocation(`stop-${delivery.stopNumber}`, `${lat},${lng}`);
      }
      const [twStart, twEnd] = deriveTimeWindowEpochs(
        delivery.openCloseTime,
        route.routeStartTime,
        delivery.arrival,
        delivery.depart
      );
      const baseId = buildJobId(fileName, delivery, route);
      const currentCount = jobIdCounts.get(baseId) || 0;
      const nextCount = currentCount + 1;
      jobIdCounts.set(baseId, nextCount);
      const uniqueJobId = nextCount > 1 ? `${baseId}-${nextCount}` : baseId;
      const common = {
        id: uniqueJobId,
        description: `${delivery.stopNumber}|${delivery.locationName}|${delivery.address}|${delivery.arrival}-${delivery.depart}`,
        service: getServiceSeconds(fileName, delivery),
        location_index: locIdx,
        time_windows: [[twStart, twEnd]],
      };
      baseJobs.push(common);
      const palletsNum = parseNumberSafe(delivery.cube || delivery.pallets);
      const weightNum = parseNumberSafe(delivery.weight);
      const adjPallets = Math.max(0, Math.ceil(palletsNum));
      const adjWeight10 = Math.max(0, Math.round(weightNum * 10));
      if (hasPickup) {
        // Build shipments for all non-pickup stops; skip explicit pickup-only jobs
        if (!delivery.isDepotResupply) {
          const locationIdRaw = String(delivery.locationId || uniqueJobId);
          shipmentsNoSeq.push({
            // optional id for traceability
            id: uniqueJobId,
            pickup: {
              id: `${locationIdRaw}P`,
              location_index: depotIndex,
              service: 0,
              time_windows: [[shiftStartEpoch, shiftEndSeqEpoch]]
            },
            delivery: {
              id: `${locationIdRaw}D`,
              location_index: locIdx,
              service: getServiceSeconds(fileName, delivery),
              time_windows: [[twStart, twEnd]]
            },
            amount: [adjWeight10, adjPallets]
          });
        }
      } else {
        // No pickups in route → send as simple jobs without capacity arrays
        const selectorRaw = String(delivery?.Selector ?? delivery?.selector ?? '').trim().toUpperCase();
        const sequence_order = selectorRaw === 'B' ? 1 : 99;
        baseJobsNoSeq.push({ ...common, sequence_order });
      }
    }

    // shiftStartEpoch/shiftEndSeqEpoch already computed above
    const vehicle = {
      id: route.routeId,
      description: `${route.routeId}-${route.driverName}-${route.deliveries.length}`,
      time_window: [shiftStartEpoch, shiftEndSeqEpoch],
      start_index: depotIndex,
      end_index: depotIndex,
      layover_config: {
        // For POC_ files: 30-minute layover after 8 hours driving
        max_continuous_time: isPocFile ? 8 * 3600 : 18000,
        layover_duration: 1800,
        include_service_time: true
      }
    };

    const vehicleSeq = {
      ...vehicle,
      time_window: [shiftStartEpoch, shiftEndSeqEpoch]
    };
    const vehicleNoSeq = {
      ...vehicle,
      time_window: [shiftStartEpoch, shiftEndSeqEpoch],
      ...(hasPickup
        ? {
            capacity: (() => {
              const cap = deriveVehicleCapacity(route.equipmentType);
              const weight10 = Math.max(0, Math.round((cap.weight || 0) * 10));
              const pallets = Math.max(0, Math.round(cap.pallets || 0));
              return [weight10, pallets];
            })(),
          }
        : {})
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
      options: { routing: { mode: 'truck', disable_cache: false},objective: { travel_cost: 'duration' } },
      description: `Optimization (in-sequence) for ${route.routeId}`
    };
    const { result: resultInSeq, requestId: requestIdInSeq } = await submitAndPoll(requestBodySeq, apiKey);

    // 2) No predefined sequence run
    const requestBodyNoSeq = hasPickup
      ? {
          locations: { location: locations },
          vehicles: [vehicleNoSeq],
          shipments: shipmentsNoSeq,
          options: { routing: { mode: 'truck', disable_cache: false},objective: { travel_cost: 'duration' } },
          description: `Optimization (no sequence) for ${route.routeId}`
        }
      : {
          locations: { location: locations },
          vehicles: [vehicleNoSeq],
          jobs: baseJobsNoSeq,
          options: { routing: { mode: 'truck', disable_cache: false},objective: { travel_cost: 'duration' } },
          description: `Optimization (no sequence) for ${route.routeId}`
        };
    const { result: resultNoSeq, requestId: requestIdNoSeq } = await submitAndPoll(requestBodyNoSeq, apiKey);

    const seqUnassigned = Array.isArray(resultInSeq?.result?.unassigned) ? resultInSeq.result.unassigned.length : 0;
    const noUnassigned = Array.isArray(resultNoSeq?.result?.unassigned) ? resultNoSeq.result.unassigned.length : 0;

    finalCombined = {
      ...resultNoSeq,
      requestId: requestIdNoSeq,
      requestIds: { inSequence: requestIdInSeq, noSequence: requestIdNoSeq },
      resultInSeq: resultInSeq,
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
  const dateOnly = String(dateTimeStr).split(' ')[0]; // mm/dd/yyyy
  const t = String(time).trim();
  // Reuse parseTimeToEpoch for robust handling
  return parseTimeToEpoch(t, dateTimeStr);
}

function parseNumberSafe(val) {
  if (val == null) return 0;
  if (typeof val === 'number' && Number.isFinite(val)) return val;
  const n = Number(String(val).replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : 0;
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
  const apiKey = env.NEXTBILLION_API_KEY || env.NB_API_KEY || env.NB_KEY;
  if (!apiKey) {
    throw new Error('NEXTBILLION_API_KEY is not configured on the server');
  }
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
    const baseJobsNoSeq = [];
    const shipmentsNoSeq = [];
    const hasPickup = Array.isArray(route.deliveries) && route.deliveries.some((d) => !!d?.isDepotResupply);
    const shiftStartEpoch = new Date(route.routeStartTime).getTime() / 1000;
    const isPocFile = fileName && fileName.startsWith('POC_');
    const shiftEndSeqEpoch = isPocFile ? shiftStartEpoch + 24 * 3600 : shiftStartEpoch + 12 * 3600;
    const shiftEndNoSeqEpoch = isPocFile ? shiftStartEpoch + 24 * 3600 : shiftStartEpoch + 20 * 3600;
    // Ensure job ids are unique within this optimization request
    const jobIdCounts = new Map();
    for (const delivery of route.deliveries) {
      // Use depot location index for depot resupply even if stop has no coordinates
      let locIdx;
      if (delivery?.isDepotResupply) {
        locIdx = depotIndex;
      } else {
        const lat = delivery?.geocode?.latitude ?? delivery?.latitude;
        const lng = delivery?.geocode?.longitude ?? delivery?.longitude;
        if (lat == null || lng == null) continue;
        locIdx = addLocation(`stop-${delivery.stopNumber}`, `${lat},${lng}`);
      }
      const [twStart, twEnd] = deriveTimeWindowEpochs(
        delivery.openCloseTime,
        route.routeStartTime,
        delivery.arrival,
        delivery.depart
      );
      const baseId = buildJobId(fileName, delivery, route);
      const currentCount = jobIdCounts.get(baseId) || 0;
      const nextCount = currentCount + 1;
      jobIdCounts.set(baseId, nextCount);
      const uniqueJobId = nextCount > 1 ? `${baseId}-${nextCount}` : baseId;
      const common = {
        id: uniqueJobId,
        description: `${delivery.stopNumber}|${delivery.locationName}|${delivery.address}|${delivery.arrival}-${delivery.depart}`,
        service: getServiceSeconds(fileName, delivery),
        location_index: locIdx,
        time_windows: [[twStart, twEnd]],
      };
      baseJobs.push(common);
      if (hasPickup) {
        const palletsNum = parseNumberSafe(delivery.cube || delivery.pallets);
        const weightNum = parseNumberSafe(delivery.weight);
        const adjPallets = Math.max(0, Math.ceil(palletsNum));
        const adjWeight10 = Math.max(0, Math.round(weightNum * 10));
        if (!delivery.isDepotResupply) {
          const locationIdRaw = String(delivery.locationId || uniqueJobId);
          shipmentsNoSeq.push({
            id: uniqueJobId,
            pickup: {
              id: `${locationIdRaw}P`,
              location_index: depotIndex,
              service: 0,
              time_windows: [[shiftStartEpoch, shiftEndSeqEpoch]]
            },
            delivery: {
              id: `${locationIdRaw}D`,
              location_index: locIdx,
              service: getServiceSeconds(fileName, delivery),
              time_windows: [[twStart, twEnd]]
            },
            amount: [adjWeight10, adjPallets]
          });
        }
      } else {
        const selectorRaw = String(delivery?.Selector ?? delivery?.selector ?? '').trim().toUpperCase();
        const sequence_order = selectorRaw === 'B' ? 1 : 99;
        baseJobsNoSeq.push({ ...common, sequence_order });
      }
    }

    // shiftStartEpoch/shiftEndSeqEpoch already computed above
    const vehicle = {
      id: route.routeId,
      description: `${route.routeId}-${route.driverName}-${route.deliveries.length}`,
      time_window: [shiftStartEpoch, shiftEndSeqEpoch],
      start_index: depotIndex,
      end_index: depotIndex,
      layover_config: {
        // For POC_ files: 30-minute layover after 8 hours driving
        max_continuous_time: isPocFile ? 8 * 3600 : 18000,
        layover_duration: 1800,
        include_service_time: true
      }
    };

    const vehicleSeq = {
      ...vehicle,
      time_window: [shiftStartEpoch, shiftEndSeqEpoch]
    };
    const vehicleNoSeq = {
      ...vehicle,
      time_window: [shiftStartEpoch, shiftEndSeqEpoch],
      ...(hasPickup
        ? {
            capacity: (() => {
              const cap = deriveVehicleCapacity(route.equipmentType);
              const weight10 = Math.max(0, Math.round((cap.weight || 0) * 10));
              const pallets = Math.max(0, Math.round(cap.pallets || 0));
              return [weight10, pallets];
            })(),
          }
        : {})
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
      options: { routing: { mode: 'truck', disable_cache: false}, objective: { travel_cost: 'duration' } },
      description: `Optimization (in-sequence) for ${route.routeId}`
    };
    const requestBodyNoSeq = hasPickup
      ? {
          locations: { location: locations },
          vehicles: [vehicleNoSeq],
          shipments: shipmentsNoSeq,
          options: { routing: { mode: 'truck', disable_cache: false}, objective: { travel_cost: 'duration' } },
          description: `Optimization (no sequence) for ${route.routeId}`
        }
      : {
          locations: { location: locations },
          vehicles: [vehicleNoSeq],
          jobs: baseJobsNoSeq,
          options: { routing: { mode: 'truck', disable_cache: false}, objective: { travel_cost: 'duration' } },
          description: `Optimization (no sequence) for ${route.routeId}`
        };

    // Submit both runs under submit limiter
    console.log('NB Optimization (All) request URL:', 'https://api.nextbillion.io/optimization/v2?key=***');
    const submitSeq = await submitLimit(async () => {
      try {
        return await axios.post(`https://api.nextbillion.io/optimization/v2?key=${apiKey}`, requestBodySeq, { headers: { 'Content-Type': 'application/json' } });
      } catch (err) {
        console.error('NB Optimization (All) in-sequence submit error:', describeAxiosError(err));
        throw new Error(describeAxiosError(err));
      }
    });
    const submitNo  = await submitLimit(async () => {
      try {
        return await axios.post(`https://api.nextbillion.io/optimization/v2?key=${apiKey}`, requestBodyNoSeq, { headers: { 'Content-Type': 'application/json' } });
      } catch (err) {
        console.error('NB Optimization (All) no-sequence submit error:', describeAxiosError(err));
        throw new Error(describeAxiosError(err));
      }
    });

    const requestIdInSeq = submitSeq?.data?.id || submitSeq?.data?.requestId;
    const requestIdNoSeq = submitNo?.data?.id || submitNo?.data?.requestId;
    if (!requestIdInSeq || !requestIdNoSeq) throw new Error('Failed to get request IDs');

    const pollSeq = pollLimit(() => pollOptimizationStatus(requestIdInSeq, apiKey));
    const pollNo  = pollLimit(() => pollOptimizationStatus(requestIdNoSeq, apiKey));
    const [resultInSeq, resultNoSeq] = await Promise.all([pollSeq, pollNo]);

    const seqUnassigned = Array.isArray(resultInSeq?.result?.unassigned) ? resultInSeq.result.unassigned.length : 0;
    const noUnassigned = Array.isArray(resultNoSeq?.result?.unassigned) ? resultNoSeq.result.unassigned.length : 0;

    return {
      ...resultNoSeq,
      routeId: route.routeId,
      requestIds: { inSequence: requestIdInSeq, noSequence: requestIdNoSeq },
      resultInSeq: resultInSeq,
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

async function optimizeCustom(requestBody, env) {
  const apiKey = env.NEXTBILLION_API_KEY || env.NB_API_KEY || env.NB_KEY;
  if (!apiKey) {
    throw new Error('NEXTBILLION_API_KEY is not configured on the server');
  }
  const { result, requestId } = await submitAndPoll(requestBody, apiKey);
  return { result, requestId };
}

module.exports = { optimizeRoutes, optimizeAllRoutes, optimizeCustom };
