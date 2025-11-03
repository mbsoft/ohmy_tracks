/**
 * Export routes data to CSV format
 */
export function exportToCSV(routes) {
  // Define CSV headers
  const headers = [
    'Route ID',
    'Driver Name',
    'Route Start Time',
    'Route End Time',
    'Stop #',
    'Location ID',
    'Location Name',
    'Arrival',
    'Depart',
    'Service',
    'Weight',
    'Cube',
    'Gross',
    'Address',
    'Phone Number',
    'Open/Close Time',
    'Service Windows',
    'Standard Instructions',
    'Special Instructions'
  ];

  // Build CSV rows
  const rows = [headers];

  routes.forEach((route) => {
    route.deliveries.forEach((delivery) => {
      const row = [
        route.routeId || '',
        route.driverName || '',
        route.routeStartTime || '',
        route.routeEndTime || '',
        delivery.stopNumber || '',
        delivery.locationId || '',
        delivery.locationName || '',
        delivery.arrival || '',
        delivery.depart || '',
        delivery.service || '',
        delivery.weight || '',
        delivery.cube || '',
        delivery.gross || '',
        delivery.address || '',
        delivery.phoneNumber || '',
        delivery.openCloseTime || '',
        delivery.serviceWindows || '',
        delivery.standardInstructions || '',
        delivery.specialInstructions || ''
      ];
      rows.push(row);
    });
  });

  // Convert to CSV string
  const csvContent = rows
    .map((row) =>
      row
        .map((cell) => {
          // Escape quotes and wrap in quotes if needed
          const cellStr = String(cell);
          if (cellStr.includes(',') || cellStr.includes('"') || cellStr.includes('\n')) {
            return `"${cellStr.replace(/"/g, '""')}"`;
          }
          return cellStr;
        })
        .join(',')
    )
    .join('\n');

  // Create download
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  const url = URL.createObjectURL(blob);

  link.setAttribute('href', url);
  link.setAttribute('download', `omnitracs-routes-${Date.now()}.csv`);
  link.style.visibility = 'hidden';

  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}


