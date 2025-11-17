import React, { useState } from 'react';
import {
  useReactTable,
  getCoreRowModel,
  getExpandedRowModel,
  flexRender,
} from '@tanstack/react-table';

function formatDuration(totalSeconds) {
  if (typeof totalSeconds !== 'number' || !Number.isFinite(totalSeconds)) return '-';
  // Normalize by rounding to minutes first to avoid "1h 60m"
  const totalMinutes = Math.round(totalSeconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function formatDistance(meters) {
  if (typeof meters !== 'number' || !Number.isFinite(meters)) return '-';
  const miles = meters / 1609.344;
  return `${miles.toFixed(1)} mi`;
}

function toFixed6(num) {
  const n = Number(num);
  if (!Number.isFinite(n)) return '';
  return n.toFixed(6);
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

function depotFromFileName(fileName) {
  if (!fileName) return '';
  if (fileName.startsWith('ATL')) return formatLatLngString('33.807970,-84.436960');
  if (fileName.startsWith('NB Mays')) return formatLatLngString('39.442140,-74.703320');
  return '';
}

function DataTable({ routes, handleOptimizeRoute, handleOptimizeAll, optimizingRouteIds, fileName }) {
  const [expandedRoutes, setExpandedRoutes] = useState({});
  const [routeStartLocations, setRouteStartLocations] = useState({});
  const [optimizingAll, setOptimizingAll] = useState(false);

  const toggleRoute = (routeId) => {
    setExpandedRoutes((prev) => ({
      ...prev,
      [routeId]: !prev[routeId],
    }));
  };

  const getDefaultStartLocation = (route) => {
    // Prefer depot inferred from fileName
    const depot = depotFromFileName(fileName);
    if (depot) return depot;
    // Fallback to first geocoded stop
    if (route.deliveries && route.deliveries.length > 0) {
      const firstStop = route.deliveries[0];
      if (firstStop.geocode?.success && firstStop.geocode.latitude && firstStop.geocode.longitude) {
        return formatLatLngString(`${firstStop.geocode.latitude},${firstStop.geocode.longitude}`);
      }
    }
    return '';
  };

  const getStartLocation = (routeIndex) => {
    if (routeStartLocations[routeIndex] !== undefined) {
      return routeStartLocations[routeIndex];
    }
    return getDefaultStartLocation(routes[routeIndex]);
  };

  const handleStartLocationChange = (routeIndex, value) => {
    setRouteStartLocations((prev) => ({
      ...prev,
      [routeIndex]: value,
    }));
  };

  const handleStartLocationBlur = (routeIndex) => {
    setRouteStartLocations((prev) => ({
      ...prev,
      [routeIndex]: formatLatLngString(prev[routeIndex])
    }));
  };

  const optimizeAll = async () => {
    try {
      setOptimizingAll(true);
      if (typeof handleOptimizeAll === 'function') {
        await handleOptimizeAll();
      } else {
        // Fallback: run concurrent on client (may exceed server-side limits)
        await Promise.all(
          routes.map((r, i) => {
            const startLocation = getStartLocation(i);
            return handleOptimizeRoute(r.routeId, startLocation);
          })
        );
      }
    } finally {
      setOptimizingAll(false);
    }
  };

  return (
    <div className="bg-white rounded-lg shadow overflow-hidden">
      <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-gray-900">Routes & Deliveries</h2>
        <button
          className="inline-flex items-center bg-blue-600 hover:bg-blue-700 text-white font-semibold text-sm py-2 px-4 rounded disabled:opacity-50 disabled:cursor-not-allowed"
          onClick={optimizeAll}
          disabled={optimizingAll}
          title="Run optimization for all routes"
        >
          {optimizingAll ? (
            <>
              <svg className="animate-spin -ml-1 mr-2 h-4 w-4 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
              Optimizing All...
            </>
          ) : (
            'Optimize All'
          )}
        </button>
      </div>

      <div className="overflow-x-auto">
        {routes.map((route, routeIndex) => (
          <div key={routeIndex} className="border-b border-gray-200 last:border-b-0">
            {/* Route Header */}
            <div className="bg-gray-50 px-6 py-4">
              <div className="flex items-start justify-between">
                <div className="flex items-start space-x-4 flex-1">
                  <button 
                    className="text-gray-500 focus:outline-none mt-1 cursor-pointer hover:text-gray-700 transition-colors"
                    onClick={() => toggleRoute(routeIndex)}
                  >
                    <svg
                      className={`h-5 w-5 transform transition-transform ${
                        expandedRoutes[routeIndex] ? 'rotate-90' : ''
                      }`}
                      fill="currentColor"
                      viewBox="0 0 20 20"
                    >
                      <path
                        fillRule="evenodd"
                        d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z"
                        clipRule="evenodd"
                      />
                    </svg>
                  </button>
                  <div className="flex-1">
                    <h3 className="text-base font-semibold text-gray-900">
                      Route: {route.routeId || 'N/A'}
                    </h3>
                    <p className="text-sm text-gray-600">
                      Driver: {route.driverName || 'N/A'} | Stops: {route.deliveries.length}
                    </p>
                    {route.equipmentType && (
                      <p className="text-sm text-gray-600">Equipment: {route.equipmentType}</p>
                    )}
                    <div className="mt-2">
                      <label className="block text-xs font-medium text-gray-700 mb-1">Start/End Location:</label>
                      <input
                        type="text"
                        value={getStartLocation(routeIndex)}
                        onChange={(e) => {
                          e.stopPropagation();
                          handleStartLocationChange(routeIndex, e.target.value);
                        }}
                        onBlur={() => handleStartLocationBlur(routeIndex)}
                        onClick={(e) => e.stopPropagation()}
                        className="w-40 md:w-48 px-2 py-1 text-xs font-mono border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                        placeholder="lat,lng"
                        inputMode="decimal"
                      />
                    </div>
                  </div>
                  {/* Summary table - centered and larger font */}
                  {true && (
                    <div className="flex-1 flex justify-center">
                      <table className="min-w-[900px] text-sm md:text-base text-gray-800 border border-gray-200 rounded shadow-sm">
                        <thead>
                          <tr className="bg-gray-100">
                            <th className="px-3 md:px-4 py-2 text-left">Type</th>
                            <th className="px-3 md:px-4 py-2 text-left">Request</th>
                            <th className="px-3 md:px-4 py-2 text-left">Distance</th>
                            <th className="px-3 md:px-4 py-2 text-left whitespace-nowrap">Drive</th>
                            <th className="px-3 md:px-4 py-2 text-left whitespace-nowrap">Total</th>
                            <th className="px-3 md:px-4 py-2 text-left">Unassigned</th>
                          </tr>
                        </thead>
                        <tbody>
                          {(() => {
                            const inSeq = route.summary?.summaries?.inSequence;
                            const noSeq = route.summary?.summaries?.noSequence || route.summary?.result?.summary;
                            const inSeqUnassigned = route.summary?.unassignedCounts?.inSequence ?? (Array.isArray(route.summary?.resultInSeq?.result?.unassigned) ? route.summary.resultInSeq.result.unassigned.length : 0);
                            const noSeqUnassigned = route.summary?.unassignedCounts?.noSequence ?? (Array.isArray(route.summary?.result?.result?.unassigned) ? route.summary.result.result.unassigned.length : 0);
                            const inSeqDistance = formatDistance(inSeq?.distance);
                            const inSeqDrive = formatDuration(inSeq?.duration);
                            const inSeqTotal = (typeof inSeq?.duration === 'number' && typeof inSeq?.service === 'number') ? formatDuration(inSeq.duration + inSeq.service) : '-';
                            const noSeqDistance = formatDistance(noSeq?.distance);
                            const noSeqDrive = formatDuration(noSeq?.duration);
                            const noSeqTotal = (typeof noSeq?.duration === 'number' && typeof noSeq?.service === 'number') ? formatDuration(noSeq.duration + noSeq.service) : '-';
                            return (
                              <>
                                <tr className="bg-blue-50 hover:bg-blue-100 transition-colors">
                                  <td className="px-3 md:px-4 py-2 font-medium">sequenced</td>
                                  <td className="px-3 md:px-4 py-2">{route.summary?.requestIds?.inSequence || '—'}</td>
                                  <td className="px-3 md:px-4 py-2">{inSeqDistance}</td>
                                  <td className="px-3 md:px-4 py-2 whitespace-nowrap">{inSeqDrive}</td>
                                  <td className="px-3 md:px-4 py-2 whitespace-nowrap">{inSeqTotal}</td>
                                  <td className="px-3 md:px-4 py-2">{inSeqUnassigned}</td>
                                </tr>
                                <tr className="bg-green-50 hover:bg-green-100 transition-colors">
                                  <td className="px-3 md:px-4 py-2 font-medium">optimized</td>
                                  <td className="px-3 md:px-4 py-2">{route.summary?.requestIds?.noSequence || route.summary?.requestId || '—'}</td>
                                  <td className="px-3 md:px-4 py-2">{noSeqDistance}</td>
                                  <td className="px-3 md:px-4 py-2 whitespace-nowrap">{noSeqDrive}</td>
                                  <td className="px-3 md:px-4 py-2 whitespace-nowrap">{noSeqTotal}</td>
                                  <td className="px-3 md:px-4 py-2">{noSeqUnassigned}</td>
                                </tr>
                              </>
                            );
                          })()}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </div>

              {/* Route Start/End Times */}
              <div className="px-6 pb-2">
                <div className="text-sm text-gray-600">
                  <span className="mr-6">Start: {routes[routeIndex].routeStartTime || 'N/A'}</span>
                  <span>End: {routes[routeIndex].routeEndTime || 'N/A'}</span>
                </div>
              </div>

              {/* Deliveries Table */}
              {expandedRoutes[routeIndex] && (
                <div className="overflow-x-auto bg-blue-50 rounded-lg p-3">
                  <table className="min-w-full divide-y divide-blue-200 text-base">
                    <thead className="bg-blue-100">
                      <tr>
                        <th className="px-5 py-3 text-left text-sm font-medium text-blue-900 uppercase tracking-wider">Stop #</th>
                        <th className="px-5 py-3 text-left text-sm font-medium text-blue-900 uppercase tracking-wider">Location ID</th>
                        <th className="px-5 py-3 text-left text-sm font-medium text-blue-900 uppercase tracking-wider">Location Name</th>
                        <th className="px-5 py-3 text-left text-sm font-medium text-blue-900 uppercase tracking-wider">Address</th>
                        <th className="px-5 py-3 text-left text-sm font-medium text-blue-900 uppercase tracking-wider">Arrival</th>
                        <th className="px-5 py-3 text-left text-sm font-medium text-blue-900 uppercase tracking-wider">Depart</th>
                        <th className="px-5 py-3 text-left text-sm font-medium text-blue-900 uppercase tracking-wider">NB_Arrival</th>
                        <th className="px-5 py-3 text-left text-sm font-medium text-blue-900 uppercase tracking-wider">NB_Depart</th>
                        <th className="px-5 py-3 text-left text-sm font-medium text-blue-900 uppercase tracking-wider">Time Window</th>
                        <th className="px-5 py-3 text-left text-sm font-medium text-blue-900 uppercase tracking-wider">Service</th>
                        <th className="px-5 py-3 text-left text-sm font-medium text-blue-900 uppercase tracking-wider">Weight</th>
                        <th className="px-5 py-3 text-left text-sm font-medium text-blue-900 uppercase tracking-wider">Pallets</th>
                        <th className="px-5 py-3 text-left text-sm font-medium text-blue-900 uppercase tracking-wider">Phone</th>
                      </tr>
                    </thead>
                    <tbody className="bg-blue-50 divide-y divide-blue-200">
                      {routes[routeIndex].deliveries.map((delivery, deliveryIndex) => (
                        <tr key={deliveryIndex} className="hover:bg-blue-100 transition-colors">
                          <td className="px-5 py-3 whitespace-nowrap text-blue-900">
                            {delivery.isDepotResupply ? 'Depot' : (delivery.stopNumber || '-')}
                            {!delivery.isDepotResupply && delivery.NB_ORDER ? `(${delivery.NB_ORDER})` : ''}
                          </td>
                          <td className="px-5 py-3 whitespace-nowrap text-blue-900">{delivery.locationId || '-'}</td>
                          <td className="px-5 py-3 text-blue-900">{delivery.locationName || '-'}</td>
                          <td className="px-5 py-3 text-blue-900">{delivery.address || '-'}</td>
                          <td className="px-5 py-3 whitespace-nowrap text-blue-900">{delivery.arrival || '-'}</td>
                          <td className="px-5 py-3 whitespace-nowrap text-blue-900">{delivery.depart || '-'}</td>
                          <td className="px-5 py-3 whitespace-nowrap text-blue-900">{delivery.NB_ARRIVAL || '-'}</td>
                          <td className="px-5 py-3 whitespace-nowrap text-blue-900">{delivery.NB_DEPART || '-'}</td>
                          <td className="px-5 py-3 whitespace-nowrap text-blue-900">{delivery.openCloseTime || '-'}</td>
                          <td className="px-5 py-3 whitespace-nowrap text-blue-900">{delivery.service || '-'}</td>
                          <td className="px-5 py-3 whitespace-nowrap text-blue-900">{delivery.weight || '-'}</td>
                          <td className="px-5 py-3 whitespace-nowrap text-blue-900">{delivery.cube || '-'}</td>
                          <td className="px-5 py-3 whitespace-nowrap text-blue-900">{delivery.phoneNumber || '-'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default DataTable;

