import React, { useState, useEffect } from 'react';
import {
  AppBar,
  Box,
  Button,
  Container,
  Toolbar,
  Typography,
  CircularProgress,
  Alert,
  Tabs,
  Tab,
  Grid,
  Card,
  CardContent,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Paper,
  Checkbox,
} from '@mui/material';
import { Delete as DeleteIcon, CloudUpload as CloudUploadIcon, Download as DownloadIcon } from '@mui/icons-material';
import FileUpload from './components/FileUpload';
import DataTable from './components/DataTable';
import LoginPage from './components/LoginPage';
import { exportToCSV } from './utils/csvExport';

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
  if (fileName.startsWith('ATL')) return formatLatLngString('33.807970,-84.436960');
  if (fileName.startsWith('NB Mays')) return formatLatLngString('39.442140,-74.703320');
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

function extractNbTimesAndOrder(nbResult) {
  const steps = nbResult?.result?.routes?.[0]?.steps || [];
  const timesByJobId = {};
  const orderByJobId = {};
  let order = 0;
  steps.forEach((s) => {
    const jobId = s.id || s.job || s.task_id;
    const type = (s.type || s.activity || '').toString().toLowerCase();
    if (jobId) {
      // Only assign an order the first time we see a jobId
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
  const [fullOptRunning, setFullOptRunning] = useState(false);
  const [vehicleCapacities, setVehicleCapacities] = useState({});

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
      return;
    }
    // Vehicles: one per route
    const vehicleIds = new Set(
      data.routes.map((route, idx) => String(route.routeId ?? idx))
    );
    setSelectedVehicleIds(vehicleIds);
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
      const { timesByJobId, orderByJobId, steps } = extractNbTimesAndOrder(nbResult);
      const layoverTimes = extractLayoverTimes(steps);

      setData((oldData) => {
        const updatedRoutes = oldData.routes.map((route) => {
          if (route.routeId !== routeId) return route;
          const updatedDeliveries = route.deliveries.map((delivery) => {
            const jobId = `${delivery.stopNumber}-${route.routeId}`;
            const jobTimes = timesByJobId[jobId];
            const order = orderByJobId[jobId];
            let NB_ARRIVAL = jobTimes?.arrival != null ? formatEpochToHHMM(jobTimes.arrival) : delivery.NB_ARRIVAL;
            let NB_DEPART = jobTimes?.departure != null ? formatEpochToHHMM(jobTimes.departure) : delivery.NB_DEPART;
            if (delivery.isBreak && layoverTimes) {
              NB_ARRIVAL = layoverTimes.arrival != null ? formatEpochToHHMM(layoverTimes.arrival) : NB_ARRIVAL;
              NB_DEPART = layoverTimes.departure != null ? formatEpochToHHMM(layoverTimes.departure) : NB_DEPART;
            }
            return { ...delivery, NB_ARRIVAL, NB_DEPART, NB_ORDER: order };
          });
          return { ...route, deliveries: updatedDeliveries, summary: nbResult };
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
      setData({ ...result, fileName: file.name });
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

  const handleOptimizeAll = async () => {
    if (!data?.routes || data.routes.length === 0) return;
    try {
      const payload = {
        routeData: { routes: data.routes },
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
      (result.routes || []).forEach((r) => byId.set(String(r.routeId), r));

      setData((oldData) => {
        if (!oldData?.routes) return oldData;
        const updatedRoutes = oldData.routes.map((route) => {
          const nbRoute = byId.get(String(route.routeId));
          if (!nbRoute) return route;
          // nbRoute.result is the full NB poll response; maintain compatibility with single-route path
          const { timesByJobId, orderByJobId, steps } = extractNbTimesAndOrder(nbRoute.result || nbRoute);
          const layoverTimes = extractLayoverTimes(steps);
          const updatedDeliveries = route.deliveries.map((delivery) => {
            const jobId = `${delivery.stopNumber}-${route.routeId}`;
            const jobTimes = timesByJobId[jobId];
            const order = orderByJobId[jobId];
            let NB_ARRIVAL = jobTimes?.arrival != null ? formatEpochToHHMM(jobTimes.arrival) : delivery.NB_ARRIVAL;
            let NB_DEPART = jobTimes?.departure != null ? formatEpochToHHMM(jobTimes.departure) : delivery.NB_DEPART;
            if (delivery.isBreak && layoverTimes) {
              NB_ARRIVAL = layoverTimes.arrival != null ? formatEpochToHHMM(layoverTimes.arrival) : NB_ARRIVAL;
              NB_DEPART = layoverTimes.departure != null ? formatEpochToHHMM(layoverTimes.departure) : NB_DEPART;
            }
            return { ...delivery, NB_ARRIVAL, NB_DEPART, NB_ORDER: order };
          });
          return { ...route, deliveries: updatedDeliveries, summary: nbRoute };
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
        }
        if (noSeq) {
          acc.no.distance += noSeq.distance || 0;
          acc.no.duration += noSeq.duration || 0;
          acc.no.service += noSeq.service || 0;
        }
        return acc;
      },
      { seq: { distance: 0, duration: 0, service: 0 }, no: { distance: 0, duration: 0, service: 0 } }
    );
  };

  const totals = data?.routes ? aggregateTotals(data.routes) : null;

  if (!token) {
    return <LoginPage onLogin={handleLogin} />;
  }

  return (
    <Box sx={{ minHeight: '100vh', backgroundColor: 'grey.100' }}>
      <AppBar position="static" color="default" elevation={1}>
        <Container maxWidth="xl">
          <Toolbar>
            <Box sx={{ flexGrow: 1 }}>
              <Typography variant="h4" component="h1" sx={{ fontWeight: 'bold' }}>
                Stop List Dashboard
              </Typography>
              <Typography variant="body2" color="text.secondary">
                Upload and analyze stop list reports
              </Typography>
            </Box>
            {isLocalhost && (
              <Button
                variant="outlined"
                color="error"
                onClick={handleClearCache}
                disabled={clearingCache}
                startIcon={clearingCache ? <CircularProgress size={20} /> : <DeleteIcon />}
                sx={{ mr: 2 }}
              >
                {clearingCache ? 'Clearing...' : 'Clear Cache'}
              </Button>
            )}
            <Button variant="contained" onClick={handleLogout}>
              Logout
            </Button>
          </Toolbar>
        </Container>
      </AppBar>

      {/* Main Content */}
      <Container maxWidth="xl" sx={{ py: 4 }}>
        {cacheMessage && (
          <Alert severity={cacheMessage.type} sx={{ mb: 4 }}>
            {cacheMessage.text}
          </Alert>
        )}

        <Box sx={{ mb: 4 }}>
          <FileUpload onFileUpload={handleFileUpload} loading={loading} />
        </Box>

        <Box sx={{ borderBottom: 1, borderColor: 'divider', mb: 3 }}>
          <Tabs value={activeTab} onChange={(e, newValue) => setActiveTab(newValue)} aria-label="Tabs">
            <Tab label="Planned Routes" value="planned" />
            <Tab label="Full Optimization" value="full" />
          </Tabs>
        </Box>

        {/* Tab Content */}
        {activeTab === 'planned' && (
          <>
            {error && (
              <Alert severity="error" sx={{ mb: 4 }}>
                <Typography variant="h6" component="h3">Error</Typography>
                {error}
              </Alert>
            )}

            {loading && (
              <Card>
                <CardContent sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', p: 4 }}>
                  <CircularProgress />
                  <Typography variant="h6" sx={{ mt: 2 }}>Processing file...</Typography>
                  <Typography variant="body2" color="text.secondary" align="center" sx={{ mt: 1, maxWidth: 'md' }}>
                    Parsing routes and geocoding all delivery addresses. This may take a few minutes for large files.
                  </Typography>
                </CardContent>
              </Card>
            )}

            {data && !loading && (
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                <Card>
                  <CardContent>
                    <Grid container spacing={3} justifyContent="center" textAlign="center">
                      <Grid item xs={12} md={4}>
                        <Typography variant="subtitle1" color="text.secondary">Total Routes</Typography>
                        <Typography variant="h4" sx={{ fontWeight: 'bold' }}>{data.totalRoutes}</Typography>
                      </Grid>
                      <Grid item xs={12} md={4}>
                        <Typography variant="subtitle1" color="text.secondary">Total Deliveries</Typography>
                        <Typography variant="h4" sx={{ fontWeight: 'bold' }}>{data.totalDeliveries}</Typography>
                      </Grid>
                      <Grid item xs={12} md={4}>
                        <Typography variant="subtitle1" color="text.secondary">Avg per Route</Typography>
                        <Typography variant="h4" sx={{ fontWeight: 'bold' }}>
                          {data.totalRoutes > 0
                            ? (data.totalDeliveries / data.totalRoutes).toFixed(1)
                            : 0}
                        </Typography>
                      </Grid>
                    </Grid>

                    {totals && (
                      <Grid container spacing={3} mt={2}>
                        <Grid item xs={12} md={6}>
                          <Card variant="outlined">
                            <CardContent sx={{ textAlign: 'center' }}>
                              <Typography variant="subtitle1" color="text.secondary">Sequenced</Typography>
                              <Typography variant="h5" sx={{ fontWeight: 'bold' }}>{fmtMilesOrDash(totals.seq.distance)}</Typography>
                              <Typography variant="body2" color="text.secondary">Distance</Typography>
                              <Typography variant="h5" sx={{ fontWeight: 'bold', mt: 2 }}>{fmtSecondsOrDash(totals.seq.duration)}</Typography>
                              <Typography variant="body2" color="text.secondary">Drive Time</Typography>
                            </CardContent>
                          </Card>
                        </Grid>
                        <Grid item xs={12} md={6}>
                          <Card variant="outlined">
                            <CardContent sx={{ textAlign: 'center' }}>
                              <Typography variant="subtitle1" color="text.secondary">Optimized</Typography>
                              <Typography variant="h5" sx={{ fontWeight: 'bold' }}>{fmtMilesOrDash(totals.no.distance)}</Typography>
                              <Typography variant="body2" color="text.secondary">Distance</Typography>
                              <Typography variant="h5" sx={{ fontWeight: 'bold', mt: 2 }}>{fmtSecondsOrDash(totals.no.duration)}</Typography>
                              <Typography variant="body2" color="text.secondary">Drive Time</Typography>
                            </CardContent>
                          </Card>
                        </Grid>
                      </Grid>
                    )}

                    <Box sx={{ mt: 3, display: 'flex', justifyContent: 'flex-end' }}>
                      <Button
                        variant="contained"
                        startIcon={<DownloadIcon />}
                        onClick={handleExportCSV}
                      >
                        Export to CSV
                      </Button>
                    </Box>
                  </CardContent>
                </Card>

                <DataTable
                  routes={data.routes}
                  fileName={data.fileName}
                  handleOptimizeRoute={handleOptimizeRoute}
                  handleOptimizeAll={handleOptimizeAll}
                  optimizingRouteIds={optimizingRouteIds}
                />
              </Box>
            )}
          </>
        )}

        {activeTab === 'full' && (
          <>
            <Box sx={{ mb: 2, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <Typography variant="body2" color="text.secondary">
                {fullOptRequestId ? (
                  <>Request ID: <Typography component="span" variant="body2" fontFamily="monospace">{fullOptRequestId}</Typography></>
                ) : (
                  "No request submitted"
                )}
              </Typography>
              <Button
                variant="contained"
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
                      const endEpoch = startEpoch + 12 * 3600;
                      const cap = deriveVehicleCapacity(route.equipmentType || '');
                      vehicles.push({
                        id: routeId,
                        description: `${routeId}-${route.driverName || ''}`,
                        time_window: [startEpoch, endEpoch],
                        start_index: startIdx,
                        end_index: startIdx,
                        layover_config: { max_continuous_time: 18000, layover_duration: 1800, include_service_time: true },
                        capacity: [
                          Number.isFinite(cap.weight) ? cap.weight * 10 : 0,
                          Number.isFinite(cap.pallets) ? cap.pallets : 0
                        ]
                      });
                    });

                    const jobs = [];
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
                        const adjWeight = Number.isFinite(weightNum) ? Math.round(weightNum * 10) : 0;
                        const serviceSeconds = serviceToSeconds(d.service);
                        const baseJob = {
                          id: `${d.locationId || ''}-${route.routeId || rIndex}-${dIndex}`,
                          location_index: locIdx,
                          service: serviceSeconds,
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
                      options: { routing: { mode: 'truck', traffic_timestamp: 1760648400, disable_cache: true}, objective: { travel_cost: 'duration' } },
                      description: 'Full Optimization (selected vehicles and deliveries)'
                    };
                    console.log('Full Optimization request body:', JSON.stringify(requestBody, null, 2));
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
                    const { requestId } = await resp.json();
                    setFullOptRequestId(requestId || null);
                  } catch (e) {
                    console.error('Error building Full Optimization request:', e);
                  } finally {
                    setFullOptRunning(false);
                  }
                }}
              >
                {fullOptRunning ? <CircularProgress size={24} color="inherit" /> : 'Optimize'}
              </Button>
            </Box>

            {(() => {
              const routes = data?.routes || [];
              const depot = depotFromFileName(data?.fileName);
              const computeStartLocation = (route) => {
                if (depot) return depot;
                const first = (route.deliveries || []).find((d) => d?.geocode?.success && d?.geocode?.latitude && d?.geocode?.longitude);
                if (first) return formatLatLngString(`${first.geocode.latitude},${first.geocode.longitude}`);
                return '';
              };
              const vehicles = routes.map((route, idx) => {
                const startLoc = computeStartLocation(route);
                const endLoc = startLoc;
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
                  if (d?.isBreak) return;
                  const palletsRaw = d.cube || d.pallets || '';
                  const palletsNum = toNumber(palletsRaw);
                  const weightRaw = d.weight || '';
                  const weightNum = toNumber(weightRaw);
                  deliveries.push({
                    key: `${route.routeId ?? rIndex}::${dIndex}`,
                    step: d.stopNumber || '',
                    isDepotResupply: !!d.isDepotResupply,
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
                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <Card>
                    <CardContent>
                      <Typography variant="h6" component="h2" sx={{ mb: 2 }}>Vehicle Inventory</Typography>
                      <TableContainer component={Paper} sx={{ maxHeight: 440 }}>
                        <Table stickyHeader size="small">
                          <TableHead>
                            <TableRow>
                              <TableCell padding="checkbox">
                                <Checkbox
                                  indeterminate={!allVehiclesSelected && vehicles.some(v => selectedVehicleIds.has(v.id))}
                                  checked={allVehiclesSelected}
                                  onChange={toggleAllVehicles}
                                />
                              </TableCell>
                              <TableCell>Equipment Type ID</TableCell>
                              <TableCell>Driver ID</TableCell>
                              <TableCell>Driver Name</TableCell>
                              <TableCell>Start Time</TableCell>
                              <TableCell>End Time</TableCell>
                              <TableCell>Capacity Weight</TableCell>
                              <TableCell>Capacity Pallets</TableCell>
                              <TableCell>Start Location</TableCell>
                              <TableCell>End Location</TableCell>
                            </TableRow>
                          </TableHead>
                          <TableBody>
                            {vehicles.map((v) => (
                              <TableRow key={v.id} hover>
                                <TableCell padding="checkbox">
                                  <Checkbox
                                    checked={selectedVehicleIds.has(v.id)}
                                    onChange={() => toggleVehicle(v.id)}
                                  />
                                </TableCell>
                                <TableCell>{v.equipmentTypeId || '—'}</TableCell>
                                <TableCell>{v.driverId || '—'}</TableCell>
                                <TableCell>{v.driverName || '—'}</TableCell>
                                <TableCell>{v.startTime || '—'}</TableCell>
                                <TableCell>{v.endTime || '—'}</TableCell>
                                <TableCell>{v.capacityWeight || '—'}</TableCell>
                                <TableCell>{v.capacityPallets || '—'}</TableCell>
                                <TableCell><Typography variant="caption" fontFamily="monospace">{v.startLocation || '—'}</Typography></TableCell>
                                <TableCell><Typography variant="caption" fontFamily="monospace">{v.endLocation || '—'}</Typography></TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </TableContainer>
                    </CardContent>
                  </Card>

                  <Card>
                    <CardContent>
                      <Typography variant="h6" component="h2" sx={{ mb: 2 }}>Delivery List</Typography>
                      <TableContainer component={Paper} sx={{ maxHeight: 440 }}>
                        <Table stickyHeader size="small">
                          <TableHead>
                            <TableRow>
                              <TableCell padding="checkbox">
                                <Checkbox
                                  indeterminate={!allDeliveriesSelected && deliveries.some(d => selectedDeliveryKeys.has(d.key))}
                                  checked={allDeliveriesSelected}
                                  onChange={toggleAllDeliveries}
                                />
                              </TableCell>
                              <TableCell>Step #</TableCell>
                              <TableCell>Location ID</TableCell>
                              <TableCell>Location Name</TableCell>
                              <TableCell>Address</TableCell>
                              <TableCell>Service Windows</TableCell>
                              <TableCell>Service</TableCell>
                              <TableCell>Weight</TableCell>
                              <TableCell>Adj. Weight</TableCell>
                              <TableCell>Pallets</TableCell>
                              <TableCell>Adj. Pallets</TableCell>
                            </TableRow>
                          </TableHead>
                          <TableBody>
                            {deliveries.map((d) => (
                              <TableRow key={d.key} hover>
                                <TableCell padding="checkbox">
                                  <Checkbox
                                    checked={selectedDeliveryKeys.has(d.key)}
                                    onChange={() => toggleDelivery(d.key)}
                                  />
                                </TableCell>
                                <TableCell>{d.isDepotResupply ? 'Depot' : (d.step || '—')}</TableCell>
                                <TableCell>{d.locationId || '—'}</TableCell>
                                <TableCell>{d.locationName || '—'}</TableCell>
                                <TableCell>{d.address || '—'}</TableCell>
                                <TableCell>{d.serviceWindows || '—'}</TableCell>
                                <TableCell>{d.service || '—'}</TableCell>
                                <TableCell>{d.weight || '—'}</TableCell>
                                <TableCell>{d.adjWeight || '—'}</TableCell>
                                <TableCell>{d.pallets || '—'}</TableCell>
                                <TableCell>{d.adjPallets || '—'}</TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </TableContainer>
                    </CardContent>
                  </Card>
                </Box>
              );
            })()}
          </>
        )}
      </main>
    </Box>
  );
}

export default App;
