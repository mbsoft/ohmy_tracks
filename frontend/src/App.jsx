import React, { useState } from 'react'; // Removed useEffect since WebSocket is not needed
import FileUpload from './components/FileUpload';
import DataTable from './components/DataTable';
import { exportToCSV } from './utils/csvExport';

function formatEpochToHHMM(epochSeconds) {
  if (epochSeconds == null) return '';
  const d = new Date(epochSeconds * 1000);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
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
      // Only increment order for job steps (skip start/end/layover if they don't have job id)
      order += 1;
      orderByJobId[jobId] = order;
    }
    const arrival = s.arrival ?? s.start_time ?? s.time ?? s.start;
    const departure = s.departure ?? s.end_time ?? (arrival != null ? arrival + (s.service || 0) + (s.setup || 0) + (s.waiting_time || 0) : undefined);
    if (jobId) timesByJobId[jobId] = { arrival, departure };
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
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [clearingCache, setClearingCache] = useState(false);
  const [cacheMessage, setCacheMessage] = useState(null);
  const [optimizingRouteIds, setOptimizingRouteIds] = useState(new Set());

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

  return (
    <div className="min-h-screen bg-gray-100">
      {/* Header */}
      <header className="bg-white shadow-sm">
        <div className="max-w-7xl mx-auto px-4 py-6 sm:px-6 lg:px-8">
          <div className="flex justify-between items-start">
            <div>
              <h1 className="text-3xl font-bold text-gray-900">
                Stop List Dashboard
              </h1>
              <p className="mt-1 text-sm text-gray-600">
                Upload and analyze stop list reports
              </p>
            </div>
            <button
              onClick={handleClearCache}
              disabled={clearingCache}
              className="inline-flex items-center px-4 py-2 border border-red-300 text-sm font-medium rounded-md text-red-700 bg-white hover:bg-red-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500 disabled:opacity-50 disabled:cursor-not-allowed"
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
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-7xl mx-auto px-4 py-8 sm:px-6 lg:px-8">
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
                    <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
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

        {/* File Upload Section */}
        <div className="mb-8">
          <FileUpload onFileUpload={handleFileUpload} loading={loading} />
        </div>

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
                    d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z"
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
              <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-5 gap-6">
                <div className="text-center">
                  <p className="text-sm font-medium text-gray-600">Total Routes</p>
                  <p className="mt-2 text-3xl font-bold text-gray-900">
                    {data.totalRoutes}
                  </p>
                </div>
                <div className="text-center">
                  <p className="text-sm font-medium text-gray-600">Total Deliveries</p>
                  <p className="mt-2 text-3xl font-bold text-gray-900">
                    {data.totalDeliveries}
                  </p>
                </div>
                <div className="text-center">
                  <p className="text-sm font-medium text-gray-600">Avg per Route</p>
                  <p className="mt-2 text-3xl font-bold text-gray-900">
                    {data.totalRoutes > 0
                      ? (data.totalDeliveries / data.totalRoutes).toFixed(1)
                      : 0}
                  </p>
                </div>
                {data.geocodingStats && (
                  <>
                    <div className="text-center">
                      <p className="text-sm font-medium text-gray-600">Geocoded</p>
                      <p className="mt-2 text-3xl font-bold text-green-600">
                        {data.geocodingStats.succeeded}
                      </p>
                      <p className="text-xs text-gray-500 mt-1">
                        {data.geocodingStats.failed} failed
                      </p>
                    </div>
                    <div className="text-center">
                      <p className="text-sm font-medium text-gray-600">Cache Hit Rate</p>
                      <p className="mt-2 text-3xl font-bold text-blue-600">
                        {data.geocodingStats.total > 0
                          ? Math.round((data.geocodingStats.cacheHits / data.geocodingStats.total) * 100)
                          : 0}%
                      </p>
                      <p className="text-xs text-gray-500 mt-1">
                        {data.geocodingStats.cacheSize} in cache
                      </p>
                    </div>
                  </>
                )}
              </div>
              
              {/* Geocoding Pass Breakdown */}
              {data.geocodingStats && data.geocodingStats.pass1 && data.geocodingStats.pass2 && (
                <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="bg-blue-50 rounded-lg p-4">
                    <h3 className="text-sm font-semibold text-blue-900 mb-2">Pass 1: Address-based</h3>
                    <div className="flex justify-between text-sm">
                      <span className="text-blue-700">Processed:</span>
                      <span className="font-medium text-blue-900">{data.geocodingStats.pass1.processed}</span>
                    </div>
                    <div className="flex justify-between text-sm mt-1">
                      <span className="text-blue-700">Succeeded:</span>
                      <span className="font-medium text-green-700">{data.geocodingStats.pass1.succeeded}</span>
                    </div>
                  </div>
                  <div className="bg-purple-50 rounded-lg p-4">
                    <h3 className="text-sm font-semibold text-purple-900 mb-2">Pass 2: Location Name (Proximity)</h3>
                    <div className="flex justify-between text-sm">
                      <span className="text-purple-700">Processed:</span>
                      <span className="font-medium text-purple-900">{data.geocodingStats.pass2.processed}</span>
                    </div>
                    <div className="flex justify-between text-sm mt-1">
                      <span className="text-purple-700">Succeeded:</span>
                      <span className="font-medium text-green-700">{data.geocodingStats.pass2.succeeded}</span>
                    </div>
                    <div className="flex justify-between text-sm mt-1">
                      <span className="text-purple-700">Failed:</span>
                      <span className="font-medium text-red-700">{data.geocodingStats.pass2.failed}</span>
                    </div>
                  </div>
                </div>
              )}
              <div className="mt-6 flex justify-end">
                <button
                  onClick={handleExportCSV}
                  className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
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
              optimizingRouteIds={optimizingRouteIds}
            />
          </div>
        )}
      </main>
    </div>
  );
}

export default App;

