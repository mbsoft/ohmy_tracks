import React, { useState } from 'react';
import {
  useReactTable,
  getCoreRowModel,
  getExpandedRowModel,
  flexRender,
} from '@tanstack/react-table';

function formatDuration(totalSeconds) {
  if (typeof totalSeconds !== 'number') return totalSeconds;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.round((totalSeconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function formatDistance(meters) {
  if (typeof meters !== 'number') return meters;
  const miles = meters / 1609.344;
  return `${miles.toFixed(1)} mi`;
}

function DataTable({ routes, handleOptimizeRoute, optimizingRouteIds }) {
  const [expandedRoutes, setExpandedRoutes] = useState({});
  const [routeStartLocations, setRouteStartLocations] = useState({});

  const toggleRoute = (routeId) => {
    setExpandedRoutes((prev) => ({
      ...prev,
      [routeId]: !prev[routeId],
    }));
  };

  const getDefaultStartLocation = (route) => {
    if (route.deliveries && route.deliveries.length > 0) {
      const firstStop = route.deliveries[0];
      if (firstStop.geocode?.success && firstStop.geocode.latitude && firstStop.geocode.longitude) {
        return `${firstStop.geocode.latitude},${firstStop.geocode.longitude}`;
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

  return (
    <div className="bg-white rounded-lg shadow overflow-hidden">
      <div className="px-6 py-4 border-b border-gray-200">
        <h2 className="text-lg font-semibold text-gray-900">Routes & Deliveries</h2>
      </div>

      <div className="overflow-x-auto">
        {routes.map((route, routeIndex) => (
          <div key={routeIndex} className="border-b border-gray-200 last:border-b-0">
            {/* Route Header */}
            <div
              className="bg-gray-50 px-6 py-4 cursor-pointer hover:bg-gray-100 transition-colors"
              onClick={() => toggleRoute(routeIndex)}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center space-x-4">
                  <button className="text-gray-500 focus:outline-none">
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
                      Driver: {route.driverName || 'N/A'} | Stops:{' '}
                      {route.deliveries.length}
                    </p>
                    {route.equipmentType && (
                      <p className="text-sm text-gray-600">
                        Equipment: {route.equipmentType}
                      </p>
                    )}
                    <div className="mt-2">
                      <label className="block text-xs font-medium text-gray-700 mb-1">
                        Start/End Location:
                      </label>
                      <input
                        type="text"
                        value={getStartLocation(routeIndex)}
                        onChange={(e) => {
                          e.stopPropagation();
                          handleStartLocationChange(routeIndex, e.target.value);
                        }}
                        onClick={(e) => e.stopPropagation()}
                        className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                        placeholder="latitude,longitude"
                      />
                    </div>
                  </div>
                  <button 
                    className={`inline-flex items-center bg-blue-500 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded disabled:opacity-50 disabled:cursor-not-allowed`} 
                    disabled={optimizingRouteIds?.has?.(route.routeId)}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (!optimizingRouteIds?.has?.(route.routeId)) {
                        const startLocation = getStartLocation(routeIndex);
                        handleOptimizeRoute(route.routeId, startLocation);
                      }
                    }}
                  >
                    {optimizingRouteIds?.has?.(route.routeId) ? (
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
                  {route.summary?.result?.summary && (
                    <div className="flex items-center space-x-2">
                      <span className="inline-flex items-center px-2 py-1 rounded text-xs font-medium bg-green-100 text-green-800">
                        Distance: {formatDistance(route.summary.result.summary.distance)}
                      </span>
                      <span className="inline-flex items-center px-2 py-1 rounded text-xs font-medium bg-blue-100 text-blue-800">
                        Drive Time: {formatDuration(route.summary.result.summary.duration)}
                      </span>
                      <span className="inline-flex items-center px-2 py-1 rounded text-xs font-medium bg-purple-100 text-purple-800">
                        Total Time: {formatDuration((route.summary.result.summary.duration || 0) + (route.summary.result.summary.service || 0))}
                      </span>
                    </div>
                  )}
                </div>
                <div className="text-right text-sm text-gray-600">
                  <div>Start: {route.routeStartTime || 'N/A'}</div>
                  <div>End: {route.routeEndTime || 'N/A'}</div>
                </div>
              </div>
            </div>

            {/* Deliveries Table */}
            {expandedRoutes[routeIndex] && (
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-gray-200">
                  <thead className="bg-gray-100">
                    <tr>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-700 uppercase tracking-wider">
                        Stop #
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-700 uppercase tracking-wider">
                        Location ID
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-700 uppercase tracking-wider">
                        Location Name
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-700 uppercase tracking-wider">
                        Address
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-700 uppercase tracking-wider">
                        Location
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-700 uppercase tracking-wider">
                        Arrival
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-700 uppercase tracking-wider">
                        Depart
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-700 uppercase tracking-wider">
                        Time Window
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-700 uppercase tracking-wider">
                        Service
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-700 uppercase tracking-wider">
                        Weight
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-700 uppercase tracking-wider">
                        Pallets
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-700 uppercase tracking-wider">
                        Phone
                      </th>
                    </tr>
                  </thead>
                  <tbody className="bg-white divide-y divide-gray-200">
                    {route.deliveries.map((delivery, deliveryIndex) => (
                      <tr
                        key={deliveryIndex}
                        className="hover:bg-gray-50 transition-colors"
                      >
                        <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-900">
                          {delivery.stopNumber || '-'}
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-900">
                          {delivery.locationId || '-'}
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-900">
                          {delivery.locationName || '-'}
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-900">
                          {delivery.address || '-'}
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap text-sm">
                          {delivery.geocode?.success ? (
                            <span className="text-gray-900">
                              {parseFloat(delivery.geocode.latitude).toFixed(4)}, {parseFloat(delivery.geocode.longitude).toFixed(4)}
                              {delivery.geocode.fromCache && (
                                <span className="ml-1 inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-green-100 text-green-800">
                                  cached
                                </span>
                              )}
                              {delivery.geocode.geocodedWith === 'locationName' && (
                                <span className="ml-1 inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-blue-100 text-blue-800">
                                  by name
                                </span>
                              )}
                              {delivery.geocode.proximityHint && (
                                <span className="ml-1 inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-purple-100 text-purple-800" title={`Used proximity from ${delivery.geocode.proximityHint.direction} stop (${delivery.geocode.proximityHint.distance} away)`}>
                                  📍 proximity
                                </span>
                              )}
                            </span>
                          ) : (
                            <span className="text-gray-400">
                              {delivery.geocode ? '✗ Failed' : '-'}
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-900">
                          {delivery.arrival || '-'}
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-900">
                          {delivery.depart || '-'}
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-900">
                          {delivery.openCloseTime || '-'}
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-900">
                          {delivery.service || '-'}
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-900">
                          {delivery.weight || '-'}
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-900">
                          {delivery.cube || '-'}
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-900">
                          {delivery.phoneNumber || '-'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export default DataTable;

