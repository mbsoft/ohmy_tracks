import React from 'react';

function formatTimestamp(isoString) {
  if (!isoString) return 'Unknown date';
  try {
    const date = new Date(isoString);
    return date.toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch (e) {
    console.error('Error formatting timestamp:', e);
    return 'Invalid date';
  }
}

function SavedReports({ reports, onSelect, onDelete, onRefresh }) {
  if (!reports || reports.length === 0) {
    return (
      <div className="text-center py-8">
        <p className="text-gray-500">No saved reports found.</p>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-lg shadow h-96 flex flex-col">
      <div className="px-6 py-4 border-b border-gray-200 flex justify-between items-center">
        <h2 className="text-lg font-semibold text-gray-900">Saved Reports</h2>
        <button
          onClick={onRefresh}
          className="text-sm font-medium text-blue-600 hover:text-blue-800"
        >
          Refresh
        </button>
      </div>
      <div className="flex-1 overflow-y-auto">
        <ul className="divide-y divide-gray-200">
          {reports.map((report) => (
            <li key={report.id} className="px-6 py-4 flex items-center justify-between hover:bg-gray-50">
              <div>
                <p className="font-medium text-gray-800">{report.fileName}</p>
                <p className="text-sm text-gray-500">
                  Uploaded: {formatTimestamp(report.createdAt)}
                </p>
              </div>
              <div className="flex items-center space-x-4">
                <button
                  onClick={() => onSelect(report.id)}
                  className="px-3 py-1 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700"
                >
                  Load
                </button>
                <button
                  onClick={() => onDelete(report.id)}
                  className="px-3 py-1 text-sm font-medium text-red-600 border border-red-300 rounded-md hover:bg-red-50"
                >
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export default SavedReports;
