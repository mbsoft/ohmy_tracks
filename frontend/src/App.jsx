import React, { useState, useEffect, useCallback } from 'react';
import FileUpload from './components/FileUpload';
import DataTable from './components/DataTable';
import LoginPage from './components/LoginPage';
import SavedReports from './components/SavedReports';
import { exportToCSV } from './utils/csvExport';

function normalizeForKey(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^a-z0-9 ]/g, '')
    .trim();
}

function toFixed6(num) {
  const n = Number(num);
  if (!Number.isFinite(n)) return '';
  return n.toFixed(6);
}

// NOTE: Hooks must be called inside components; vehicle capacity state is set in App()

function pad2(n) {
  return String(n).padStart(2, '0');
}

function computeShiftEndPlus12h(startTimeStr) {
  if (!startTimeStr) return '';
  const s = String(startTimeStr).trim();
  const m = s.match(/(\d{1,2}\/\d{1,2}\/\d{4})\s+(\d{2}:\d{2}:\d{2})(?:\s+([A-Z]{2,5}))?/);
  if (!m) return s; // fallback to original if unrecognized
  const datePart = m[1];
  const timePart = m[2];
  const tz = m[3] ? ` ${m[3]}` : '';
  const d = new Date(`${datePart} ${timePart}`);
  if (isNaN(d.getTime())) return s;
  const end = new Date(d.getTime() + 12 * 3600 * 1000);
  const mm = pad2(end.getMonth() + 1);
  const dd = pad2(end.getDate());
  const yyyy = end.getFullYear();
  const HH = pad2(end.getHours());
  const MM = pad2(end.getMinutes());
  const SS = pad2(end.getSeconds());
  return `${mm}/${dd}/${yyyy} ${HH}:${MM}:${SS}${tz}`;
}

function parseEpochFromStart(startTimeStr) {
  if (!startTimeStr) return 0;
  const s = String(startTimeStr).trim();
  const m = s.match(/(\d{1,2}\/\d{1,2}\/\d{4})\s+(\d{2}:\d{2}:\d{2})/);
  if (!m) {
    const d = new Date(s);
    return Number.isFinite(d.getTime()) ? Math.floor(d.getTime() / 1000) : 0;
  }
  const d = new Date(`${m[1]} ${m[2]}`);
  return Number.isFinite(d.getTime()) ? Math.floor(d.getTime() / 1000) : 0;
}

function formatLatLngString(value) {
  if (!value) return '';
  const parts = String(value).split(',');
  if (parts.length !== 2) return value;
  const lat = toFixed6(parts[0].trim());
  const lng = toFixed6(parts[1].trim());
  if (lat === '' || lng === '') return value;
  return `${lat},${lng}`;
}

function toNumber(value) {
  if (value == null) return NaN;
  const s = String(value).replace(/,/g, '').trim();
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

function serviceToSeconds(val) {
  if (val == null) return 0;
  if (typeof val === 'number' && Number.isFinite(val)) {
    return Math.max(0, Math.round(val));
  }
  const parts = String(val).trim().split(':').map((x) => Number(x));
  if (parts.length === 3 && parts.every((n) => Number.isFinite(n))) {
    const [h, m, s] = parts;
    return Math.max(0, h * 3600 + m * 60 + s);
  }
  if (parts.length === 2 && parts.every((n) => Number.isFinite(n))) {
    const [h, m] = parts;
    return Math.max(0, h * 3600 + m * 60);
  }
  const n = Number(String(val).trim());
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
}

function depotFromFileName(fileName) {
  if (!fileName) return '';
  const base = String(fileName).split('/').pop();
  if (base.startsWith('ATL')) return formatLatLngString('33.807970,-84.436960');
  if (base.startsWith('NB Mays')) return formatLatLngString('39.442140,-74.703320');
  if (base.startsWith('POC_')) {
    const nameNoExt = base.replace(/\.[^.]+$/, '');
    const parts = nameNoExt.split('_');
    const token = (parts[1] || '').trim().toLowerCase();
    if (token === 'tiffin') {
      return formatLatLngString('41.11225919719799,-83.21798883794955');
    }
  }
  return '';
}

function formatEpochToHHMM(epochSeconds) {
  if (epochSeconds == null) return '';
  const d = new Date(epochSeconds * 1000);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function formatSecondsToHM(totalSeconds) {
  if (!Number.isFinite(totalSeconds)) return '0m';
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.round((totalSeconds % 3600) / 60);
  if (hours > 0 && minutes > 0) return `${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h`;
  return `${minutes}m`;
}

function formatMiles(meters) {
  if (typeof meters !== 'number') return meters || 0;
  const miles = meters / 1609.344;
  return `${miles.toFixed(1)} mi`;
}

// Helper formatters to render '-' when value is zero or missing
function fmtMilesOrDash(meters) {
  return typeof meters === 'number' && meters > 0 ? formatMiles(meters) : '-';
}
function fmtSecondsOrDash(seconds) {
  return typeof seconds === 'number' && seconds > 0 ? formatSecondsToHM(seconds) : '-';
}

function extractNbTimesAndOrder(nbNonSeqResult) {
  // Expect the non-sequenced NB object with top-level `routes`.
  const root = nbNonSeqResult;
  const steps = root?.routes?.[0]?.steps || [];
  const timesByJobId = {};
  const orderByJobId = {};
  let order = 0;
  steps.forEach((s) => {
    const jobId = s.id || s.job || s.task_id;
    const type = (s.type || s.activity || '').toString().toLowerCase();
    // For display order, count only deliveries (and generic 'job' steps). Ignore pickups/starts/ends.
    const countsForOrder = type === 'delivery' || type === 'job';
    if (countsForOrder && jobId) {
      // Only assign an order the first time we see a jobId that should be counted
      if (orderByJobId[jobId] == null) {
        order += 1;
        orderByJobId[jobId] = order;
      }
    }
    const arrival = s.arrival ?? s.start_time ?? s.time ?? s.start;
    const departure =
      s.departure ??
      s.end_time ??
      (arrival != null ? arrival + (s.service || 0) + (s.setup || 0) + (s.waiting_time || 0) : undefined);
    if (jobId) {
      const existing = timesByJobId[jobId];
      if (!existing) {
        timesByJobId[jobId] = { arrival, departure };
      } else {
        // Combine across repeated job steps: earliest arrival, latest departure
        const earliestArrival =
          existing.arrival == null
            ? arrival
            : arrival == null
            ? existing.arrival
            : Math.min(existing.arrival, arrival);
        const latestDeparture =
          existing.departure == null
            ? departure
            : departure == null
            ? existing.departure
            : Math.max(existing.departure, departure);
        timesByJobId[jobId] = { arrival: earliestArrival, departure: latestDeparture };
      }
    }
  });
  return { timesByJobId, orderByJobId, steps };
}

function extractLayoverTimes(steps) {
  if (!Array.isArray(steps)) return null;
  const lay = steps.find((s) => {
    const t = (s.type || s.activity || '').toString().toLowerCase();
    const desc = (s.description || s.name || '').toString().toLowerCase();
    return t.includes('layover') || t.includes('break') || desc.includes('layover') || desc.includes('break');
  });
  if (!lay) return null;
  const arrival = lay.arrival ?? lay.start_time ?? lay.time ?? lay.start;
  const departure = lay.departure ?? lay.end_time ?? (arrival != null ? arrival + (lay.service || 0) + (lay.setup || 0) + (lay.waiting_time || 0) : undefined);
  return { arrival, departure };
}

function extractLayoverSteps(steps) {
  if (!Array.isArray(steps)) return [];
  return steps
    .filter((s) => {
      const t = (s.type || s.activity || '').toString().toLowerCase();
      const desc = (s.description || s.name || '').toString().toLowerCase();
      return t.includes('layover') || desc.includes('layover');
    })
    .map((s) => {
      const arrival = s.arrival ?? s.start_time ?? s.time ?? s.start;
      const departure =
        s.departure ??
        s.end_time ??
        (arrival != null ? arrival + (s.service || 0) + (s.setup || 0) + (s.waiting_time || 0) : undefined);
      return { arrival, departure };
    });
}

// Resolve the NextBillion step id for a delivery, trying multiple keys and fuzzy matches
function resolveNbIdForDelivery(timesByJobId, delivery, routeId) {
  const legacyJobId = `${delivery.stopNumber}-${routeId}`;
  const shipmentDeliveryId = delivery.locationId ? `${delivery.locationId}D` : null;
  const legacyShipmentDeliveryId = `${legacyJobId}D`;
  // POC job id format: CustomerNumber-ShipToNumber-Stop
  const pocJobId = (() => {
    const cust = String(delivery?.customerNumber || '').trim();
    const shipTo = String(delivery?.shipToNumber || '').trim();
    const stop = String(delivery?.stopNumber || '').trim();
    if (cust && shipTo && stop) return `${cust}-${shipTo}-${stop}`;
    return null;
  })();
  // Preferred explicit ids
  if (pocJobId && timesByJobId[pocJobId]) return pocJobId;
  if (shipmentDeliveryId && timesByJobId[shipmentDeliveryId]) return shipmentDeliveryId;
  if (timesByJobId[legacyShipmentDeliveryId]) return legacyShipmentDeliveryId;
  if (timesByJobId[legacyJobId]) return legacyJobId;
  // Fuzzy: any key ending with 'D' that contains the locationId
  if (delivery.locationId) {
    const loc = String(delivery.locationId);
    const fuzzy = Object.keys(timesByJobId || {}).find((k) => k && k.endsWith('D') && k.includes(loc));
    if (fuzzy) return fuzzy;
  }
  // Last resort: first key that includes the legacy id
  const fuzzyLegacy = Object.keys(timesByJobId || {}).find((k) => k && k.includes(legacyJobId));
  return fuzzyLegacy || legacyJobId;
}

function App() {
  const [token, setToken] = useState(localStorage.getItem('authToken'));
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [clearingCache, setClearingCache] = useState(false);
  const [cacheMessage, setCacheMessage] = useState(null);
  const [optimizingRouteIds, setOptimizingRouteIds] = useState(new Set());
  const [activeTab, setActiveTab] = useState('planned'); // 'planned' | 'full'
  const [selectedVehicleIds, setSelectedVehicleIds] = useState(new Set());
  const [selectedDeliveryKeys, setSelectedDeliveryKeys] = useState(new Set());
  const [fullOptRequestId, setFullOptRequestId] = useState(null);
  const [fullOptResult, setFullOptResult] = useState(null);
  const [fullOptRunning, setFullOptRunning] = useState(false);
  const [vehicleCapacities, setVehicleCapacities] = useState({});
  const [savedReports, setSavedReports] = useState([]);
  const [selectedRouteIds, setSelectedRouteIds] = useState(new Set());

  const toggleRouteSelection = (routeId) => {
    setSelectedRouteIds((prev) => {
      const next = new Set(prev);
      if (next.has(routeId)) {
        next.delete(routeId);
      } else {
        next.add(routeId);
      }
      return next;
    });
  };

  const fetchSavedReports = useCallback(async () => {
    if (!token) return;
    try {
      const response = await fetch('/api/uploads', {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (response.ok) {
        const reports = await response.json();
        setSavedReports(reports);
      }
    } catch (error) {
      console.error('Failed to fetch saved reports:', error);
    }
  }, [token]);

  useEffect(() => {
    fetchSavedReports();
  }, [fetchSavedReports]);

  useEffect(() => {
    fetch('/vehicle-capacity.json')
      .then((response) => response.json())
      .then((data) => setVehicleCapacities(data))
      .catch((error) => console.error('Error fetching vehicle capacities:', error));
  }, []);

  const deriveVehicleCapacity = (equipmentTypeId) => {
    const s = String(equipmentTypeId || '').trim();
    const prefix = Object.keys(vehicleCapacities).find((prefix) => s.startsWith(prefix));
    if (prefix) {
      return vehicleCapacities[prefix];
    }
    return { weight: '', pallets: '' };
  };

  const handleLogin = (newToken) => {
    localStorage.setItem('authToken', newToken);
    setToken(newToken);
  };

  const handleLogout = () => {
    localStorage.removeItem('authToken');
    setToken(null);
  };

  // Initialize selections to "all selected" when new data is loaded
  useEffect(() => {
    if (!data?.routes || data.routes.length === 0) {
      setSelectedVehicleIds(new Set());
      setSelectedDeliveryKeys(new Set());
      setSelectedRouteIds(new Set());
      return;
    }
    // Vehicles: one per route
    const vehicleIds = new Set(
      data.routes.map((route, idx) => String(route.routeId ?? idx))
    );
    setSelectedVehicleIds(vehicleIds);
    setSelectedRouteIds(vehicleIds);
    // Deliveries: all non-break stops across all routes
    const deliveryKeys = new Set();
    data.routes.forEach((route, rIndex) => {
      (route.deliveries || []).forEach((d, dIndex) => {
        if (d?.isBreak) return;
        deliveryKeys.add(`${route.routeId ?? rIndex}::${dIndex}`);
      });
    });
    setSelectedDeliveryKeys(deliveryKeys);
  }, [data?.routes]);

  const isLocalhost = typeof window !== 'undefined' && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');

  const handleOptimizeRoute = async (routeId, startLocation) => {
    const selectedRoute = data?.routes?.find((r) => r.routeId === routeId);
    if (!selectedRoute) {
      console.error('Selected route not found for optimization:', routeId);
      return;
    }

    setOptimizingRouteIds((prev) => {
      const next = new Set(prev);
      next.add(routeId);
      return next;
    });

    const payload = {
      routeId,
      routeData: { routes: [selectedRoute] },
      fileName: data?.fileName,
      depotLocation: startLocation,
    };

    console.log('Optimize payload (frontend -> backend /api/optimize):', payload);
    try {
      const response = await fetch(`/api/optimize/${routeId}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify(payload)
      });
      
      if (!response.ok) {
        const text = await response.text();
        console.error('Optimize API error response:', text);
        throw new Error('Failed to optimize route');
      }

      const nbResult = await response.json();
      // Extract non-sequenced for NB_* fields and sequenced for ARRIVAL/DEPART
      const { timesByJobId, orderByJobId, steps } = extractNbTimesAndOrder(nbResult.result);
      const { timesByJobId: seqTimesByJobId } = extractNbTimesAndOrder(nbResult.resultInSeq?.result || null);
      const layoverTimes = extractLayoverTimes(steps);
      const layoverSteps = extractLayoverSteps(steps);

      setData((oldData) => {
        const updatedRoutes = oldData.routes.map((route) => {
          if (route.routeId !== routeId) return route;
          const updatedDeliveries = route.deliveries.map((delivery) => {
            const chosenId = resolveNbIdForDelivery(timesByJobId, delivery, route.routeId);
            const jobTimes = timesByJobId[chosenId];
            const seqTimes = seqTimesByJobId ? seqTimesByJobId[chosenId] : null;
            const order = orderByJobId[chosenId];
            let NB_ARRIVAL = jobTimes?.arrival != null ? formatEpochToHHMM(jobTimes.arrival) : delivery.NB_ARRIVAL;
            let NB_DEPART = jobTimes?.departure != null ? formatEpochToHHMM(jobTimes.departure) : delivery.NB_DEPART;
            if (delivery.isBreak && layoverTimes) {
              NB_ARRIVAL = layoverTimes.arrival != null ? formatEpochToHHMM(layoverTimes.arrival) : NB_ARRIVAL;
              NB_DEPART = layoverTimes.departure != null ? formatEpochToHHMM(layoverTimes.departure) : NB_DEPART;
            }
            // Do not count break stop as a NextBillion stop number
            const NB_ORDER = delivery.isBreak ? undefined : order;
            // ARRIVAL/DEPART must come from sequenced result
            const ARRIVAL = seqTimes?.arrival != null ? formatEpochToHHMM(seqTimes.arrival) : (delivery.arrival || '');
            const DEPART = seqTimes?.departure != null ? formatEpochToHHMM(seqTimes.departure) : (delivery.depart || '');
            return { ...delivery, NB_ARRIVAL, NB_DEPART, NB_ORDER, arrival: ARRIVAL, depart: DEPART };
          });
          // Insert Start/End and Layover rows (POC_: also insert Break if missing)
          const isPoc = String(oldData?.fileName || '').startsWith('POC_');
          let withSynth = updatedDeliveries;
          if (isPoc) {
            const startStep = (steps || []).find((s) => String(s.type || s.activity || '').toLowerCase() === 'start');
            const endStep = (steps || []).slice().reverse().find((s) => String(s.type || s.activity || '').toLowerCase() === 'end');
            const breakStep = (steps || []).find((s) => {
              const t = String(s.type || s.activity || '').toLowerCase();
              const d = String(s.description || s.name || '').toLowerCase();
              return t.includes('break') || d.includes('break');
            });
            const startObj = startStep
              ? {
                  isStart: true,
                  stopNumber: '',
                  locationName: 'Start',
                  arrival: startStep.arrival ? formatEpochToHHMM(startStep.arrival) : '',
                  depart: startStep.departure ? formatEpochToHHMM(startStep.departure) : '',
                  NB_ARRIVAL: startStep.arrival ? formatEpochToHHMM(startStep.arrival) : '',
                  NB_DEPART: startStep.departure ? formatEpochToHHMM(startStep.departure) : '',
                }
              : null;
            const endObj = endStep
              ? {
                  isEnd: true,
                  stopNumber: '',
                  locationName: 'End',
                  arrival: endStep.arrival ? formatEpochToHHMM(endStep.arrival) : '',
                  depart: endStep.departure ? formatEpochToHHMM(endStep.departure) : '',
                  NB_ARRIVAL: endStep.arrival ? formatEpochToHHMM(endStep.arrival) : '',
                  NB_DEPART: endStep.departure ? formatEpochToHHMM(endStep.departure) : '',
                }
              : null;
            const hasBreakRow = withSynth.some((d) => d.isBreak);
            const breakObj =
              !hasBreakRow && breakStep
                ? {
                    isBreak: true,
                    stopNumber: '',
                    locationName: 'Break',
                    arrival: breakStep.arrival ? formatEpochToHHMM(breakStep.arrival) : '',
                    depart: breakStep.departure ? formatEpochToHHMM(breakStep.departure) : '',
                    NB_ARRIVAL: breakStep.arrival ? formatEpochToHHMM(breakStep.arrival) : '',
                    NB_DEPART: breakStep.departure ? formatEpochToHHMM(breakStep.departure) : '',
                  }
                : null;
            const layoverObjs = layoverSteps.map((l) => ({
              isLayover: true,
              stopNumber: '',
              locationName: 'Layover',
              arrival: l.arrival != null ? formatEpochToHHMM(l.arrival) : '',
              depart: l.departure != null ? formatEpochToHHMM(l.departure) : '',
              NB_ARRIVAL: l.arrival != null ? formatEpochToHHMM(l.arrival) : '',
              NB_DEPART: l.departure != null ? formatEpochToHHMM(l.departure) : ''
            }));
            withSynth = [
              ...(startObj ? [startObj] : []),
              ...withSynth,
              ...layoverObjs,
              ...(breakObj ? [breakObj] : []),
              ...(endObj ? [endObj] : []),
            ];
          } else {
            // Non-POC: still insert layover rows if present
            const layoverObjs = layoverSteps.map((l) => ({
              isLayover: true,
              stopNumber: '',
              locationName: 'Layover',
              arrival: l.arrival != null ? formatEpochToHHMM(l.arrival) : '',
              depart: l.departure != null ? formatEpochToHHMM(l.departure) : '',
              NB_ARRIVAL: l.arrival != null ? formatEpochToHHMM(l.arrival) : '',
              NB_DEPART: l.departure != null ? formatEpochToHHMM(l.departure) : ''
            }));
            withSynth = [...withSynth, ...layoverObjs];
          }
          return { ...route, deliveries: withSynth, summary: nbResult };
        });
        return { ...oldData, routes: updatedRoutes };
      });
    } catch (error) {
      console.error('Optimization error:', error);
    } finally {
      setOptimizingRouteIds((prev) => {
        const next = new Set(prev);
        next.delete(routeId);
        return next;
      });
    }
  };

  const handleFileUpload = async (file) => {
    setLoading(true);
    setError(null);
    setData(null);

    const formData = new FormData();
    formData.append('file', file);

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 300000);

      const response = await fetch('/api/upload', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
        },
        body: formData,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        let errorMessage = 'Failed to process file';
        try {
          const errorData = await response.json();
          errorMessage = errorData.details || errorMessage;
        } catch {
          errorMessage = `Server error: ${response.status} ${response.statusText}`;
        }
        throw new Error(errorMessage);
      }

      const result = await response.json();
      // Set base data first
      setData({ ...result, fileName: file.name });
      // Try to fetch and apply selector mapping from "<file>.extract.xlsx"
      try {
        const resp = await fetch(`/api/extract-lookup?file=${encodeURIComponent(file.name)}`, {
          headers: { 'Authorization': `Bearer ${token}` }
        });
        if (resp.ok) {
          const { map } = await resp.json();
          if (map && Object.keys(map).length > 0) {
            setData((old) => {
              if (!old?.routes) return old;
              const updatedRoutes = (old.routes || []).map((route) => {
                const updatedDeliveries = (route.deliveries || []).map((d) => {
                  const norm = normalizeForKey(d.address || '');
                  let Selector = d.Selector || 'S';
                  for (const [k, v] of Object.entries(map)) {
                    if (k && norm.includes(k)) {
                      Selector = v === 'B' ? 'B' : 'S';
                      break;
                    }
                  }
                  return { ...d, Selector };
                });
                return { ...route, deliveries: updatedDeliveries };
              });
              return { ...old, routes: updatedRoutes };
            });
          }
        }
      } catch (e) {
        console.warn('extract-lookup failed:', e);
      }
      fetchSavedReports(); // Refresh the list of saved reports
    } catch (err) {
      if (err.name === 'AbortError') {
        setError('Request timed out. The file may be too large or contain too many addresses to geocode.');
      } else {
        setError(err.message);
      }
      console.error('Upload error:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleSelectReport = async (reportId) => {
    setLoading(true);
    setError(null);
    setData(null);
    try {
      const response = await fetch(`/api/uploads/${reportId}`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (!response.ok) {
        throw new Error('Failed to load report');
      }
      const result = await response.json();
      setData(result);
      // Enrich with extract selectors, if an extract file is present
      const fileName = result?.fileName;
      if (fileName) {
        try {
          const resp = await fetch(`/api/extract-lookup?file=${encodeURIComponent(fileName)}`, {
            headers: { 'Authorization': `Bearer ${token}` }
          });
          if (resp.ok) {
            const { map } = await resp.json();
            if (map && Object.keys(map).length > 0) {
              setData((old) => {
                if (!old?.routes) return old;
                const updatedRoutes = (old.routes || []).map((route) => {
                  const updatedDeliveries = (route.deliveries || []).map((d) => {
                    const norm = normalizeForKey(d.address || '');
                    let Selector = d.Selector || 'S';
                    for (const [k, v] of Object.entries(map)) {
                      if (k && norm.includes(k)) {
                        Selector = v === 'B' ? 'B' : 'S';
                        break;
                      }
                    }
                    return { ...d, Selector };
                  });
                  return { ...route, deliveries: updatedDeliveries };
                });
                return { ...old, routes: updatedRoutes };
              });
            }
          }
        } catch (e) {
          console.warn('extract-lookup failed:', e);
        }
      }
    } catch (err) {
      setError(err.message);
      console.error('Error loading report:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteReport = async (reportId) => {
    if (window.confirm('Are you sure you want to delete this report? This action cannot be undone.')) {
      try {
        const response = await fetch(`/api/uploads/${reportId}`, {
          method: 'DELETE',
          headers: { 'Authorization': `Bearer ${token}` },
        });
        if (!response.ok) {
          throw new Error('Failed to delete report');
        }
        fetchSavedReports(); // Refresh the list
      } catch (err) {
        setError(err.message);
        console.error('Error deleting report:', err);
      }
    }
  };

  const handleOptimizeAll = async (selectedRoutesArg) => {
    const allRoutes = data?.routes || [];
    const routesToOptimize = Array.isArray(selectedRoutesArg) && selectedRoutesArg.length > 0 ? selectedRoutesArg : allRoutes;
    if (routesToOptimize.length === 0) return;
    try {
      const payload = {
        routeData: { routes: routesToOptimize },
        fileName: data.fileName,
      };
      const response = await fetch('/api/optimize-all', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        const text = await response.text();
        console.error('Optimize-all API error response:', text);
        throw new Error('Failed to optimize all routes');
      }
      const result = await response.json(); // { routes: [ { routeId, requestIds, result, summaries } ] }
      const byId = new Map();
      (result.routes || []).forEach((r) => {
        const exact = String(r.routeId);
        const trimmed = exact.trim();
        const numeric = (exact.match(/^\d+/) || [null])[0];
        const numericDash = numeric ? `${numeric} -` : null;
        byId.set(exact, r);
        byId.set(trimmed, r);
        if (numeric) byId.set(numeric, r);
        if (numericDash) byId.set(numericDash, r);
      });

      setData((oldData) => {
        if (!oldData?.routes) return oldData;
        const updatedRoutes = oldData.routes.map((route) => {
          const exact = String(route.routeId);
          const trimmed = exact.trim();
          const numeric = (exact.match(/^\d+/) || [null])[0];
          const numericDash = numeric ? `${numeric} -` : null;
          const nbRoute =
            byId.get(exact) ||
            byId.get(trimmed) ||
            (numeric && byId.get(numeric)) ||
            (numericDash && byId.get(numericDash));
          if (!nbRoute) return route;
          // Non-sequenced for NB_*; sequenced for ARRIVAL/DEPART
          const { timesByJobId, orderByJobId, steps } = extractNbTimesAndOrder(nbRoute.result);
          const { timesByJobId: seqTimesByJobId } = extractNbTimesAndOrder(nbRoute.resultInSeq?.result || null);
          const layoverTimes = extractLayoverTimes(steps);
          const layoverSteps = extractLayoverSteps(steps);
          const updatedDeliveries = route.deliveries.map((delivery) => {
            const chosenId = resolveNbIdForDelivery(timesByJobId, delivery, route.routeId);
            const jobTimes = timesByJobId[chosenId];
            const seqTimes = seqTimesByJobId ? seqTimesByJobId[chosenId] : null;
            const order = orderByJobId[chosenId];
            let NB_ARRIVAL = jobTimes?.arrival != null ? formatEpochToHHMM(jobTimes.arrival) : delivery.NB_ARRIVAL;
            let NB_DEPART = jobTimes?.departure != null ? formatEpochToHHMM(jobTimes.departure) : delivery.NB_DEPART;
            if (delivery.isBreak && layoverTimes) {
              NB_ARRIVAL = layoverTimes.arrival != null ? formatEpochToHHMM(layoverTimes.arrival) : NB_ARRIVAL;
              NB_DEPART = layoverTimes.departure != null ? formatEpochToHHMM(layoverTimes.departure) : NB_DEPART;
            }
            // Do not count break stop as a NextBillion stop number
            const NB_ORDER = delivery.isBreak ? undefined : order;
            // ARRIVAL/DEPART must come from sequenced result
            const ARRIVAL = seqTimes?.arrival != null ? formatEpochToHHMM(seqTimes.arrival) : (delivery.arrival || '');
            const DEPART = seqTimes?.departure != null ? formatEpochToHHMM(seqTimes.departure) : (delivery.depart || '');
            return { ...delivery, NB_ARRIVAL, NB_DEPART, NB_ORDER, arrival: ARRIVAL, depart: DEPART };
          });
          // Insert Start/End and Layover rows; for POC_: also insert Break if missing
          const isPoc = String(oldData?.fileName || '').startsWith('POC_');
          let withSynth = updatedDeliveries;
          if (isPoc) {
            const startStep = (steps || []).find((s) => String(s.type || s.activity || '').toLowerCase() === 'start');
            const endStep = (steps || []).slice().reverse().find((s) => String(s.type || s.activity || '').toLowerCase() === 'end');
            const breakStep = (steps || []).find((s) => {
              const t = String(s.type || s.activity || '').toLowerCase();
              const d = String(s.description || s.name || '').toLowerCase();
              return t.includes('break') || d.includes('break');
            });
            const startObj = startStep
              ? {
                  isStart: true,
                  stopNumber: '',
                  locationName: 'Start',
                  arrival: startStep.arrival ? formatEpochToHHMM(startStep.arrival) : '',
                  depart: startStep.departure ? formatEpochToHHMM(startStep.departure) : '',
                  NB_ARRIVAL: startStep.arrival ? formatEpochToHHMM(startStep.arrival) : '',
                  NB_DEPART: startStep.departure ? formatEpochToHHMM(startStep.departure) : '',
                }
              : null;
            const endObj = endStep
              ? {
                  isEnd: true,
                  stopNumber: '',
                  locationName: 'End',
                  arrival: endStep.arrival ? formatEpochToHHMM(endStep.arrival) : '',
                  depart: endStep.departure ? formatEpochToHHMM(endStep.departure) : '',
                  NB_ARRIVAL: endStep.arrival ? formatEpochToHHMM(endStep.arrival) : '',
                  NB_DEPART: endStep.departure ? formatEpochToHHMM(endStep.departure) : '',
                }
              : null;
            const hasBreakRow = withSynth.some((d) => d.isBreak);
            const breakObj =
              !hasBreakRow && breakStep
                ? {
                    isBreak: true,
                    stopNumber: '',
                    locationName: 'Break',
                    arrival: breakStep.arrival ? formatEpochToHHMM(breakStep.arrival) : '',
                    depart: breakStep.departure ? formatEpochToHHMM(breakStep.departure) : '',
                    NB_ARRIVAL: breakStep.arrival ? formatEpochToHHMM(breakStep.arrival) : '',
                    NB_DEPART: breakStep.departure ? formatEpochToHHMM(breakStep.departure) : '',
                  }
                : null;
            const layoverObjs = layoverSteps.map((l) => ({
              isLayover: true,
              stopNumber: '',
              locationName: 'Layover',
              arrival: l.arrival != null ? formatEpochToHHMM(l.arrival) : '',
              depart: l.departure != null ? formatEpochToHHMM(l.departure) : '',
              NB_ARRIVAL: l.arrival != null ? formatEpochToHHMM(l.arrival) : '',
              NB_DEPART: l.departure != null ? formatEpochToHHMM(l.departure) : ''
            }));
            withSynth = [
              ...(startObj ? [startObj] : []),
              ...withSynth,
              ...layoverObjs,
              ...(breakObj ? [breakObj] : []),
              ...(endObj ? [endObj] : []),
            ];
          } else {
            const layoverObjs = layoverSteps.map((l) => ({
              isLayover: true,
              stopNumber: '',
              locationName: 'Layover',
              arrival: l.arrival != null ? formatEpochToHHMM(l.arrival) : '',
              depart: l.departure != null ? formatEpochToHHMM(l.departure) : '',
              NB_ARRIVAL: l.arrival != null ? formatEpochToHHMM(l.arrival) : '',
              NB_DEPART: l.departure != null ? formatEpochToHHMM(l.departure) : ''
            }));
            withSynth = [...withSynth, ...layoverObjs];
          }
          return { ...route, deliveries: withSynth, summary: nbRoute };
        });
        return { ...oldData, routes: updatedRoutes };
      });
    } catch (err) {
      console.error('Optimize-all error:', err);
      setError(err.message || 'Failed to optimize all routes');
    }
  };

  const handleExportCSV = () => {
    if (data && data.routes) {
      exportToCSV(data.routes);
    } else {
      console.error('No data available to export');
    }
  };

  const handleClearCache = async () => {
    if (!window.confirm('Are you sure you want to clear the geocoding cache? This will remove all cached location data.')) {
      return;
    }

    setClearingCache(true);
    setCacheMessage(null);

    try {
      const response = await fetch('/api/cache/clear', {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      });

      const result = await response.json();

      if (response.ok && result.success) {
        setCacheMessage({
          type: 'success',
          text: result.message
        });
        console.log(`Cache cleared: ${result.entriesCleared} entries removed`);
 
      } else {
        throw new Error(result.details || 'Failed to clear cache');
      }
    } catch (err) {
      setCacheMessage({
        type: 'error',
        text: `Error clearing cache: ${err.message}`
      });
      console.error('Cache clear error:', err);
    } finally {
      setClearingCache(false);
      setTimeout(() => setCacheMessage(null), 5000);
    }
  };

  // Aggregate optimization totals across routes that have a summary
  const aggregateTotals = (routesList) => {
    return routesList.reduce(
      (acc, route) => {
        const inSeq = route.summary?.summaries?.inSequence;
        const noSeq = route.summary?.summaries?.noSequence || route.summary?.result?.summary;
        if (inSeq) {
          acc.seq.distance += inSeq.distance || 0;
          acc.seq.duration += inSeq.duration || 0;
          acc.seq.service += inSeq.service || 0;
          
          // Calculate actual route duration from start to end timestamps
          const inSeqSteps = route.summary?.resultInSeq?.result?.routes?.[0]?.steps;
          if (inSeqSteps && inSeqSteps.length > 0) {
            const firstStep = inSeqSteps[0];
            const lastStep = inSeqSteps[inSeqSteps.length - 1];
            const startTime = firstStep.arrival ?? firstStep.start_time ?? firstStep.time;
            // For end step, use arrival time (when vehicle arrives back)
            const endTime = lastStep.arrival ?? lastStep.departure ?? lastStep.end_time ?? lastStep.time;
            if (typeof startTime === 'number' && typeof endTime === 'number') {
              acc.seq.routeDurations.push(endTime - startTime);
            }
          }
        }
        if (noSeq) {
          acc.no.distance += noSeq.distance || 0;
          acc.no.duration += noSeq.duration || 0;
          acc.no.service += noSeq.service || 0;
          
          // Calculate actual route duration from start to end timestamps
          const noSeqSteps = route.summary?.result?.routes?.[0]?.steps;
          if (noSeqSteps && noSeqSteps.length > 0) {
            const firstStep = noSeqSteps[0];
            const lastStep = noSeqSteps[noSeqSteps.length - 1];
            const startTime = firstStep.arrival ?? firstStep.start_time ?? firstStep.time;
            // For end step, use arrival time (when vehicle arrives back)
            const endTime = lastStep.arrival ?? lastStep.departure ?? lastStep.end_time ?? lastStep.time;
            if (typeof startTime === 'number' && typeof endTime === 'number') {
              acc.no.routeDurations.push(endTime - startTime);
            }
          }
        }
        // accumulate per-route stats
        acc.routes += 1;
        acc.stops += route.deliveries?.length ?? 0;
        return acc;
      },
      { 
        seq: { distance: 0, duration: 0, service: 0, routeDurations: [] }, 
        no: { distance: 0, duration: 0, service: 0, routeDurations: [] }, 
        routes: 0, 
        stops: 0 
      }
    );
  };

  const selectedRoutes = data?.routes?.filter((route, idx) => selectedRouteIds.has(String(route.routeId ?? idx))) || [];
  const totals = data?.routes ? aggregateTotals(selectedRoutes) : null;

  if (!token) {
    return <LoginPage onLogin={handleLogin} />;
  }

  return (
    <div className="min-h-screen">
      {/* Header */}
      <header className="bg-white shadow-sm">
        <div className="max-w-[1600px] mx-auto px-6 py-6 sm:px-8 lg:px-10">
          <div className="flex justify-between items-start">
            <div>
              <h1 className="text-3xl font-bold text-gray-900">
                Stop List Dashboard
              </h1>
              <p className="mt-1 text-sm text-gray-600">
                Upload and analyze stop list reports
              </p>
            </div>
            <div className="flex items-center">
              {isLocalhost && (
                <button
                  onClick={handleClearCache}
                  disabled={clearingCache}
                  className="inline-flex items-center px-4 py-2 border border-red-300 text-sm font-medium rounded-md text-red-700 bg-white hover:bg-red-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500 disabled:opacity-50 disabled:cursor-not-allowed mr-4"
                  title="Clear all cached geocoding results"
                >
                  {clearingCache ? (
                    <>
                      <svg className="animate-spin -ml-1 mr-2 h-4 w-4 text-red-700" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                      </svg>
                      Clearing...
                    </>
                  ) : (
                    <>
                      <svg className="-ml-1 mr-2 h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      </svg>
                      Clear Cache
                    </>
                  )}
                </button>
              )}
              <button
                onClick={handleLogout}
                className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-[#8F59A0] hover:bg-[#7a3f87] focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-[#7a3f87]"
              >
                Logout
              </button>
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-[1600px] mx-auto px-6 py-8 sm:px-8 lg:px-10">
        {/* Cache Clear Message */}
        {cacheMessage && (
          <div className={`mb-8 ${cacheMessage.type === 'success' ? 'bg-green-50 border-green-200' : 'bg-red-50 border-red-200'} border rounded-lg p-4`}>
            <div className="flex">
              <div className="flex-shrink-0">
                {cacheMessage.type === 'success' ? (
                  <svg className="h-5 w-5 text-green-400" viewBox="0 0 20 20" fill="currentColor">
                    <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                  </svg>
                ) : (
                  <svg className="h-5 w-5 text-red-400" viewBox="0 0 20 20" fill="currentColor">
                    <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 0 0-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 1 0 1.414 1.414L10 11.414l1.293 1.293a1 1 0 0 0 1.414-1.414L11.414 10l1.293-1.293a1 1 0 0 0-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
                  </svg>
                )}
              </div>
              <div className="ml-3">
                <p className={`text-sm font-medium ${cacheMessage.type === 'success' ? 'text-green-800' : 'text-red-800'}`}>
                  {cacheMessage.text}
                </p>
              </div>
            </div>
          </div>
        )}

        {/* File Upload and Saved Reports Section */}
        <div className="mb-8 grid grid-cols-1 md:grid-cols-2 gap-8">
          <SavedReports
            reports={savedReports}
            onSelect={handleSelectReport}
            onDelete={handleDeleteReport}
            onRefresh={fetchSavedReports}
          />
          <FileUpload onFileUpload={handleFileUpload} loading={loading} />
        </div>

        {/* Tabs */}
        <div className="border-b border-gray-200 mb-6">
          <nav className="-mb-px flex space-x-6" aria-label="Tabs">
            <button
              type="button"
              onClick={() => setActiveTab('planned')}
              className={`${activeTab === 'planned' ? 'border-blue-500 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'} whitespace-nowrap py-4 px-1 border-b-2 font-medium text-sm`}
            >
              Planned Routes
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('full')}
              className={`${activeTab === 'full' ? 'border-blue-500 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'} whitespace-nowrap py-4 px-1 border-b-2 font-medium text-sm`}
            >
              Full Optimization
            </button>
          </nav>
        </div>

        {/* Tab Content */}
        {activeTab === 'planned' && (
          <>
            {/* Error Display */}
            {error && (
              <div className="mb-8 bg-red-50 border border-red-200 rounded-lg p-4">
                <div className="flex">
                  <div className="flex-shrink-0">
                    <svg
                      className="h-5 w-5 text-red-400"
                      viewBox="0 0 20 20"
                      fill="currentColor"
                    >
                      <path
                        fillRule="evenodd"
                        d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 0 0-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 1 0 1.414 1.414L10 11.414l1.293 1.293a1 1 0 0 0 1.414-1.414L11.414 10l1.293-1.293a1 1 0 0 0-1.414-1.414L10 8.586 8.707 7.293z"
                        clipRule="evenodd"
                      />
                    </svg>
                  </div>
                  <div className="ml-3">
                    <h3 className="text-sm font-medium text-red-800">Error</h3>
                    <p className="mt-1 text-sm text-red-700">{error}</p>
                  </div>
                </div>
              </div>
            )}

            {/* Loading State */}
            {loading && (
              <div className="bg-white rounded-lg shadow p-8">
                <div className="flex flex-col items-center justify-center">
                  <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
                  <span className="mt-4 text-lg font-medium text-gray-900">Processing file...</span>
                  <p className="mt-2 text-sm text-gray-600 text-center max-w-md">
                    Parsing routes and geocoding all delivery addresses. This may take a few minutes for large files.
                  </p>
                </div>
              </div>
            )}

            {/* Data Display */}
            {data && !loading && (
              <div className="space-y-6">
                {/* Summary Stats */}
                <div className="bg-white rounded-lg shadow p-6">
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-6 justify-items-center">
                    <div className="text-center">
                      <p className="text-sm font-medium text-gray-600">Selected Routes</p>
                      <p className="mt-2 text-3xl font-bold text-gray-900">{totals?.routes ?? 0}</p>
                    </div>
                    <div className="text-center">
                      <p className="text-sm font-medium text-gray-600">Selected Stops</p>
                      <p className="mt-2 text-3xl font-bold text-gray-900">{totals?.stops ?? 0}</p>
                    </div>
                    <div className="text-center">
                      <p className="text-sm font-medium text-gray-600">Avg Stops per Route</p>
                      <p className="mt-2 text-3xl font-bold text-gray-900">{totals?.routes && totals.routes > 0 ? (totals.stops / totals.routes).toFixed(1) : 0}</p>
                    </div>
                  </div>

                  {/* Aggregate Optimization Totals */}
                  {totals && (
                    <div className="mt-6 grid grid-cols-1 md:grid-cols-2 gap-6">
                      <div className="bg-gray-50 rounded-lg p-4 text-center">
                        <p className="text-sm font-medium text-gray-600">Sequenced</p>
                        <p className="mt-2 text-2xl font-bold text-gray-900">{fmtMilesOrDash(totals.seq.distance)}</p>
                        <p className="mt-1 text-sm text-gray-600">Distance</p>
                        <p className="mt-2 text-2xl font-bold text-gray-900">{fmtSecondsOrDash(totals.seq.duration)}</p>
                        <p className="mt-1 text-sm text-gray-600">Drive Time</p>
                        <p className="mt-2 text-2xl font-bold text-gray-900">
                          {(() => {
                            const durations = totals.seq.routeDurations || [];
                            if (durations.length === 0) return '-';
                            const avgDuration = durations.reduce((sum, d) => sum + d, 0) / durations.length;
                            return fmtSecondsOrDash(avgDuration);
                          })()}
                        </p>
                        <p className="mt-1 text-sm text-gray-600">Avg Route Duration</p>
                      </div>
                      <div className="bg-gray-50 rounded-lg p-4 text-center">
                        <p className="text-sm font-medium text-gray-600">Optimized</p>
                        <p className="mt-2 text-2xl font-bold text-gray-900">{fmtMilesOrDash(totals.no.distance)}</p>
                        <p className="mt-1 text-sm text-gray-600">Distance</p>
                        <p className="mt-2 text-2xl font-bold text-gray-900">{fmtSecondsOrDash(totals.no.duration)}</p>
                        <p className="mt-1 text-sm text-gray-600">Drive Time</p>
                        <p className="mt-2 text-2xl font-bold text-gray-900">
                          {(() => {
                            const durations = totals.no.routeDurations || [];
                            if (durations.length === 0) return '-';
                            const avgDuration = durations.reduce((sum, d) => sum + d, 0) / durations.length;
                            return fmtSecondsOrDash(avgDuration);
                          })()}
                        </p>
                        <p className="mt-1 text-sm text-gray-600">Avg Route Duration</p>
                      </div>
                    </div>
                  )}

                  <div className="mt-6 flex justify-end">
                    <button
                      onClick={handleExportCSV}
                      className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-[#8F59A0] hover:bg-[#7a3f87] focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-[#7a3f87]"
                    >
                      <svg
                        className="mr-2 h-4 w-4"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                        />
                      </svg>
                      Export to CSV
                    </button>
                  </div>
                </div>

                {/* Data Table */}
                <DataTable
                  routes={data.routes}
                  fileName={data.fileName}
                  handleOptimizeRoute={handleOptimizeRoute}
                  handleOptimizeAll={handleOptimizeAll}
                  optimizingRouteIds={optimizingRouteIds}
                  selectedRouteIds={selectedRouteIds}
                  toggleRouteSelection={toggleRouteSelection}
                />
              </div>
            )}
          </>
        )}

        {activeTab === 'full' && (
          <>
            {/* Optimize toolbar */}
            <div className="mb-4 flex items-center justify-between">
              <div className="text-sm text-gray-700">
                {fullOptRequestId ? (
                  <span>Request ID: <span className="font-mono">{fullOptRequestId}</span></span>
                ) : (
                  <span className="text-gray-500">No request submitted</span>
                )}
              </div>
              <button
                type="button"
                className="inline-flex items-center bg-[#8F59A0] hover:bg-[#7a3f87] text-white font-semibold text-sm py-2 px-4 rounded disabled:opacity-50 disabled:cursor-not-allowed"
                disabled={fullOptRunning}
                onClick={async () => {
                  try {
                    setFullOptRunning(true);
                    const routes = data?.routes || [];
                    const depot = depotFromFileName(data?.fileName);
                    const indexByCoord = new Map();
                    const locations = [];
                    const getIndexForCoord = (latlng) => {
                      const key = formatLatLngString(latlng);
                      if (!indexByCoord.has(key)) {
                        indexByCoord.set(key, locations.length);
                        locations.push(key);
                      }
                      return indexByCoord.get(key);
                    };

                    // Vehicles from selectedVehicleIds
                    const vehicles = [];
                    routes.forEach((route, idx) => {
                      const routeId = String(route.routeId ?? idx);
                      if (!selectedVehicleIds.has(routeId)) return;
                      const startLoc = (() => {
                        if (depot) return depot;
                        const first = (route.deliveries || []).find((d) => d?.geocode?.success && d?.geocode?.latitude && d?.geocode?.longitude);
                        return first ? formatLatLngString(`${first.geocode.latitude},${first.geocode.longitude}`) : '';
                      })();
                      const startIdx = getIndexForCoord(startLoc);
                      const startEpoch = parseEpochFromStart(route.routeStartTime || '');
                      const endEpoch = startEpoch + 10 * 3600;
                      const cap = deriveVehicleCapacity(route.equipmentType || '');
                      vehicles.push({
                        id: routeId,
                        description: `${routeId}-${route.driverName || ''}`,
                        time_window: [startEpoch, endEpoch],
                        start_index: startIdx,
                        end_index: startIdx,
                        max_working_time: 36000,
                        layover_config: { max_continuous_time: 18000, layover_duration: 1800, include_service_time: true },
                        capacity: [
                          Number.isFinite(cap.weight) ? cap.weight * 10 : 0, // weight constraint times 10
                          Number.isFinite(cap.pallets) ? cap.pallets : 0     // pallet capacity
                        ]
                      });
                    });

                    // Jobs and Shipments from selectedDeliveryKeys
                    const jobs = [];
                    const shipments = [];
                    routes.forEach((route, rIndex) => {
                      (route.deliveries || []).forEach((d, dIndex) => {
                        const key = `${route.routeId ?? rIndex}::${dIndex}`;
                        if (!selectedDeliveryKeys.has(key)) return;
                        if (d?.isBreak) return;
                        const lat = d?.geocode?.latitude ?? d?.latitude;
                        const lng = d?.geocode?.longitude ?? d?.longitude;
                        if (lat == null || lng == null) return;
                        const locIdx = getIndexForCoord(`${lat},${lng}`);
                        const palletsNum = toNumber(d.cube || d.pallets || '');
                        const weightNum = toNumber(d.weight || '');
                        const adjPallets = Number.isFinite(palletsNum) ? Math.ceil(palletsNum) : 0;
                        const adjWeight = Number.isFinite(weightNum) ? Math.round(weightNum * 10) : 0; // ensure whole integer
                        const serviceSeconds = serviceToSeconds(d.service);
                        const selectorRaw = String(d?.Selector ?? d?.selector ?? '').trim().toUpperCase();
                        const sequence_order = selectorRaw === 'B' ? 1 : 99;
                        // Special rule: treat specific location as a shipment, not a job
                        if (String(d.locationId || '') === '2004704998') {
                          // Ensure depot/start is at index 0 if not yet added
                          const startLoc = depot || computeStartLocation(route);
                          const startIdx = getIndexForCoord(startLoc);
                          // Build shipment with provided constants
                          shipments.push({
                            id: `${d.locationId}-S`,
                            pickup: {
                              id: '2004704998P',
                              location_index: startIdx, // 0 in our locations list
                              service: 0,
                              time_windows: [[1760599800, 1760643000]]
                            },
                            delivery: {
                              id: '2004704998D',
                              location_index: locIdx, // index for this stop
                              service: 9540,
                              time_windows: [[1760608800, 1760644800]]
                            },
                            amount: [393800, 24]
                          });
                          return;
                        }
                        // Default path: create a job
                        const baseJob = {
                          id: `${d.locationId || ''}-${route.routeId || rIndex}-${dIndex}`,
                          location_index: locIdx,
                          service: serviceSeconds,
                          sequence_order,
                        };
                        if (d.isDepotResupply) {
                          baseJob.pickup = [adjWeight, adjPallets];
                        } else {
                          baseJob.delivery = [adjWeight, adjPallets];
                        }
                        jobs.push(baseJob);
                      });
                    });

                    const requestBody = {
                      locations: { location: locations },
                      vehicles,
                      jobs,
                      ...(shipments.length > 0 ? { shipments } : {}),
                      options: { 
                        routing: { mode: 'truck', traffic_timestamp: 1763629200 }, 
                        objective: { travel_cost: 'duration' }
                      },
                      description: 'Full Optimization (selected vehicles and deliveries)'
                    };
                    console.log('Full Optimization request body:', JSON.stringify(requestBody, null, 2));
                    // Submit to backend which will poll until complete
                    const resp = await fetch('/api/optimize-full', {
                      method: 'POST',
                      headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${token}`,
                      },
                      body: JSON.stringify({ requestBody })
                    });
                    if (!resp.ok) {
                      const txt = await resp.text();
                      console.error('optimize-full error response:', txt);
                      throw new Error('Full optimization failed');
                    }
                    const { requestId, result } = await resp.json();
                    setFullOptRequestId(requestId || null);
                    setFullOptResult(result || null);
                  } catch (e) {
                    console.error('Error building Full Optimization request:', e);
                  } finally {
                    setFullOptRunning(false);
                  }
                }}
              >
                {fullOptRunning ? (
                  <>
                    <svg className="animate-spin -ml-1 mr-2 h-4 w-4 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                    </svg>
                    Optimizing...
                  </>
                ) : (
                  'Optimize'
                )}
              </button>
            </div>

            {/* Summary Statistics */}
            {fullOptResult && fullOptResult.result && (
              <div className="bg-white rounded-lg shadow p-6 mb-6">
                <h3 className="text-lg font-semibold text-gray-900 mb-4">Full Optimization Summary</h3>
                
                {/* Top-level stats */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-6 justify-items-center mb-6">
                  <div className="text-center">
                    <p className="text-sm font-medium text-gray-600">Vehicles Used</p>
                    <p className="mt-2 text-3xl font-bold text-gray-900">
                      {fullOptResult.result.routes?.length ?? 0}
                    </p>
                  </div>
                  <div className="text-center">
                    <p className="text-sm font-medium text-gray-600">Assigned Deliveries</p>
                    <p className="mt-2 text-3xl font-bold text-gray-900">
                      {fullOptResult.result.routes?.reduce((sum, route) => {
                        const deliveryCount = route.steps?.filter(step => step.type === 'job').length ?? 0;
                        return sum + deliveryCount;
                      }, 0) ?? 0}
                    </p>
                  </div>
                  <div className="text-center">
                    <p className="text-sm font-medium text-gray-600">Avg Deliveries per Vehicle</p>
                    <p className="mt-2 text-3xl font-bold text-gray-900">
                      {(() => {
                        const vehicleCount = fullOptResult.result.routes?.length ?? 0;
                        const totalDeliveries = fullOptResult.result.routes?.reduce((sum, route) => {
                          const deliveryCount = route.steps?.filter(step => step.type === 'job').length ?? 0;
                          return sum + deliveryCount;
                        }, 0) ?? 0;
                        return vehicleCount > 0 ? (totalDeliveries / vehicleCount).toFixed(1) : 0;
                      })()}
                    </p>
                  </div>
                </div>

                {/* Optimization metrics */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                  <div className="bg-gray-50 rounded-lg p-4 text-center">
                    <p className="text-sm font-medium text-gray-600">Total Distance</p>
                    <p className="mt-2 text-2xl font-bold text-gray-900">
                      {fmtMilesOrDash(fullOptResult.result.summary?.distance)}
                    </p>
                  </div>
                  <div className="bg-gray-50 rounded-lg p-4 text-center">
                    <p className="text-sm font-medium text-gray-600">Drive Time</p>
                    <p className="mt-2 text-2xl font-bold text-gray-900">
                      {fmtSecondsOrDash(fullOptResult.result.summary?.duration)}
                    </p>
                  </div>
                  <div className="bg-gray-50 rounded-lg p-4 text-center">
                    <p className="text-sm font-medium text-gray-600">Average Route Duration</p>
                    <p className="mt-2 text-2xl font-bold text-gray-900">
                      {(() => {
                        const duration = fullOptResult.result.summary?.duration ?? 0;
                        const service = fullOptResult.result.summary?.service ?? 0;
                        const routeCount = fullOptResult.result.routes?.length ?? 0;
                        if (routeCount === 0 || (duration === 0 && service === 0)) return '-';
                        const avgDuration = (duration + service) / routeCount;
                        return fmtSecondsOrDash(avgDuration);
                      })()}
                    </p>
                  </div>
                </div>

                {/* Unassigned warning */}
                {fullOptResult.result.unassigned && fullOptResult.result.unassigned.length > 0 && (
                  <div className="mt-4 p-4 bg-yellow-50 border border-yellow-200 rounded-lg">
                    <p className="text-sm font-medium text-yellow-800">
                      ⚠️ Unassigned Deliveries: {fullOptResult.result.unassigned.length}
                    </p>
                  </div>
                )}
              </div>
            )}

            {/* Build vehicles and deliveries (excluding Paid Break) */}
            {(() => {
              const routes = data?.routes || [];
              const depot = depotFromFileName(data?.fileName);
              const computeStartLocation = (route) => {
                if (depot) return depot;
                // Fallback to first geocoded stop
                const first = (route.deliveries || []).find((d) => d?.geocode?.success && d?.geocode?.latitude && d?.geocode?.longitude);
                if (first) return formatLatLngString(`${first.geocode.latitude},${first.geocode.longitude}`);
                return '';
              };
              const vehicles = routes.map((route, idx) => {
                const startLoc = computeStartLocation(route);
                const endLoc = startLoc; // Same rules as sequenced and non-sequenced (start=end=depot)
                const cap = deriveVehicleCapacity(route.equipmentType || '');
                return {
                  id: String(route.routeId ?? idx),
                  equipmentTypeId: route.equipmentType || '',
                  driverId: route.driverId || '',
                  driverName: route.driverName || '',
                  startTime: route.routeStartTime || '',
                  endTime: computeShiftEndPlus12h(route.routeStartTime || '') || '',
                  capacityWeight: cap.weight,
                  capacityPallets: cap.pallets,
                  startLocation: startLoc,
                  endLocation: endLoc,
                };
              });
              const deliveries = [];
              routes.forEach((route, rIndex) => {
                (route.deliveries || []).forEach((d, dIndex) => {
                  if (d?.isBreak) return; // exclude Paid Break Time
                  const palletsRaw = d.cube || d.pallets || '';
                  const palletsNum = toNumber(palletsRaw);
                  const weightRaw = d.weight || '';
                  const weightNum = toNumber(weightRaw);
                  deliveries.push({
                    key: `${route.routeId ?? rIndex}::${dIndex}`,
                    step: d.stopNumber || '',
                    isDepotResupply: !!d.isDepotResupply,
                    selector: (String(d?.Selector ?? d?.selector ?? '').trim().toUpperCase() === 'B' ? 'B' : 'S'),
                    locationId: d.locationId || '',
                    locationName: d.locationName || '',
                    address: d.address || '',
                    serviceWindows: d.serviceWindows || d.openCloseTime || '',
                    service: d.service || '',
                    weight: weightRaw,
                    adjWeight: Number.isFinite(weightNum) ? String(weightNum * 10) : '',
                    pallets: palletsRaw,
                    adjPallets: Number.isFinite(palletsNum) ? Math.ceil(palletsNum) : '',
                  });
                });
              });

              const allVehiclesSelected = vehicles.length > 0 && vehicles.every((v) => selectedVehicleIds.has(v.id));
              const toggleAllVehicles = () => {
                if (allVehiclesSelected) {
                  setSelectedVehicleIds(new Set());
                } else {
                  setSelectedVehicleIds(new Set(vehicles.map((v) => v.id)));
                }
              };
              const toggleVehicle = (id) => {
                setSelectedVehicleIds((prev) => {
                  const next = new Set(prev);
                  if (next.has(id)) next.delete(id);
                  else next.add(id);
                  return next;
                });
              };

              const allDeliveriesSelected = deliveries.length > 0 && deliveries.every((d) => selectedDeliveryKeys.has(d.key));
              const toggleAllDeliveries = () => {
                if (allDeliveriesSelected) {
                  setSelectedDeliveryKeys(new Set());
                } else {
                  setSelectedDeliveryKeys(new Set(deliveries.map((d) => d.key)));
                }
              };
              const toggleDelivery = (key) => {
                setSelectedDeliveryKeys((prev) => {
                  const next = new Set(prev);
                  if (next.has(key)) next.delete(key);
                  else next.add(key);
                  return next;
                });
              };

              return (
                <div className="space-y-8">
                  {/* Vehicle Inventory */}
                  <div className="bg-white rounded-lg shadow overflow-hidden">
                    <div className="px-6 py-4 border-b border-gray-200">
                      <h2 className="text-lg font-semibold text-gray-900">Vehicle Inventory</h2>
                    </div>
                    <div className="overflow-x-auto max-h-[520px] overflow-y-auto">
                      <table className="min-w-full divide-y divide-gray-200 text-sm">
                        <thead className="bg-gray-50 sticky top-0 z-10">
                          <tr>
                            <th className="px-4 py-3">
                              <input type="checkbox" checked={allVehiclesSelected} onChange={toggleAllVehicles} />
                            </th>
                            <th className="px-4 py-3 text-left font-medium text-gray-700">Equipment Type ID</th>
                            <th className="px-4 py-3 text-left font-medium text-gray-700">Driver ID</th>
                            <th className="px-4 py-3 text-left font-medium text-gray-700">Driver Name</th>
                            <th className="px-4 py-3 text-left font-medium text-gray-700">Start Time</th>
                            <th className="px-4 py-3 text-left font-medium text-gray-700">End Time</th>
                            <th className="px-4 py-3 text-left font-medium text-gray-700">Capacity Weight</th>
                            <th className="px-4 py-3 text-left font-medium text-gray-700">Capacity Pallets</th>
                            <th className="px-4 py-3 text-left font-medium text-gray-700">Start Location</th>
                            <th className="px-4 py-3 text-left font-medium text-gray-700">End Location</th>
                          </tr>
                        </thead>
                        <tbody className="bg-white divide-y divide-gray-200">
                          {vehicles.map((v) => (
                            <tr key={v.id} className="hover:bg-gray-50">
                              <td className="px-4 py-3">
                                <input
                                  type="checkbox"
                                  checked={selectedVehicleIds.has(v.id)}
                                  onChange={() => toggleVehicle(v.id)}
                                />
                              </td>
                              <td className="px-4 py-3">{v.equipmentTypeId || '—'}</td>
                              <td className="px-4 py-3">{v.driverId || '—'}</td>
                              <td className="px-4 py-3">{v.driverName || '—'}</td>
                              <td className="px-4 py-3 whitespace-nowrap">{v.startTime || '—'}</td>
                              <td className="px-4 py-3 whitespace-nowrap">{v.endTime || '—'}</td>
                              <td className="px-4 py-3">{v.capacityWeight || '—'}</td>
                              <td className="px-4 py-3">{v.capacityPallets || '—'}</td>
                              <td className="px-4 py-3 font-mono text-xs">{v.startLocation || '—'}</td>
                              <td className="px-4 py-3 font-mono text-xs">{v.endLocation || '—'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  {/* Delivery List */}
                  <div className="bg-white rounded-lg shadow overflow-hidden">
                    <div className="px-6 py-4 border-b border-gray-200">
                      <h2 className="text-lg font-semibold text-gray-900">Delivery List</h2>
                    </div>
                    <div className="overflow-x-auto max-h-[520px] overflow-y-auto">
                      <table className="min-w-full divide-y divide-gray-200 text-sm">
                        <thead className="bg-gray-50 sticky top-0 z-10">
                          <tr>
                            <th className="px-4 py-3">
                              <input type="checkbox" checked={allDeliveriesSelected} onChange={toggleAllDeliveries} />
                            </th>
                            <th className="px-4 py-3 text-left font-medium text-gray-700">Step #</th>
                            <th className="px-4 py-3 text-left font-medium text-gray-700">Selector</th>
                            <th className="px-4 py-3 text-left font-medium text-gray-700">Location ID</th>
                            <th className="px-4 py-3 text-left font-medium text-gray-700">Location Name</th>
                            <th className="px-4 py-3 text-left font-medium text-gray-700">Address</th>
                            <th className="px-4 py-3 text-left font-medium text-gray-700">Service Windows</th>
                            <th className="px-4 py-3 text-left font-medium text-gray-700">Service</th>
                            <th className="px-4 py-3 text-left font-medium text-gray-700">Weight</th>
                            <th className="px-4 py-3 text-left font-medium text-gray-700">Adj. Weight</th>
                            <th className="px-4 py-3 text-left font-medium text-gray-700">Pallets</th>
                            <th className="px-4 py-3 text-left font-medium text-gray-700">Adj. Pallets</th>
                          </tr>
                        </thead>
                        <tbody className="bg-white divide-y divide-gray-200">
                          {deliveries.map((d) => (
                            <tr key={d.key} className="hover:bg-gray-50">
                              <td className="px-4 py-3">
                                <input
                                  type="checkbox"
                                  checked={selectedDeliveryKeys.has(d.key)}
                                  onChange={() => toggleDelivery(d.key)}
                                />
                              </td>
                              <td className="px-4 py-3 whitespace-nowrap">{d.isDepotResupply ? 'Depot' : (d.step || '—')}</td>
                              <td className="px-4 py-3 whitespace-nowrap">{d.selector || 'S'}</td>
                              <td className="px-4 py-3 whitespace-nowrap">{d.locationId || '—'}</td>
                              <td className="px-4 py-3">{d.locationName || '—'}</td>
                              <td className="px-4 py-3">{d.address || '—'}</td>
                              <td className="px-4 py-3 whitespace-nowrap">{d.serviceWindows || '—'}</td>
                              <td className="px-4 py-3 whitespace-nowrap">{d.service || '—'}</td>
                              <td className="px-4 py-3 whitespace-nowrap">{d.weight || '—'}</td>
                              <td className="px-4 py-3 whitespace-nowrap">{d.adjWeight || '—'}</td>
                              <td className="px-4 py-3 whitespace-nowrap">{d.pallets || '—'}</td>
                              <td className="px-4 py-3 whitespace-nowrap">{d.adjPallets || '—'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              );
            })()}
          </>
        )}
      </main>
    </div>
  );
}

export default App;
